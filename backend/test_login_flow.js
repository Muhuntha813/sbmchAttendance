/**
 * Automated test script for login + attendance flow
 * Tests: POST /api/auth/login -> poll GET /api/attendance
 */

import fetch from 'node-fetch'

const API_BASE = process.env.API_BASE || 'http://localhost:3000'
const TEST_STUDENT_ID = `std_cursor_test_${Date.now()}`
const TEST_PASSWORD = 'test_password_123'

console.log('='.repeat(60))
console.log('AUTOMATED LOGIN + ATTENDANCE FLOW TEST')
console.log('='.repeat(60))
console.log(`API Base: ${API_BASE}`)
console.log(`Test Student ID: ${TEST_STUDENT_ID}`)
console.log('')

// Exponential backoff delays (in seconds)
const POLL_DELAYS = [1, 2, 3, 5, 8, 12, 20]
const MAX_POLLS = POLL_DELAYS.length

async function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

async function testLogin() {
  console.log('STEP 1: Testing POST /api/auth/login')
  console.log('-'.repeat(60))
  
  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_id: TEST_STUDENT_ID,
        password: TEST_PASSWORD
      })
    })
    
    const status = response.status
    const data = await response.json().catch(() => ({}))
    
    console.log(`Status: ${status}`)
    console.log(`Response:`, JSON.stringify(data, null, 2))
    
    if (status !== 200) {
      console.error('❌ Login failed!')
      return null
    }
    
    if (!data.token || !data.user) {
      console.error('❌ Missing token or user in response!')
      return null
    }
    
    console.log('✅ Login successful!')
    console.log(`Token: ${data.token.substring(0, 20)}...`)
    console.log(`User ID: ${data.user.id}`)
    console.log('')
    
    return data.token
  } catch (err) {
    console.error('❌ Login request failed:', err.message)
    return null
  }
}

async function testAttendance(token, attempt = 1) {
  console.log(`STEP 2: Polling GET /api/attendance (Attempt ${attempt}/${MAX_POLLS})`)
  console.log('-'.repeat(60))
  
  try {
    const response = await fetch(`${API_BASE}/api/attendance`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
    
    const status = response.status
    const data = await response.json().catch(() => ({}))
    
    console.log(`Status: ${status}`)
    if (status === 200) {
      console.log(`✅ Attendance data received!`)
      console.log(`Student Name: ${data.studentName || 'N/A'}`)
      console.log(`Subjects: ${data.attendance?.length || 0}`)
      console.log(`Upcoming Classes: ${data.upcomingClasses?.length || 0}`)
      if (data.attendance && data.attendance.length > 0) {
        console.log(`First Subject: ${data.attendance[0].subject} (${data.attendance[0].percent}%)`)
      }
      return { success: true, status, data }
    } else if (status === 202) {
      console.log(`⏳ Pending (${data.message || 'No message'})`)
      return { success: false, status, pending: true, data }
    } else {
      console.log(`❌ Error: ${data.error || 'Unknown error'}`)
      return { success: false, status, error: data.error, data }
    }
  } catch (err) {
    console.error(`❌ Request failed: ${err.message}`)
    return { success: false, error: err.message }
  }
}

async function runTest() {
  const token = await testLogin()
  
  if (!token) {
    console.log('')
    console.log('='.repeat(60))
    console.log('TEST FAILED: Could not obtain token')
    console.log('='.repeat(60))
    process.exit(1)
  }
  
  console.log('')
  console.log('Waiting 5 seconds before first attendance check...')
  await sleep(5)
  console.log('')
  
  let result = null
  for (let i = 0; i < MAX_POLLS; i++) {
    result = await testAttendance(token, i + 1)
    console.log('')
    
    if (result.success) {
      console.log('='.repeat(60))
      console.log('✅ TEST PASSED: Attendance data received!')
      console.log('='.repeat(60))
      process.exit(0)
    }
    
    if (!result.pending) {
      // Not pending means error - stop polling
      break
    }
    
    if (i < MAX_POLLS - 1) {
      const delay = POLL_DELAYS[i]
      console.log(`Waiting ${delay} seconds before next attempt...`)
      await sleep(delay)
      console.log('')
    }
  }
  
  console.log('='.repeat(60))
  console.log('❌ TEST FAILED: Attendance data not available after all attempts')
  console.log('='.repeat(60))
  console.log(`Final status: ${result?.status || 'unknown'}`)
  console.log(`Final error: ${result?.error || 'N/A'}`)
  process.exit(1)
}

// Run test
runTest().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

