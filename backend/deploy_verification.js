/**
 * Full Deployment Verification Script
 * Tests: Health, Login, Attendance, CORS, DB
 */

import fetch from 'node-fetch'
import { Pool } from 'pg'

const API_BASE = process.env.API_BASE || 'https://sbmchattendance.onrender.com'
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://sbmch-attendance.vercel.app'
const DATABASE_URL = process.env.DATABASE_URL || ''
const TEST_STUDENT_ID = `test_cursor_${new Date().toISOString().replace(/[-:T]/g, '').split('.')[0]}`
const TEST_PASSWORD = 'test'

const report = {
  git: { commit_id: null, pushed: false },
  env: { keys_present: [], keys_updated: [] },
  deploy: { success: false, service_url: API_BASE },
  health: { status: null, response: null },
  login_test: { token_obtained: false, user: null, error: null },
  attendance_test: { status: 'pending', attendance_count: 0, error: null, attempts: [] },
  db: { user_exists: false, attendance_count: 0, snapshot_exists: false, error: null },
  logs: { matched_lines: [], last_lines: [] },
  remediation_actions: [],
  next_steps: []
}

function maskSecret(str) {
  if (!str) return '********'
  if (str.length <= 8) return '********'
  return str.substring(0, 4) + '********' + str.substring(str.length - 4)
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function testHealth() {
  console.log('\n[1] Testing health endpoints...')
  try {
    const health = await fetch(`${API_BASE}/health`)
    const healthz = await fetch(`${API_BASE}/healthz`)
    
    const healthData = await health.json().catch(() => ({}))
    const healthzData = await healthz.json().catch(() => ({}))
    
    report.health = {
      status: health.status === 200 && healthz.status === 200 ? 'ok' : 'failed',
      health: { status: health.status, data: healthData },
      healthz: { status: healthz.status, data: healthzData }
    }
    
    console.log(`  ✓ /health: ${health.status}`, healthData)
    console.log(`  ✓ /healthz: ${healthz.status}`, healthzData)
    return health.status === 200
  } catch (err) {
    console.error(`  ✗ Health check failed:`, err.message)
    report.health.error = err.message
    return false
  }
}

async function testLogin() {
  console.log(`\n[2] Testing login with student_id: ${TEST_STUDENT_ID}...`)
  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_id: TEST_STUDENT_ID,
        password: TEST_PASSWORD
      })
    })
    
    const data = await response.json().catch(() => ({}))
    
    if (response.status === 200 && data.token && data.user) {
      report.login_test = {
        token_obtained: true,
        user: { id: data.user.id, student_id: data.user.student_id, subscription_status: data.user.subscription_status },
        token_preview: maskSecret(data.token)
      }
      console.log(`  ✓ Login successful! Token: ${maskSecret(data.token)}`)
      return data.token
    } else {
      report.login_test = {
        token_obtained: false,
        error: `Status ${response.status}: ${JSON.stringify(data)}`
      }
      console.error(`  ✗ Login failed:`, data)
      return null
    }
  } catch (err) {
    report.login_test.error = err.message
    console.error(`  ✗ Login request failed:`, err.message)
    return null
  }
}

