import logger from '../../lib/logger.js'
import { Pool } from 'pg'
import fetch from 'node-fetch'
import { CookieJar } from 'tough-cookie'
import fetchCookie from 'fetch-cookie'
import * as cheerio from 'cheerio'

// Lazy pool initialization - only create when first needed
let pool = null

function getPool() {
  if (!pool) {
    const DB_URL = process.env.DATABASE_URL || ''
    if (!DB_URL) {
      throw new Error('DATABASE_URL not configured in scraperService')
    }
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000
    })
    logger.info('[scraperService] Database pool initialized')
  }
  return pool
}

const LMS_BASE = 'https://sbmchlms.com/lms'
const LOGIN_URL = `${LMS_BASE}/site/userlogin`
const DASHBOARD_URL = `${LMS_BASE}/user/user/dashboard`
const ATTENDANCE_PAGE_URL = `${LMS_BASE}/user/attendence/subjectbyattendance`
const ATTENDANCE_API_URL = `${LMS_BASE}/user/attendence/subjectgetdaysubattendence`
const ORIGIN = 'https://sbmchlms.com'

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function withDefaultHeaders(headers = {}) {
  return { ...DEFAULT_HEADERS, ...headers }
}

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

async function loginToLms({ username, password }) {
  logger.info('[scraperService] Starting LMS login', { username })
  const jar = new CookieJar()
  const fetchWithCookies = fetchCookie(fetch, jar)
  const client = (url, options = {}) => {
    const headers = withDefaultHeaders(options.headers)
    return fetchWithCookies(url, { ...options, headers })
  }

  let loginPage
  try {
    loginPage = await client(LOGIN_URL, { method: 'GET' })
    if (!loginPage.ok) {
      throw new Error(`Login page request failed (${loginPage.status})`)
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED') {
      logger.error('[scraperService] LMS host not reachable', { 
        username, 
        error: err.message, 
        code: err.code,
        host: LOGIN_URL 
      })
      throw new Error(`LMS host not reachable: ${err.message}`)
    }
    throw err
  }
  const loginHtml = await loginPage.text()
  const $login = cheerio.load(loginHtml)
  const hiddenInputs = {}
  $login('input[type="hidden"]').each((_, el) => {
    const name = $login(el).attr('name')
    if (!name) return
    hiddenInputs[name] = $login(el).attr('value') ?? ''
  })

  const form = new URLSearchParams()
  form.set('username', username)
  form.set('password', password)
  Object.entries(hiddenInputs).forEach(([key, value]) => form.append(key, value ?? ''))

  const loginResponse = await client(LOGIN_URL, {
    method: 'POST',
    body: form,
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ORIGIN,
      Referer: LOGIN_URL
    }),
    redirect: 'manual'
  })

  if ([301, 302, 303].includes(loginResponse.status)) {
    const location = loginResponse.headers.get('location')
    if (location) {
      const destination = new URL(location, LOGIN_URL).toString()
      await client(destination, { method: 'GET' })
    }
  } else {
    const body = await loginResponse.text()
    if (!loginResponse.ok || /invalid username|password/i.test(body)) {
      logger.error('[scraperService] LMS login rejected credentials', { username, status: loginResponse.status })
      throw new Error('Login failed: the LMS rejected the credentials or returned an unexpected response.')
    }
  }

  logger.info('[scraperService] LMS login successful', { username })
  return { client }
}

function parseUpcomingClasses($) {
  const upcoming = []
  $('.user-progress .lecture-list').each((_, li) => {
    const $li = $(li)
    const avatar = cleanText($li.find('img').attr('src') || $li.find('img').attr('data-src') || '')
    let title = cleanText($li.find('.media-title').first().text())
    if (!title) {
      title = cleanText($li.find('.bmedium').first().text())
    }
    const subtitle = cleanText($li.find('.text-muted').first().text())
    const msAuto = $li.find('.ms-auto').first()
    let location = ''
    let time = ''
    if (msAuto && msAuto.length) {
      location = cleanText(msAuto.find('.bmedium').first().text())
      if (!location) {
        location = cleanText(msAuto.children().first().text())
      }
      time = cleanText(msAuto.find('.text-muted').first().text())
      if (!time && msAuto.children().length > 1) {
        time = cleanText(msAuto.children().eq(1).text())
      }
    }
    upcoming.push({ title, subtitle, location, time, avatar })
  })
  return upcoming
}

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

