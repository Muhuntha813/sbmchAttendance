/**
 * Debug script to test attendance flow end-to-end
 */

import fetch from 'node-fetch'

const API_BASE = 'https://sbmchattendance.onrender.com'
const TEST_STUDENT_ID = 'cursor_debug_001'
const TEST_PASSWORD = 'test'

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

console.log('='.repeat(60))
console.log('ATTENDANCE FLOW DEBUG TEST')
console.log('='.repeat(60))
console.log(`API Base: ${API_BASE}`)
console.log(`Test Student ID: ${TEST_STUDENT_ID}`)
console.log('='.repeat(60))

// Step 1: Login
console.log('\n[1] POST /api/auth/login')
try {
  const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      student_id: TEST_STUDENT_ID,
      password: TEST_PASSWORD
    })
  })
  
  const loginData = await loginRes.json().catch(() => ({}))
  console.log(`Status: ${loginRes.status}`)
  console.log(`Response:`, JSON.stringify(loginData, null, 2))
  
  if (loginRes.status !== 200 || !loginData.token) {
    console.error('❌ Login failed!')
    process.exit(1)
  }
  
  const token = loginData.token
  console.log(`✅ Login successful! Token: ${token.substring(0, 20)}...`)
  
  // Step 2: Poll attendance
  console.log('\n[2] Polling /api/attendance (18 attempts, 5s intervals = 90s total)')
  let success = false
  
  for (let i = 0; i < 18; i++) {
    await sleep(5000)
    
    try {
      const attRes = await fetch(`${API_BASE}/api/attendance`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      
      const attData = await attRes.json().catch(() => ({}))
      
      console.log(`\nAttempt ${i + 1}/18: Status ${attRes.status}`)
      if (attRes.status === 200) {
        console.log(`✅ Attendance data received!`)
        console.log(`   Student: ${attData.studentName || 'N/A'}`)
        console.log(`   Subjects: ${attData.attendance?.length || 0}`)
        console.log(`   Classes: ${attData.upcomingClasses?.length || 0}`)
        if (attData.attendance && attData.attendance.length > 0) {
          console.log(`   First subject: ${attData.attendance[0].subject} (${attData.attendance[0].percent}%)`)
        }
        success = true
        break
      } else if (attRes.status === 202) {
        console.log(`⏳ Pending: ${attData.message || 'No message'}`)
      } else {
        console.log(`❌ Error: ${attData.error || JSON.stringify(attData)}`)
      }
    } catch (err) {
      console.error(`❌ Request failed: ${err.message}`)
    }
  }
  
  if (!success) {
    console.log('\n❌ Attendance still pending after 90 seconds')
    console.log('\nPossible causes:')
    console.log('  1. Scraper not triggered (check logs for "[auth] Scrape job started")')
    console.log('  2. Scraper errors (check logs for "[scrape_error]")')
    console.log('  3. LMS connection issues (check logs for ENOTFOUND, ECONNREFUSED)')
    console.log('  4. Database write failures (check logs for SQL errors)')
    process.exit(1)
  }
  
} catch (err) {
  console.error('Fatal error:', err)
  process.exit(1)
}

