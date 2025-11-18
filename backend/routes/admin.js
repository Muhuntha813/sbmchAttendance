import express from 'express'
import { query } from '../src/db.js'

const router = express.Router()

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || ''

router.get('/unverified', async (req, res) => {
  const suppliedKey = req.headers['x-admin-key']

  if (!ADMIN_API_KEY) {
    console.warn('[admin/unverified] ADMIN_API_KEY not configured')
    return res.status(500).json({ error: 'admin_disabled' })
  }

  if (typeof suppliedKey !== 'string' || suppliedKey !== ADMIN_API_KEY) {
    console.warn('[admin/unverified] unauthorized access attempt', { ip: req.ip })
    return res.status(401).json({ error: 'unauthorized' })
  }

  try {
    const { rows } = await query(
      `SELECT id, student_id, name, scraper_checked_at, trial_expires_at, needs_verification, created_at
       FROM users
       WHERE needs_verification = true
       ORDER BY scraper_checked_at DESC NULLS LAST, created_at DESC`
    )
    console.log('[admin/unverified] returning users', { count: rows.length })
    return res.json({ users: rows })
  } catch (err) {
    console.error('[admin/unverified] failed to load users', err.message)
    return res.status(500).json({ error: 'internal_error' })
  }
})

export default router




