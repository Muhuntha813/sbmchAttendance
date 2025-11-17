import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import path from 'path'
import { fileURLToPath } from 'url'
import { query } from '../src/db.js'
import { loginToLms } from '../src/lib/lmsClient.js'
import { Pool } from 'pg'
import logger from '../lib/logger.js'
import { saveScrapedDataToDatabase, scrapingStatus } from '../src/services/scraperService.js'
import * as cheerio from 'cheerio'

// Load .env from project root (two levels up from backend/routes/)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ 
  path: path.resolve(__dirname, '..', '..', '.env')
})

const router = express.Router()

const JWT_SECRET = process.env.JWT_SECRET || process.env.SECRET || ''
const LMS_TIMEOUT_MS = Number(process.env.LMS_TIMEOUT_MS || 10000)
const DATABASE_URL = process.env.DATABASE_URL || ''

// Helper functions for computing attendance metrics
function computePercent(present, total) {
  if (total === 0) return 0
  return +((present / total) * 100).toFixed(2)
}

function computeRequired(present, total) {
  if (total === 0) return 0
  const current = (present / total) * 100
  if (current >= 75) return 0
  let r = 0
  while (true) {
    const pct = ((present + r) / (total + r)) * 100
    if (pct >= 75) return r
    r++
    if (r > 2000) return r
  }
}

function computeCanMiss(present, total) {
  if (present < 0 || total <= 0) return 0
  const threshold = 0.75
  const allowed = Math.floor(present / threshold - total)
  return Math.max(0, allowed)
}

// Helper to clean text
function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

// Constants for LMS URLs (must match server.js and working Puppeteer code)
const LMS_BASE = 'https://sbmchlms.com/lms'
const DASHBOARD_URL = process.env.DASHBOARD_URL || `${LMS_BASE}/user/user/dashboard`
const ATTENDANCE_PAGE_URL = process.env.ATTENDANCE_PAGE_URL || `${LMS_BASE}/user/attendence/subjectbyattendance`
const ATTENDANCE_API_URL = process.env.ATTENDANCE_API_URL || `${LMS_BASE}/user/attendence/subjectgetdaysubattendence`

/**
 * Parse upcoming classes from dashboard HTML
 */
function parseUpcomingClasses($) {
  const upcoming = []
  $('.user-progress .lecture-list').each((_, li) => {
    const $li = $(li)
    const title = cleanText($li.find('.media-title').first().text() || $li.find('.bmedium').first().text())
    const subtitle = cleanText($li.find('.text-muted').first().text())
    const msAuto = $li.find('.ms-auto').first()
    let location = ''
    let time = ''
    if (msAuto && msAuto.length) {
      location = cleanText(msAuto.find('.bmedium').first().text() || msAuto.children().first().text())
      time = cleanText(msAuto.find('.text-muted').first().text() || msAuto.children().eq(1).text())
    }
    upcoming.push({ 
      id: null,
      class_id: null,
      name: title,
      class_name: title,
      title: title,
      subtitle,
      location,
      time,
      start_time: null, // Would need to parse from time string
      end_time: null,
      metadata: { subtitle, location, time }
    })
  })
  return upcoming
}

/**
 * Fetch student dashboard and parse data
 */
async function fetchStudentDashboard(client, username) {
  const dashboardResponse = await client(DASHBOARD_URL, { method: 'GET' })
  if (!dashboardResponse.ok) {
    throw new Error(`Dashboard request failed (${dashboardResponse.status})`)
  }
  const html = await dashboardResponse.text()
  if (/Student Login/i.test(html) && /Username/i.test(html)) {
    throw new Error('Session invalid – dashboard returned login page.')
  }
  const $ = cheerio.load(html)
  let studentName = cleanText($('h4.mt0').first().text().replace(/Welcome,/i, ''))
  if (!studentName) {
    studentName = username
  }
  const upcomingClasses = parseUpcomingClasses($)
  return { studentName, upcomingClasses }
}

/**
 * Parse attendance rows from HTML
 * Based on working Puppeteer code: looks for .attendance_result table
 */
