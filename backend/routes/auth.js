import express from 'express'
import rateLimit from 'express-rate-limit'
import axios from 'axios'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query } from '../src/db.js'
import logger from '../lib/logger.js'
import { triggerScrape } from '../src/services/scraperService.js'

const router = express.Router()

const JWT_SECRET = process.env.JWT_SECRET
const SCRAPER_URL = process.env.SCRAPER_URL
const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 5000)

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts; try again in a minute.'
})

function signJwt(payload) {
  if (!JWT_SECRET) throw new Error('server_misconfigured')
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { student_id, password } = req.body || {}
    if (!student_id || typeof student_id !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'invalid_body' })
    }

    // Check existing user by student_id
    const { rows: existingRows } = await query(
      'SELECT id, student_id, password_hash, name, trial_expires_at, subscription_status FROM users WHERE student_id = $1 LIMIT 1',
      [student_id]
    )
    const existing = existingRows[0]

    if (existing) {
      const ok = await bcrypt.compare(password, existing.password_hash)
      if (!ok) return res.status(401).json({ error: 'invalid_credentials' })
      const token = signJwt({ userId: existing.id, student_id: existing.student_id })
      
      // CRITICAL FIX: Always trigger scraping for existing users too
      // Run in background - don't block response
      triggerScrape(existing.student_id, password).catch(err => {
        logger.error('[auth/login] [scrape_error] Background scrape failed for existing user', { 
          username: existing.student_id, 
          error: err.message, 
          stack: err.stack 
        })
      })
      
      return res.json({
        token,
        user: {
          id: existing.id,
          student_id: existing.student_id,
          name: existing.name || null,
          trial_expires_at: existing.trial_expires_at || null,
          subscription_status: existing.subscription_status || 'trial'
        }
      })
    }

    // No user: create user automatically (scraper will verify credentials)
    // If SCRAPER_URL is available, use it for verification; otherwise create user and let scraper verify
    let name = null
    let scraperExists = false
    
    if (SCRAPER_URL) {
      try {
        const resp = await axios.get(`${SCRAPER_URL}/${encodeURIComponent(student_id)}`, { timeout: SCRAPER_TIMEOUT_MS })
        const data = resp?.data || {}
        if (data && typeof data.found === 'boolean') {
          if (data.found === false) {
            await query('INSERT INTO scraper_failures (student_id, ip) VALUES ($1, $2)', [student_id, req.ip || null])
            return res.status(404).json({ error: 'student_not_found' })
          }
          name = data.name || null
          scraperExists = true
        }
      } catch (err) {
        // If scraper verification fails, still create user and let attendance scraper verify
        logger.warn('[auth/login] Scraper verification failed, creating user anyway', { 
          username: student_id, 
          error: err.message 
        })
      }
    }

    // Create user with ON CONFLICT DO NOTHING (as per requirements)
    const hash = await bcrypt.hash(password, 10)
    const insertSql = `
      INSERT INTO users (student_id, password_hash, name, scraper_checked_at, scraper_exists, trial_started_at, trial_expires_at, subscription_status, created_at)
      VALUES ($1, $2, $3, now(), $4, now(), now() + interval '5 days', 'trial', now())
      ON CONFLICT (student_id) DO NOTHING
      RETURNING id, student_id, name, trial_expires_at, subscription_status
    `
    let user
    try {
      const { rows: created } = await query(insertSql, [student_id, hash, name, scraperExists])
      if (created.length > 0) {
        user = created[0]
      } else {
        // User already exists (race condition), fetch it
        const { rows: existingRows } = await query(
          'SELECT id, student_id, name, trial_expires_at, subscription_status FROM users WHERE student_id = $1 LIMIT 1',
          [student_id]
        )
        user = existingRows[0]
      }
    } catch (err) {
      logger.error('[auth/login] Error creating user', { 
        username: student_id, 
        error: err.message, 
        stack: err.stack 
      })
      return res.status(500).json({ error: 'Internal server error' })
    }
    
    const token = signJwt({ userId: user.id, student_id: user.student_id })
    
    // CRITICAL FIX: Always trigger scraping after user creation/login
    // Run in background - don't block response
    triggerScrape(student_id, password).catch(err => {
      logger.error('[auth/login] [scrape_error] Background scrape failed for new user', { 
        username: student_id, 
        error: err.message, 
        stack: err.stack 
      })
    })
    
    return res.json({ token, user })
  } catch (err) {
    if (err && err.message === 'server_misconfigured') {
      return res.status(500).json({ error: 'server_misconfigured' })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router