function parseAttendanceRows(resultPage) {
  if (!resultPage) return []
  const $ = cheerio.load(resultPage)
  const rows = []
  
  const resultBox = $('.attendance_result')
  const table = resultBox.length ? resultBox.find('table') : $('table')
  
  if (!table.length) {
    logger.warn('No attendance table found in result page')
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

async function fetchAttendanceTable(client, { fromDate, toDate, subjectId = '' }) {
  await client(ATTENDANCE_PAGE_URL, { method: 'GET' })
  
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const defaultFromDate = fromDate || '11-11-2024'
  const defaultToDate = toDate || `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`
  
  logger.info('Fetching attendance with date range', { 
    fromDate: defaultFromDate, 
    toDate: defaultToDate,
    subjectId: subjectId || 'all'
  })

  const payload = new URLSearchParams()
  payload.set('date', defaultFromDate)
  payload.set('end_date', defaultToDate)
  payload.set('subject', subjectId ?? '')

  const response = await client(ATTENDANCE_API_URL, {
    method: 'POST',
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: ATTENDANCE_PAGE_URL,
      Accept: 'application/json, text/javascript, */*; q=0.01'
    }),
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
    if (json.result_page) {
      return parseAttendanceRows(json.result_page)
    }
    return []
  }
  return parseAttendanceRows(json.result_page || '')
}

async function scrapeAttendance({ username, password, fromDate, toDate }) {
  logger.info('[scraperService] scrapeAttendance invoked', { username })
  try {
    const { client } = await loginToLms({ username, password })
    logger.info('[scraperService] Fetching student dashboard', { username })
    const { studentName, upcomingClasses } = await fetchStudentDashboard(client, username)
    logger.info('[scraperService] Fetching attendance table', { username })
    const attendanceRows = await fetchAttendanceTable(client, { fromDate, toDate, subjectId: '' })
    logger.info('[scraperService] Scraping completed', { 
      username, 
      attendanceRowsCount: attendanceRows.length,
      upcomingClassesCount: upcomingClasses.length 
    })
    return { studentName, upcomingClasses, attendanceRows }
  } catch (err) {
    logger.error('[scraperService] scrapeAttendance failed', { 
      username, 
      error: err.message, 
      stack: err.stack,
      code: err.code 
    })
    throw err
  }
}

export async function triggerScrape(studentId, password, fromDate, toDate) {
  const username = studentId
  logger.info('[auth] Scrape job started', { username: studentId })
  
  // Validate DATABASE_URL before starting
  if (!process.env.DATABASE_URL) {
    const error = new Error('DATABASE_URL not configured - cannot save attendance data')
    logger.error('[scrape_error]', { username: studentId, error: error.message })
    throw error
  }
  
  try {
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const normalizedFrom = fromDate || '11-11-2024'
    const normalizedTo = toDate || `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`
    
    logger.info('[scraperService] Using date range for scraping', { from: normalizedFrom, to: normalizedTo })
    
    const result = await scrapeAttendance({
      username,
      password,
      fromDate: normalizedFrom,
      toDate: normalizedTo
    })

    const processed = (result.attendanceRows || []).map(row => {
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

    const studentName = result.studentName || username

    logger.info('[scraperService] Starting database save for scraped data', { 
      username, 
      attendanceCount: processed.length,
      upcomingClassesCount: result.upcomingClasses?.length || 0
    })

    // Delete old data for this username
    try {
      const dbPool = getPool()
      const deleteAttendanceResult = await dbPool.query('DELETE FROM attendance WHERE username = $1', [username])
      const deleteClassesResult = await dbPool.query('DELETE FROM upcoming_classes WHERE username = $1', [username])
      logger.info('[scraperService] Deleted old attendance data for user', { 
        username,
        deletedAttendanceRows: deleteAttendanceResult.rowCount,
        deletedClassesRows: deleteClassesResult.rowCount
      })
    } catch (deleteErr) {
      logger.error('[scraperService] Error deleting old data', { username, error: deleteErr.message, stack: deleteErr.stack })
      throw deleteErr
    }

    // Bulk insert attendance records
    if (processed.length > 0) {
      const dbPool = getPool()
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        
        let insertedCount = 0
        for (const row of processed) {
          try {
            await client.query(
              `INSERT INTO attendance (username, student_name, subject, present, absent, total, percent, margin, required, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                username,
                studentName,
                row.subject,
                row.present,
                row.absent,
                row.total,
                row.percent,
                row.margin,
                row.required,
                'scraper'
              ]
            )
            insertedCount++
          } catch (insertErr) {
            logger.error('[scraperService] Error inserting attendance record', { 
              username, 
              subject: row.subject, 
              error: insertErr.message 
            })
            throw insertErr
          }
        }
        
        await client.query('COMMIT')
        logger.info('[scraperService] Successfully inserted attendance records', { 
          username, 
          count: insertedCount,
          expected: processed.length 
        })
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error('[scraperService] Transaction failed, rolled back', { 
          username, 
          error: err.message, 
          stack: err.stack 
        })
        throw err
      } finally {
        client.release()
      }
    } else {
      logger.warn('[scraperService] No attendance records to insert', { username })
    }

    // Insert upcoming classes
    if (result.upcomingClasses && result.upcomingClasses.length > 0) {
      const dbPool = getPool()
      const client = await dbPool.connect()
      try {
        await client.query('BEGIN')
        
        let insertedClassesCount = 0
        for (const cls of result.upcomingClasses) {
          try {
            await client.query(
              `INSERT INTO upcoming_classes (username, class_id, class_name, start_time, end_time, metadata)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                username,
                cls.id || cls.class_id || null,
                cls.name || cls.class_name || cls.title || null,
                cls.start_time ? new Date(cls.start_time) : null,
                cls.end_time ? new Date(cls.end_time) : null,
                JSON.stringify(cls.metadata || cls)
              ]
            )
            insertedClassesCount++
          } catch (insertErr) {
            logger.error('[scraperService] Error inserting upcoming class', { 
              username, 
              class: cls.name || cls.class_name, 
              error: insertErr.message 
            })
            throw insertErr
          }
        }
        
        await client.query('COMMIT')
        logger.info('[scraperService] Successfully inserted upcoming classes', { 
          username, 
          count: insertedClassesCount,
          expected: result.upcomingClasses.length 
        })
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error('[scraperService] Upcoming classes transaction failed, rolled back', { 
          username, 
          error: err.message, 
          stack: err.stack 
        })
        throw err
      } finally {
        client.release()
      }
    } else {
      logger.info('[scraperService] No upcoming classes to insert', { username })
    }

    // CRITICAL: Update latest_snapshot - get the most recent attendance record for this user
    const dbPool = getPool()
    const { rows: latestRows } = await dbPool.query(
      `SELECT id FROM attendance WHERE username = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [username]
    )
    
    if (latestRows.length > 0) {
      await dbPool.query(
        `INSERT INTO latest_snapshot (username, attendance_id, fetched_at)
         VALUES ($1, $2, now())
         ON CONFLICT (username) DO UPDATE SET
           attendance_id = EXCLUDED.attendance_id,
           fetched_at = EXCLUDED.fetched_at`,
        [username, latestRows[0].id]
      )
      logger.info('[scraperService] Updated latest_snapshot', { username, attendance_id: latestRows[0].id })
    } else {
      // Even if no attendance rows, create a snapshot entry to prevent infinite 202 responses
      // Use NULL attendance_id to indicate no data available
      await dbPool.query(
        `INSERT INTO latest_snapshot (username, attendance_id, fetched_at)
         VALUES ($1, NULL, now())
         ON CONFLICT (username) DO UPDATE SET
           fetched_at = EXCLUDED.fetched_at`,
        [username]
      )
      logger.warn('[scraperService] No attendance records found - created empty snapshot', { 
        username,
        note: 'Scraping completed but returned 0 attendance rows. This may indicate LMS returned empty data or credentials are invalid.'
      })
    }

    // Verify data was actually saved
    const { rows: verifyRows } = await dbPool.query(
      `SELECT COUNT(*) as count FROM attendance WHERE username = $1`,
      [username]
    )
    const savedCount = parseInt(verifyRows[0]?.count || 0)

    logger.info('[scraperService] Attendance scraped and saved to database', {
      username,
      subjects: processed.length,
      savedToDatabase: savedCount,
      upcomingClasses: result.upcomingClasses?.length || 0,
      verified: savedCount === processed.length
    })

    if (savedCount !== processed.length && processed.length > 0) {
      logger.error('[scraperService] Data verification failed - count mismatch', {
        username,
        expected: processed.length,
        actual: savedCount
      })
    }

    logger.info('[auth] Scrape job completed', { username: studentId, attendanceCount: savedCount })
    return { success: true, attendanceCount: savedCount }
  } catch (err) {
    logger.error('[scrape_error]', { 
      username: studentId, 
      error: err.stack || err.message
    })
    throw err
  }
}