function parseAttendanceRows(resultPage) {
  if (!resultPage) return []
  const $ = cheerio.load(resultPage)
  const rows = []
  
  // Look for .attendance_result table first (like your working Puppeteer code)
  const resultBox = $('.attendance_result')
  const table = resultBox.length ? resultBox.find('table') : $('table')
  
  if (!table.length) {
    logger.warn('[auth] No attendance table found in result page')
    return []
  }
  
  table.find('tbody tr').each((_, tr) => {
    const $tr = $(tr)
    const tds = $tr.find('td')
    if (tds.length < 3) return
    const subject = cleanText($(tds[0]).text())
    const percentText = cleanText($(tds[1]).text())
    const presentText = cleanText($(tds[2]).text())
    const percentMatch = percentText.match(/[\d.]+/)
    const percentValue = percentMatch ? parseFloat(percentMatch[0]) : NaN
    const ratioMatch = presentText.match(/(\d+)\s*\/\s*(\d+)/)
    const sessionsCompleted = ratioMatch ? parseInt(ratioMatch[1], 10) : 0
    const totalSessions = ratioMatch ? parseInt(ratioMatch[2], 10) : 0
    const present = sessionsCompleted
    const total = totalSessions
    const absent = total >= present ? total - present : 0
    const percent = !Number.isNaN(percentValue)
      ? +percentValue.toFixed(2)
      : (total ? +((present / total) * 100).toFixed(2) : 0)
    rows.push({
      subject,
      sessionsCompleted,
      totalSessions,
      present,
      total,
      absent,
      percent
    })
  })
  return rows
}

/**
 * Fetch attendance table from LMS
 * Based on working Puppeteer code: uses date format DD-MM-YYYY
 */
async function fetchAttendanceTable(client, { fromDate, toDate, subjectId = '' }) {
  // First, visit the attendance page (like Puppeteer does)
  await client(ATTENDANCE_PAGE_URL, { method: 'GET' })
  
  // Calculate date range (from your working code: FROM_DATE = '11-11-2024', TO_DATE = today)
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const defaultFromDate = fromDate || '11-11-2024' // Default from your working code
  const defaultToDate = toDate || `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`
  
  logger.info('[auth] Fetching attendance with date range', { 
    fromDate: defaultFromDate, 
    toDate: defaultToDate,
    subjectId: subjectId || 'all'
  })

  const payload = new URLSearchParams()
  // Use the same parameter names as the API expects
  payload.set('date', defaultFromDate)
  payload.set('end_date', defaultToDate)
  payload.set('subject', subjectId ?? '') // Empty string = all subjects

  const response = await client(ATTENDANCE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: ATTENDANCE_PAGE_URL,
      Accept: 'application/json, text/javascript, */*; q=0.01'
    },
    body: payload
  })

  if (!response.ok) {
    throw new Error(`Attendance API request failed (${response.status})`)
  }

  const json = await response.json().catch(() => null)
  if (!json) {
    throw new Error('Attendance API returned an empty response.')
  }
  if (String(json.status) !== '1') {
    return []
  }
  return parseAttendanceRows(json.result_page || '')
}

/**
 * Trigger attendance scraping and save to database
 * This runs in the background after login
 */
