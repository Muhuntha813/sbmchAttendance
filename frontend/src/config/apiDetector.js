// src/config/apiDetector.js
// API base URL detection and fallback logic

// Candidates to try in order
export const API_CANDIDATES = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001'
]

// Fetch with timeout helper
async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    return response
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('Request timeout')
    }
    throw err
  }
}

// Test if a candidate URL is reachable
async function testCandidate(candidate) {
  const endpoints = [
    `${candidate}/health`,
    `${candidate}/api/health`,
    `${candidate}/`
  ]

  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, { method: 'GET' }, 1500)
      if (res.ok || res.status === 404 || res.status < 500) {
        // If backend returns JSON (health payload), it's confirmed
        const contentType = res.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          console.info('[apiDetector] Health check passed for:', candidate, 'via', url)
          return true
        }
        // Even with 404, if server responded (non-HTML), treat as success
        if (!contentType.includes('text/html')) {
          console.info('[apiDetector] Server responded for:', candidate, 'via', url, 'status:', res.status)
          return true
        }
        console.info('[apiDetector] Health check passed for:', candidate, 'via', url)
        return true
      }
    } catch (err) {
      console.debug('[apiDetector] Health check failed for', url, err.message)
    }
  }

  return false
}

/**
 * Detects a working API base URL by trying candidates in order
 * @returns {Promise<string|null>} The detected API base URL or null if none found
 */
export async function detectApiBase() {
  // First check for manual override in localStorage
  const override = localStorage.getItem('API_OVERRIDE')
  if (override) {
    try {
      const isValid = await testCandidate(override)
      if (isValid) {
        console.info('[apiDetector] Using localStorage override:', override)
        return override
      } else {
        console.warn('[apiDetector] Override URL not reachable:', override)
        localStorage.removeItem('API_OVERRIDE')
      }
    } catch (e) {
      console.warn('[apiDetector] Override URL test failed:', override, e.message)
      localStorage.removeItem('API_OVERRIDE')
    }
  }

  // Check environment variables first
  const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined
  const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined
  
  if (reactApi) {
    console.info('[apiDetector] Using REACT_APP_API_URL:', reactApi)
    return reactApi
  }
  
  if (viteApi) {
    console.info('[apiDetector] Using VITE_API_URL:', viteApi)
    return viteApi
  }

  // Try candidates sequentially
  console.info('[apiDetector] Auto-detecting API base URL...')
  for (const candidate of API_CANDIDATES) {
    try {
      const isValid = await testCandidate(candidate)
      if (isValid) {
        console.info('[apiDetector] Detected API base:', candidate)
        return candidate
      }
    } catch (err) {
      // Continue to next candidate
      console.debug('[apiDetector] Candidate failed:', candidate, err.message)
    }
  }

  console.warn('[apiDetector] No working API base URL found')
  return null
}

