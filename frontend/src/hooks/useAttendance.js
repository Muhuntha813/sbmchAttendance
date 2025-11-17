import { useCallback, useState } from 'react'
import { detectApiBase } from '../config/apiDetector.js'

// Token storage key
const TOKEN_KEY = 'ATT_TOKEN'

export default function useAttendance() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '')
  const [studentName, setStudentName] = useState('')
  const [attendance, setAttendance] = useState([])
  const [upcomingClasses, setUpcomingClasses] = useState([])
  const [loading, setLoading] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [error, setError] = useState('')
  const [isFallback, setIsFallback] = useState(false)

  const login = useCallback(async ({ username, password, fromDate, toDate }) => {
    setAuthLoading(true)
    setError('')
    // Declare apiBase outside try block so it's accessible in catch
    let apiBase = null
    try {
      // Try env or autodetect
      const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined
      const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined
      apiBase = reactApi || viteApi
      
      if (!apiBase) {
        apiBase = await detectApiBase()
      }

      if (!apiBase) {
        // Return structured failure so UI can show input box
        // This should only happen if detection completely fails
        const errorMsg = 'Verification service unavailable. Please ensure the backend is running. Click "Set Backend" to enter URL.'
        setError(errorMsg)
        return { ok: false, success: false, error: 'api_unreachable', message: errorMsg }
      }

      console.log('[login] Using API base:', apiBase)

      const url = `${apiBase}/api/auth/login`
      console.log('[login] Attempting login to:', url)
      console.log('[login] API base:', apiBase)
      console.log('[login] Student ID:', username)
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id: username, password })
      })
      
      // Parse response text first, then try JSON
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch (e) {
        data = { raw: text }
      }
      
      console.log('[login] response status:', res.status)
      console.log('[login] response data:', data)
      
      if (!res.ok) {
        // Map errors to friendly messages
        if (res.status === 429) {
          const errorMsg = 'Too many login attempts. Please wait a minute and try again.'
          setError(errorMsg)
          return { ok: false, success: false, error: 'rate_limit_exceeded', message: errorMsg }
        }
        if (res.status === 404) {
          const errorMsg = 'Student ID not found. Check your ID.'
          setError(errorMsg)
          return { ok: false, success: false, error: 'student_not_found', message: errorMsg }
        }
        if (res.status === 502) {
          if (data?.error === 'database_unavailable') {
            const errorMsg = 'Database connection failed. Please contact support.'
            setError(errorMsg)
            return { ok: false, success: false, error: 'database_unavailable', message: errorMsg }
          }
          if (data?.error === 'lms_unavailable' || data?.error === 'scraper_unavailable') {
            const errorMsg = data?.message || 'Verification service unavailable. Try again later.'
            setError(errorMsg)
            return { ok: false, success: false, error: 'lms_unavailable', message: errorMsg }
          }
          // Generic 502 error
          const errorMsg = data?.message || 'Service temporarily unavailable. Try again later.'
          setError(errorMsg)
          return { ok: false, success: false, error: 'service_unavailable', message: errorMsg }
        }
        if (res.status === 401) {
          const errorMsg = 'Invalid credentials.'
          setError(errorMsg)
          return { ok: false, success: false, error: 'invalid_credentials', message: errorMsg }
        }
        if (res.status === 402) {
          if (data?.error === 'trial_expired') {
            // Return payment redirect - App.jsx will handle navigation
            return { ok: false, success: false, error: 'trial_expired', message: data?.message || 'Your free trial has ended. Please subscribe to continue.', paymentRedirect: true }
          }
          if (data?.error === 'subscription_expired') {
            // Return payment redirect - App.jsx will handle navigation
            return { ok: false, success: false, error: 'subscription_expired', message: data?.message || 'Your subscription has expired. Please renew to continue.', paymentRedirect: true }
          }
        }
        // Generic error handling
        const errorMsg = data?.error || data?.message || 'Login failed'
        setError(errorMsg)
        setIsFallback(true)
        return { ok: false, success: false, error: errorMsg, message: errorMsg }
      }
      
      if (!data.token) {
        const errorMsg = 'No token received from server.'
        setError(errorMsg)
        setIsFallback(true)
        return { ok: false, success: false, error: 'no_token', message: errorMsg }
      }
      
      // Success - store token and navigate
      localStorage.setItem(TOKEN_KEY, data.token)
      setToken(data.token)
      setIsFallback(false)
      return { ok: true, success: true, token: data.token, user: data.user }
    } catch (err) {
      // Network error or server unreachable
      const msg = (err && err.message) ? err.message : 'Network or server error'
      console.error('[login] Network error:', msg)
      console.error('[login] Error details:', err)
      console.error('[login] API base was:', apiBase)
      
      // Only show "api_unreachable" (which triggers modal) if we truly couldn't detect the backend
      // If we have an apiBase, it means detection succeeded, so this is a different error
      const isConnectionRefused = msg.includes('Failed to fetch') || 
                                  msg.includes('NetworkError') || 
                                  msg.includes('ERR_CONNECTION_REFUSED') || 
                                  msg.includes('ERR_NETWORK') ||
                                  msg.includes('fetch failed')
      
      // If we have an apiBase but connection fails, it's likely:
      // 1. Backend went down after detection
      // 2. CORS issue
      // 3. Wrong port/URL
      // Don't show modal in this case - show a regular error instead
      if (isConnectionRefused && !apiBase) {
        // Only show modal if we truly couldn't detect
        const errorMsg = 'Verification service unavailable. Please ensure the backend is running. Click "Set Backend" to enter URL.'
        setError(errorMsg)
        return { ok: false, success: false, error: 'api_unreachable', message: errorMsg }
      } else if (isConnectionRefused) {
        // We detected an API base but connection failed - backend might be down or wrong URL
        const errorMsg = `Cannot connect to backend at ${apiBase}. Please check if the server is running or use "Set Backend" to change the URL.`
        setError(errorMsg)
        return { ok: false, success: false, error: 'connection_failed', message: errorMsg }
      }
      
      // Other network errors
      setError(msg)
      setIsFallback(true)
      return { ok: false, success: false, error: 'network_error', message: msg }
    } finally {
      setAuthLoading(false)
    }
  }, [])

  // Replace fetchAttendance with polling-based approach to prioritize real data
  const fetchAttendance = useCallback(async (t = token) => {
    setLoading(true)
    setError('') // Clear error at start
    setIsFallback(false)

    if (!t) {
      // Don't set error here - just return unauthorized
      // The error will be handled by the caller
      setLoading(false)
      return { unauthorized: true }
    }

    // Get API base URL (use cached or detect)
    const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined
    const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined
    let apiBase = reactApi || viteApi || localStorage.getItem('API_OVERRIDE') || 'http://localhost:3000'

    // local helper to compute required sessions to reach 75%
    const computeRequired = (present, total) => {
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

    // Retry many times to wait for scraper to finish (scraping can take 30-60 seconds)
    // Use longer backoff to give scraper time: 2s, 4s, 6s, 8s, 10s, 12s, 14s, 16s, 18s, 20s
    const MAX_TRIES = 10
    const INTERVAL_MS = 2000 // Base interval, will multiply by attempt number
    let attempt = 0
    let lastErr = null
    let earlyNetworkFail = false

    while (attempt < MAX_TRIES) {
      attempt++
      try {
        const attendanceUrl = `${apiBase}/api/attendance`
        const resp = await fetch(attendanceUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${t}` }
        })

        // Handle 202 (Pending) - data not ready yet, should poll
        if (resp.status === 202) {
          const pendingData = await resp.json().catch(() => ({}))
          console.log(`[useAttendance] attempt ${attempt}/${MAX_TRIES} received 202 (Pending) - scraper still running, will retry...`, pendingData)
          lastErr = new Error('Attendance pending, retrying')
          // Continue to next attempt (don't treat as failure yet)
        } else if (!resp.ok) {
          console.warn('[useAttendance] attempt', attempt, 'failed status', resp.status)
          // If unauthorized, stop early and let caller handle re-login.
          // Don't set error state - just return unauthorized flag
          if (resp.status === 401) {
            setLoading(false)
            setError('') // Clear any previous errors
            return { unauthorized: true }
          }
          // If trial expired (402), redirect to /pay
          if (resp.status === 402) {
            try {
              const body = await resp.json().catch(() => ({}))
              if (body?.error === 'trial_expired' || body?.error === 'subscription_expired') {
                // Return payment redirect flag - App.jsx will handle the redirect
                setLoading(false)
                setError('') // Clear any previous errors
                return { paymentRedirect: true, error: body?.error, message: body?.message }
              }
            } catch {}
            // If 402 but not trial_expired/subscription_expired, treat as unauthorized
            setLoading(false)
            setError('') // Clear any previous errors
            return { unauthorized: true }
          }
          lastErr = new Error(`Attendance fetch failed (${resp.status})`)
        } else {
          // Status 200 - check if data is valid
          const data = await resp.json()
          console.log('[useAttendance] attempt', attempt, 'received data:', { 
            hasAttendance: !!data.attendance, 
            attendanceLength: data.attendance?.length || 0,
            studentName: data.studentName,
            status: 'ok'
          })
          const list = data.attendance || []
          if (Array.isArray(list) && list.length > 0) {
            const mapped = list.map(s => {
              const percent = typeof s.percent === 'number' ? +s.percent : (s.total ? +((s.present / s.total) * 100).toFixed(2) : 0)
              const required = typeof s.required === 'number' ? s.required : computeRequired(s.present, s.total)
              const margin = +(percent - 75).toFixed(2)
              return { ...s, percent, required, margin }
            })
            setStudentName(data.studentName || '')
            setAttendance(mapped)
            setUpcomingClasses(Array.isArray(data.upcomingClasses) ? data.upcomingClasses : [])
            setLoading(false)
            return { records: mapped, fallbackUsed: false }
          } else {
            console.log('[useAttendance] attempt', attempt, 'empty attendance, retrying...')
            lastErr = new Error('Empty attendance, retrying')
          }
        }
      } catch (err) {
        console.warn('[useAttendance] fetch error attempt', attempt, err.message)
        lastErr = err
        // Fast-fallback on clear network errors.
        const msg = String(err?.message || '')
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_CONNECTION_REFUSED')) {
          earlyNetworkFail = true
          break
        }
      }

      // Longer backoff to give scraper time: 2s, 4s, 6s, 8s, 10s, 12s, 14s, 16s, 18s, 20s
      // Total wait time: ~110 seconds (almost 2 minutes) - enough for slow scrapes
      if (!earlyNetworkFail && attempt < MAX_TRIES) {
        const backoffMs = attempt * INTERVAL_MS
        console.log(`[useAttendance] Waiting ${backoffMs / 1000}s before attempt ${attempt + 1}... (scraper may take 30-60s)`)
        await new Promise(r => setTimeout(r, backoffMs))
      }
    }

    console.warn('[useAttendance] polling failed, using fallback after', attempt, 'tries:', lastErr && lastErr.message)
    // apiBase is used in the closure above
    setIsFallback(true)
    try {
      const sample = await fetch('/sampleAttendance.json').then(r => r.json())
      setStudentName(sample.studentName || '')
      setAttendance(sample.attendance || [])
      setUpcomingClasses(Array.isArray(sample.upcomingClasses) ? sample.upcomingClasses : [])
    } catch (e) {
      setError('Failed to load fallback data')
    } finally {
      setLoading(false)
      return { fallbackUsed: true }
    }
  }, [token])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken('')
    setAttendance([])
    setStudentName('')
    setError('') // Clear error on logout
    setIsFallback(false)
  }, [])

  // Clear error function for external use
  const clearError = useCallback(() => {
    setError('')
  }, [])

  return {
    BASE_URL: null, // Will be detected dynamically
    token,
    studentName,
    attendance,
    upcomingClasses,
    loading,
    authLoading,
    error,
    isFallback,
    login,
    fetchAttendance,
    logout,
    clearError
  }
}