// backend/src/lib/lmsClient.js
// LMS authentication client for verifying student credentials

import fetch from 'node-fetch'
import { CookieJar } from 'tough-cookie'
import fetchCookie from 'fetch-cookie'
import * as cheerio from 'cheerio'

const LMS_BASE = 'https://sbmchlms.com/lms'
const LOGIN_URL = `${LMS_BASE}/site/userlogin`
const DASHBOARD_URL = `${LMS_BASE}/user/user/dashboard`
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

/**
 * Fetches student name from dashboard after successful login
 * @param {Function} client - Authenticated fetch client with cookies
 * @param {string} username - Student ID (fallback if name not found)
 * @returns {Promise<string>} Student name or username as fallback
 */
async function fetchStudentName(client, username) {
  try {
    const dashboardResponse = await client(DASHBOARD_URL, { method: 'GET' })
    if (!dashboardResponse.ok) {
      throw new Error(`Dashboard request failed (${dashboardResponse.status})`)
    }
    const html = await dashboardResponse.text()
    // Check if we got redirected back to login (session invalid)
    if (/Student Login/i.test(html) && /Username/i.test(html)) {
      throw new Error('Session invalid – dashboard returned login page.')
    }
    const $ = cheerio.load(html)
    let studentName = cleanText($('h4.mt0').first().text().replace(/Welcome,/i, ''))
    if (!studentName) {
      studentName = username
    }
    return studentName
  } catch (err) {
    // If dashboard fetch fails, return username as fallback
    console.warn('[lmsClient] Failed to fetch student name, using username as fallback:', err.message)
    return username
  }
}

/**
 * Verifies student credentials against the LMS
 * @param {string} studentId - Student ID to verify
 * @param {string} password - Password to verify
 * @returns {Promise<{success: boolean, name?: string, reason?: string}>}
 *   - On success: { success: true, name: 'Full Name' }
 *   - On invalid credentials: { success: false, reason: 'invalid_credentials' }
 *   - Throws on network errors or LMS unavailability
 */
export async function loginToLms(studentId, password) {
  const jar = new CookieJar()
  const fetchWithCookies = fetchCookie(fetch, jar)
  const client = (url, options = {}) => {
    const headers = withDefaultHeaders(options.headers)
    return fetchWithCookies(url, { ...options, headers })
  }

  try {
    // Step 1: Get login page and extract hidden form fields
    const loginPage = await client(LOGIN_URL, { method: 'GET' })
    if (!loginPage.ok) {
      throw new Error(`Login page request failed (${loginPage.status})`)
    }
    const loginHtml = await loginPage.text()
    const $login = cheerio.load(loginHtml)
    const hiddenInputs = {}
    $login('input[type="hidden"]').each((_, el) => {
      const name = $login(el).attr('name')
      if (!name) return
      hiddenInputs[name] = $login(el).attr('value') ?? ''
    })

    // Step 2: Submit login form
    const form = new URLSearchParams()
    form.set('username', studentId)
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

    // Step 3: Check if login was successful (redirect indicates success)
    if ([301, 302, 303].includes(loginResponse.status)) {
      // Login successful - follow redirect and fetch student name
      const location = loginResponse.headers.get('location')
      if (location) {
        const destination = new URL(location, LOGIN_URL).toString()
        await client(destination, { method: 'GET' })
      }
      // Fetch student name from dashboard
      const studentName = await fetchStudentName(client, studentId)
      // Return both success status and client for scraping use
      return { success: true, name: studentName, client }
    } else {
      // No redirect - check response body for error messages
      const body = await loginResponse.text()
      if (!loginResponse.ok || /invalid username|password/i.test(body)) {
        return { success: false, reason: 'invalid_credentials' }
      }
      // Unexpected response - assume failure
      return { success: false, reason: 'unexpected_response' }
    }
  } catch (err) {
    // Network errors, timeouts, or other failures
    const errorMessage = err.message || 'Unknown error'
    console.error('[lmsClient] LMS verification error:', errorMessage)
    
    // Re-throw network/unavailability errors so caller can handle them
    if (errorMessage.includes('ENOTFOUND') || 
        errorMessage.includes('ECONNREFUSED') || 
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('timeout')) {
      throw new Error('LMS unavailable: ' + errorMessage)
    }
    
    // For other errors, check if it's an invalid credentials case
    if (errorMessage.includes('Login failed') || 
        errorMessage.includes('invalid') ||
        errorMessage.includes('rejected')) {
      return { success: false, reason: 'invalid_credentials' }
    }
    
    // Unknown error - re-throw
    throw err
  }
}