async function triggerAttendanceScrape(studentId, password) {
  // Prevent duplicate scrapes
  if (scrapingStatus[studentId] && scrapingStatus[studentId].running) {
    logger.info('[auth] Scrape already running for user', { student_id: studentId })
    return scrapingStatus[studentId].promise
  }

  const status = { running: true, promise: null }
  scrapingStatus[studentId] = status

  const job = (async () => {
    try {
      logger.info('[auth] Scrape job started for <username>', { username: studentId })
      
      // Login to LMS and get client
      logger.info('[auth] Starting LMS login for scraping', { student_id: studentId })
      const lmsResult = await loginToLms(studentId, password)
      
      if (!lmsResult || !lmsResult.success) {
        logger.error('[auth] LMS login failed', { 
          student_id: studentId, 
          reason: lmsResult?.reason || 'unknown' 
        })
        throw new Error(`LMS login failed: ${lmsResult?.reason || 'unknown error'}`)
      }

      if (!lmsResult.client) {
        logger.error('[auth] LMS login succeeded but no client returned', { student_id: studentId })
        throw new Error('LMS login succeeded but client not available')
      }

      const client = lmsResult.client
      logger.info('[scraperService] LMS login successful for <username>', { username: studentId })
      
      // Fetch dashboard and attendance data
      logger.info('[auth] Fetching dashboard data', { username: studentId })
      const { studentName, upcomingClasses } = await fetchStudentDashboard(client, studentId)
      logger.info('[auth] Dashboard fetched', { 
        username: studentId, 
        studentName, 
        upcomingClassesCount: upcomingClasses?.length || 0 
      })
      
      // Use date range like your working Puppeteer code
      const now = new Date()
      const pad = n => String(n).padStart(2, '0')
      const fromDate = '11-11-2024' // Default from your working code
      const toDate = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`
      
      logger.info('[auth] Fetching attendance table', { 
        username: studentId,
        fromDate,
        toDate
      })
      const attendanceRows = await fetchAttendanceTable(client, { fromDate, toDate, subjectId: '' })
      logger.info('[auth] Attendance table fetched', { 
        username: studentId, 
        attendanceRowsCount: attendanceRows?.length || 0 
      })

      if (!attendanceRows || attendanceRows.length === 0) {
        logger.warn('[auth] No attendance rows fetched from LMS', { username: studentId })
        throw new Error('No attendance data found in LMS')
      }

      // Process attendance rows
      logger.info('[auth] Processing attendance rows', { 
        username: studentId, 
        rawRowsCount: attendanceRows.length 
      })
      const processed = (attendanceRows || []).map(row => {
        const present = typeof row.present === 'number' ? row.present : (row.sessionsCompleted ?? 0)
        const total = typeof row.total === 'number' ? row.total : (row.totalSessions ?? 0)
        const absent = Number.isFinite(row.absent) ? row.absent : Math.max(0, total - present)
        const percent = Number.isFinite(row.percent) ? +row.percent.toFixed(2) : computePercent(present, total)
        const required = computeRequired(present, total)
        const margin = computeCanMiss(present, total)
        return {
          subject: row.subject,
          present,
          absent,
          total,
          percent,
          margin,
          required
        }
      })

      // Save to database using the shared service
      logger.info('[auth] Saving to database', { 
        username: studentId, 
        processedCount: processed.length,
        upcomingClassesCount: upcomingClasses?.length || 0 
      })
      
      try {
        const saveResult = await saveScrapedDataToDatabase({
          username: studentId,
          studentName: studentName || studentId,
          processed,
          upcomingClasses: upcomingClasses || []
        })
        
        logger.info('[auth] Database save completed', { 
          username: studentId,
          saveResult 
        })
      } catch (saveErr) {
        logger.error('[auth] Database save failed', {
          username: studentId,
          error: saveErr.message,
          stack: saveErr.stack,
          code: saveErr.code,
          detail: saveErr.detail
        })
        throw saveErr // Re-throw so it's caught by outer catch
      }

      logger.info('[auth] Attendance scraping completed successfully', { 
        student_id: studentId,
        subjects: processed.length,
        upcomingClasses: upcomingClasses?.length || 0
      })
      
    } catch (err) {
      logger.error('[auth] Scrape job error', { 
        student_id: studentId, 
        error: err.message, 
        stack: err.stack,
        errorCode: err.code,
        errorDetail: err.detail
      })
      // Log specific error types for debugging
      if (err.message?.includes('LMS') || err.message?.includes('login')) {
        logger.error('[auth] LMS-related error during scrape', { student_id: studentId, error: err.message })
      }
      if (err.message?.includes('database') || err.message?.includes('DATABASE') || err.message?.includes('connection')) {
        logger.error('[auth] Database error during scrape', { 
          student_id: studentId, 
          error: err.message,
          databaseUrl: DATABASE_URL ? 'configured' : 'missing'
        })
      }
    } finally {
      status.running = false
      logger.info('[auth] Scrape job finished', { student_id: studentId, running: false })
    }
  })()

  status.promise = job
  return job
}

// Rate limiter: Completely skip for localhost in development
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 1000 : 5, // Very high limit in dev
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts; try again in a minute.',
  // Completely skip rate limiting for localhost in development
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || ''
      const isLocalhost = ip === '127.0.0.1' || 
                          ip === '::1' || 
                          ip === '::ffff:127.0.0.1' || 
                          ip.startsWith('127.0.0.1') || 
                          ip.startsWith('::1') ||
                          ip === 'localhost' ||
                          !ip || ip === 'undefined' ||
                          ip.includes('localhost')
      if (isLocalhost) {
        console.log('[auth] Skipping rate limit for localhost:', ip)
        return true
      }
      // Also skip if NODE_ENV is development (for testing)
      return true
    }
    return false
  }
})

function signJwt(payload) {
  if (!JWT_SECRET) throw new Error('server_misconfigured')
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

async function recordLmsFailure(studentId, ip) {
  try {
    await query('INSERT INTO scraper_failures (student_id, ip) VALUES ($1, $2)', [studentId, ip || null])
  } catch (err) {
    console.warn('[auth/login] Failed to log LMS failure', err.message)
  }
}

function normaliseStudentId(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

router.post('/login', loginLimiter, async (req, res) => {
  const { student_id: rawStudentId, password } = req.body || {}
  const studentId = normaliseStudentId(rawStudentId)

  console.log('[auth/login] request body', { student_id: studentId ? `${studentId.slice(0, 3)}***` : null })

  if (!studentId || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'invalid_body' })
  }

  try {
    // Check for existing user first
    const { rows: existingRows } = await query(
      `SELECT id, student_id, password_hash, name, trial_expires_at, subscription_expires_at, subscription_status, needs_verification
       FROM users WHERE student_id = $1 LIMIT 1`,
      [studentId]
    )
    const existing = existingRows[0]

    if (existing) {
      // Existing user: verify password hash
      const ok = existing.password_hash ? await bcrypt.compare(password, existing.password_hash) : false
      if (!ok) {
        console.log('[auth/login] invalid credentials for existing user', { student_id: studentId })
        return res.status(401).json({ error: 'invalid_credentials' })
      }

      // Check if user's status is 'expired' but they actually have time left
      // This handles cases where admin updates trial_expires_at or subscription_expires_at in DB
      const now = new Date()
      const trialExpiresAt = existing.trial_expires_at ? new Date(existing.trial_expires_at) : null
      const subscriptionExpiresAt = existing.subscription_expires_at ? new Date(existing.subscription_expires_at) : null
      const currentStatus = String(existing.subscription_status || 'trial')
      
      let updatedStatus = currentStatus
      
      try {
        // If status is 'expired' but trial has time left, restore to 'trial'
        if (currentStatus === 'expired' && trialExpiresAt && trialExpiresAt > now) {
          console.log('[auth/login] Trial was extended, restoring trial status', { 
            student_id: studentId,
            trialExpiresAt: trialExpiresAt.toISOString(),
            now: now.toISOString()
          })
          await query(
            `UPDATE users SET subscription_status='trial' WHERE id=$1`,
            [existing.id]
          )
          updatedStatus = 'trial'
        }
        
        // If status is 'expired' but subscription has time left, restore to 'active'
        if (currentStatus === 'expired' && subscriptionExpiresAt && subscriptionExpiresAt > now) {
          console.log('[auth/login] Subscription was extended, restoring active status', { 
            student_id: studentId,
            subscriptionExpiresAt: subscriptionExpiresAt.toISOString(),
            now: now.toISOString()
          })
          await query(
            `UPDATE users SET subscription_status='active', notified_subscription_expired=false WHERE id=$1`,
            [existing.id]
          )
          updatedStatus = 'active'
        }
      } catch (statusUpdateErr) {
        // Log error but don't fail login - continue with current status
        console.error('[auth/login] Error updating subscription status', {
          error: statusUpdateErr.message,
          student_id: studentId,
          stack: statusUpdateErr.stack
        })
        // Continue with original status if update failed
        updatedStatus = currentStatus
      }

      // Sign JWT token - this can throw if JWT_SECRET is missing
      let token
      try {
        token = signJwt({ userId: existing.id, student_id: existing.student_id })
      } catch (jwtErr) {
        console.error('[auth/login] Failed to sign JWT', {
          error: jwtErr.message,
          student_id: studentId
        })
        return res.status(500).json({ 
          error: 'server_misconfigured',
          message: 'Server configuration error. Please contact support.' 
        })
      }

      console.log('[auth/login] returning existing user token', { 
        student_id: studentId,
        subscription_status: updatedStatus,
        userId: existing.id
      })
      
      // Trigger attendance scraping in background
      logger.info('[auth/login] Triggering attendance scrape for <username>', { username: studentId })
      const scrapePromise = triggerAttendanceScrape(studentId, password).catch(err => {
        logger.error('[auth/login] Failed to trigger attendance scrape', {
          student_id: studentId,
          error: err.message,
          stack: err.stack
        })
      })
      
      // Optionally wait for scrape to finish (bounded wait for better UX)
      const WAIT_MS = Number(process.env.SCRAPE_WAIT_MS || 12000)
      if (WAIT_MS > 0 && scrapingStatus[studentId] && scrapingStatus[studentId].promise) {
        const waitStart = Date.now()
        try {
          await Promise.race([
            scrapingStatus[studentId].promise,
            new Promise(resolve => setTimeout(resolve, WAIT_MS))
          ])
          const waited = Date.now() - waitStart
          if (waited < WAIT_MS) {
            logger.info('[auth/login] waited Xms for scrape to finish', { 
              username: studentId, 
              waitedMs: waited 
            })
          } else {
            logger.info('[auth/login] scrape not finished after WAIT_MS', { 
              username: studentId, 
              waitMs: WAIT_MS 
            })
          }
        } catch (e) {
          logger.warn('[auth/login] Error waiting for scrape', { 
            username: studentId, 
            error: e.message 
          })
        }
      }
      
      return res.json({
        token,
        user: {
          id: existing.id,
          student_id: existing.student_id,
          name: existing.name || null,
          trial_expires_at: existing.trial_expires_at || null,
          subscription_status: updatedStatus,
          needs_verification: Boolean(existing.needs_verification)
        }
      })
    }

    // New user: verify credentials against LMS
    console.log('[auth/login] new user, verifying against LMS', { student_id: studentId })
    let lmsResult = null
    let lmsError = null

    try {
      // Call LMS with timeout wrapper
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('LMS verification timeout')), LMS_TIMEOUT_MS)
      })
      lmsResult = await Promise.race([
        loginToLms(studentId, password),
        timeoutPromise
      ])
      console.log('[auth/login] LMS verification result', { 
        student_id: studentId, 
        success: lmsResult.success,
        hasName: !!lmsResult.name 
      })
    } catch (err) {
      lmsError = err
      const errorMsg = err.message || 'Unknown LMS error'
      console.error('[auth/login] LMS verification failed', { 
        student_id: studentId, 
        error: errorMsg 
      })
      
      // Check if it's an LMS unavailability error
      if (errorMsg.includes('LMS unavailable') || 
          errorMsg.includes('timeout') ||
          errorMsg.includes('ENOTFOUND') ||
          errorMsg.includes('ECONNREFUSED')) {
        return res.status(502).json({ 
          error: 'lms_unavailable',
          message: 'LMS verification service is temporarily unavailable. Please try again later.'
        })
      }
      
      // For other errors, treat as invalid credentials
      await recordLmsFailure(studentId, req.ip)
      return res.status(404).json({ error: 'student_not_found' })
    }

    // Check LMS verification result
    if (!lmsResult || !lmsResult.success) {
      await recordLmsFailure(studentId, req.ip)
      console.log('[auth/login] LMS rejected credentials', { student_id: studentId })
      return res.status(404).json({ error: 'student_not_found' })
    }

    // LMS verification successful - create user with trial
    const hash = await bcrypt.hash(password, 10)
    const studentName = lmsResult.name || null
    
    const trialInsertSql = `
      INSERT INTO users (
        student_id,
        password_hash,
        name,
        scraper_checked_at,
        scraper_exists,
        needs_verification,
        trial_started_at,
        trial_expires_at,
        subscription_status,
        created_at
      ) VALUES (
        $1,
        $2,
        $3,
        now(),
        $4,
        $5,
        now(),
        now() + interval '30 days',
        'trial',
        now()
      )
      RETURNING id, student_id, name, trial_expires_at, subscription_status, needs_verification
    `
    
    console.log('[auth/login] LMS verified student, creating user with trial', { 
      student_id: studentId,
      name: studentName 
    })

    const { rows: created } = await query(trialInsertSql, [
      studentId,
      hash,
      studentName,
      true, // scraper_exists = true (LMS verified)
      false // needs_verification = false (LMS verified)
    ])
    
    const newUser = created[0]
    const token = signJwt({ userId: newUser.id, student_id: newUser.student_id })

    // Trigger attendance scraping in background
    logger.info('[auth/login] Triggering attendance scrape for <username>', { username: studentId })
    const scrapePromise = triggerAttendanceScrape(studentId, password).catch(err => {
      logger.error('[auth/login] Failed to trigger attendance scrape for new user', {
        student_id: studentId,
        error: err.message,
        stack: err.stack
      })
    })
    
    // Optionally wait for scrape to finish (bounded wait for better UX)
    const WAIT_MS = Number(process.env.SCRAPE_WAIT_MS || 12000)
    if (WAIT_MS > 0 && scrapingStatus[studentId] && scrapingStatus[studentId].promise) {
      const waitStart = Date.now()
      try {
        await Promise.race([
          scrapingStatus[studentId].promise,
          new Promise(resolve => setTimeout(resolve, WAIT_MS))
        ])
        const waited = Date.now() - waitStart
        if (waited < WAIT_MS) {
          logger.info('[auth/login] waited Xms for scrape to finish', { 
            username: studentId, 
            waitedMs: waited 
          })
        } else {
          logger.info('[auth/login] scrape not finished after WAIT_MS', { 
            username: studentId, 
            waitMs: WAIT_MS 
          })
        }
      } catch (e) {
        logger.warn('[auth/login] Error waiting for scrape', { 
          username: studentId, 
          error: e.message 
        })
      }
    }

    return res.json({ token, user: newUser })
  } catch (err) {
    console.error('[auth/login] Unhandled error in login route:', {
      message: err.message,
      code: err.code,
      name: err.name,
      stack: err.stack
    })
    
    // Ensure we always send a response
    if (res.headersSent) {
      console.error('[auth/login] Response already sent, cannot send error response')
      return
    }
    
    if (err && err.message === 'server_misconfigured') {
      return res.status(500).json({ 
        error: 'server_misconfigured',
        message: 'Server configuration error. Please contact support.' 
      })
    }
    
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.message?.includes('Database connection failed') || err.message?.includes('DATABASE_URL not configured')) {
      return res.status(502).json({
        error: 'database_unavailable',
        message: 'Database connection failed. Please check DATABASE_URL configuration.'
      })
    }
    
    if (err.message?.includes('connect') || err.message?.includes('timeout')) {
      return res.status(502).json({ 
        error: 'database_unavailable', 
        message: 'Database connection failed. Please try again later.' 
      })
    }
    
    // In development, show the actual error for debugging
    const errorMessage = process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    console.error('[auth/login] Returning 500 with message:', errorMessage)
    return res.status(500).json({
      error: 'internal_server_error',
      message: errorMessage
    })
  }
})

/**
 * GET /api/auth/status
 * Returns current user subscription status
 */
router.get('/status', async (req, res) => {
  try {
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized', message: 'Authentication required' })
    }
    
    const token = auth.slice(7)
    try {
      const jwt = require('jsonwebtoken')
      const JWT_SECRET = process.env.JWT_SECRET || process.env.SECRET || ''
      const payload = jwt.verify(token, JWT_SECRET)
      
      if (!payload || !payload.userId) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' })
      }
      
      // Get user status
      const { rows } = await query(
        `SELECT id, student_id, subscription_status, trial_expires_at, subscription_expires_at, subscription_started_at
         FROM users WHERE id = $1 LIMIT 1`,
        [payload.userId]
      )
      
      if (rows.length === 0) {
        return res.status(404).json({ error: 'user_not_found' })
      }
      
      const user = rows[0]
      return res.json({
        subscription_status: user.subscription_status,
        trial_expires_at: user.trial_expires_at,
        subscription_expires_at: user.subscription_expires_at,
        subscription_started_at: user.subscription_started_at
      })
    } catch (jwtErr) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' })
    }
  } catch (err) {
    logger.error('[auth/status] Error', { error: err.message })
    return res.status(500).json({ error: 'internal_error' })
  }
})

export default router