async function testAttendance(token, maxAttempts = 12) {
  console.log(`\n[3] Polling attendance (max ${maxAttempts} attempts, 5s intervals)...`)
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${API_BASE}/api/attendance`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      
      const data = await response.json().catch(() => ({}))
      const attempt = {
        attempt: i + 1,
        status: response.status,
        has_data: data.attendance && data.attendance.length > 0,
        attendance_count: data.attendance ? data.attendance.length : 0
      }
      
      report.attendance_test.attempts.push(attempt)
      
      if (response.status === 200 && data.attendance && data.attendance.length > 0) {
        report.attendance_test.status = 'ok'
        report.attendance_test.attendance_count = data.attendance.length
        console.log(`  ✓ Attendance data received! (${data.attendance.length} subjects)`)
        return true
      } else if (response.status === 202) {
        console.log(`  ⏳ Attempt ${i + 1}/${maxAttempts}: Pending...`)
      } else {
        report.attendance_test.status = 'failed'
        report.attendance_test.error = `Status ${response.status}: ${JSON.stringify(data)}`
        console.error(`  ✗ Attempt ${i + 1}: Error ${response.status}`, data)
        return false
      }
    } catch (err) {
      console.error(`  ✗ Attempt ${i + 1} failed:`, err.message)
      report.attendance_test.error = err.message
    }
    
    if (i < maxAttempts - 1) {
      await sleep(5000)
    }
  }
  
  report.attendance_test.status = 'pending'
  console.log(`  ⚠ Attendance still pending after ${maxAttempts} attempts`)
  return false
}

async function testCORS() {
  console.log(`\n[4] Testing CORS with origin: ${FRONTEND_ORIGIN}...`)
  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        'Origin': FRONTEND_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type'
      }
    })
    
    const acao = response.headers.get('Access-Control-Allow-Origin')
    const acam = response.headers.get('Access-Control-Allow-Methods')
    
    console.log(`  Access-Control-Allow-Origin: ${acao || 'MISSING'}`)
    console.log(`  Access-Control-Allow-Methods: ${acam || 'MISSING'}`)
    
    if (acao && (acao === FRONTEND_ORIGIN || acao === '*')) {
      console.log(`  ✓ CORS configured correctly`)
      return true
    } else {
      console.log(`  ✗ CORS misconfigured - expected ${FRONTEND_ORIGIN}, got ${acao}`)
      report.next_steps.push(`Fix CORS: Set FRONTEND_URL to ${FRONTEND_ORIGIN} (no trailing slash)`)
      return false
    }
  } catch (err) {
    console.error(`  ✗ CORS test failed:`, err.message)
    return false
  }
}

async function verifyDatabase() {
  if (!DATABASE_URL) {
    console.log(`\n[5] Database verification skipped (DATABASE_URL not provided)`)
    report.db.error = 'DATABASE_URL not provided'
    return
  }
  
  console.log(`\n[5] Verifying database...`)
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  })
  
  try {
    // Check user
    const userResult = await pool.query(
      'SELECT id, student_id, name, created_at FROM users WHERE student_id = $1',
      [TEST_STUDENT_ID]
    )
    report.db.user_exists = userResult.rows.length > 0
    console.log(`  User exists: ${report.db.user_exists}`, userResult.rows[0] || 'N/A')
    
    // Check attendance
    const attendanceResult = await pool.query(
      'SELECT COUNT(*) AS attendance_count FROM attendance WHERE username = $1',
      [TEST_STUDENT_ID]
    )
    report.db.attendance_count = parseInt(attendanceResult.rows[0]?.attendance_count || 0)
    console.log(`  Attendance rows: ${report.db.attendance_count}`)
    
    // Check snapshot
    const snapshotResult = await pool.query(
      'SELECT * FROM latest_snapshot WHERE username = $1',
      [TEST_STUDENT_ID]
    )
    report.db.snapshot_exists = snapshotResult.rows.length > 0
    console.log(`  Snapshot exists: ${report.db.snapshot_exists}`, snapshotResult.rows[0] || 'N/A')
    
  } catch (err) {
    report.db.error = err.message
    console.error(`  ✗ Database query failed:`, err.message)
  } finally {
    await pool.end()
  }
}

async function runVerification() {
  console.log('='.repeat(60))
  console.log('DEPLOYMENT VERIFICATION')
  console.log('='.repeat(60))
  console.log(`API Base: ${API_BASE}`)
  console.log(`Frontend Origin: ${FRONTEND_ORIGIN}`)
  console.log(`Test Student ID: ${TEST_STUDENT_ID}`)
  console.log('='.repeat(60))
  
  // Get commit ID
  const { execSync } = await import('child_process')
  try {
    const commitId = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    report.git.commit_id = commitId
    report.git.pushed = true
    console.log(`\n[0] Git commit: ${commitId}`)
  } catch (err) {
    console.log(`\n[0] Git commit: Could not determine`)
  }
  
  // Test health
  const healthOk = await testHealth()
  if (!healthOk) {
    console.error('\n❌ Health check failed - stopping verification')
    return report
  }
  
  // Test login
  const token = await testLogin()
  if (!token) {
    console.error('\n❌ Login failed - stopping verification')
    return report
  }
  
  // Wait a bit before polling
  console.log('\nWaiting 10 seconds before first attendance poll...')
  await sleep(10000)
  
  // Test attendance
  await testAttendance(token)
  
  // Test CORS
  await testCORS()
  
  // Verify database
  await verifyDatabase()
  
  return report
}

// Run verification
runVerification()
  .then(report => {
    console.log('\n' + '='.repeat(60))
    console.log('FINAL REPORT')
    console.log('='.repeat(60))
    console.log(JSON.stringify(report, null, 2))
  })
  .catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
  })

