import { useCallback, useState } from 'react'

// Base URL for backend API
// Update to your deployment domain or set Vite env: VITE_API
const BASE_URL = (import.meta.env?.VITE_API) || 'http://localhost:3000'
const TOKEN_KEY = 'ATT_TOKEN'
const LOGIN_URL = `${BASE_URL}/api/login`
const ATTENDANCE_URL = `${BASE_URL}/api/attendance`

export default function useAttendance() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '')
  const [studentName, setStudentName] = useState('')
  const [attendance, setAttendance] = useState([])
  const [loading, setLoading] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [error, setError] = useState('')
  const [isFallback, setIsFallback] = useState(false)

  const login = useCallback(async ({ username, password, fromDate, toDate }) => {
    setAuthLoading(true)
    setError('')
    try {
      const res = await fetch(LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, fromDate, toDate })
      })
      const data = await res.json().catch(() => ({}))
      console.log('[login] response', data)
      if (!res.ok) {
        // If backend rejects, we still allow UI to continue and use fallback later
        setError(data?.error || 'Login failed')
        setIsFallback(true)
        return { ok: false }
      }
      const tok = data?.token
      if (!tok) {
        setIsFallback(true)
        return { ok: false }
      }
      localStorage.setItem(TOKEN_KEY, tok)
      setToken(tok)
      setIsFallback(false)
      return { ok: true }
    } catch (err) {
      console.error('[fetch error]', err)
      setError(err.message || 'Login failed')
      setIsFallback(true)
      return { ok: false }
    } finally {
      setAuthLoading(false)
    }
  }, [])

  // Replace fetchAttendance with polling-based approach to prioritize real data
  const fetchAttendance = useCallback(async (t = token) => {
    setLoading(true)
    setError('')
    setIsFallback(false)

    if (!t) {
      setError('No token available')
      setLoading(false)
      return
    }

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

    const MAX_TRIES = 10
    const INTERVAL_MS = 2000
    let attempt = 0
    let lastErr = null

    while (attempt < MAX_TRIES) {
      attempt++
      try {
        const resp = await fetch(ATTENDANCE_URL, {
          method: 'GET',
          headers: { Authorization: `Bearer ${t}` }
        })

        if (!resp.ok) {
          console.warn('[useAttendance] attempt', attempt, 'failed status', resp.status)
          lastErr = new Error(`Attendance fetch failed (${resp.status})`)
        } else {
          const data = await resp.json()
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
            setLoading(false)
            return mapped
          } else {
            console.log('[useAttendance] attempt', attempt, 'empty attendance, retrying...')
            lastErr = new Error('Empty attendance, retrying')
          }
        }
      } catch (err) {
        console.warn('[useAttendance] fetch error attempt', attempt, err.message)
        lastErr = err
      }

      if (attempt < MAX_TRIES) await new Promise(r => setTimeout(r, INTERVAL_MS))
    }

    console.warn('[useAttendance] polling failed, using fallback after', MAX_TRIES, 'tries:', lastErr && lastErr.message)
    setIsFallback(true)
    try {
      const sample = await fetch('/sampleAttendance.json').then(r => r.json())
      setStudentName(sample.studentName || '')
      setAttendance(sample.attendance || [])
    } catch (e) {
      setError('Failed to load fallback data')
    } finally {
      setLoading(false)
    }
  }, [token])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken('')
    setAttendance([])
    setStudentName('')
    setIsFallback(false)
  }, [])

  return {
    BASE_URL,
    token,
    studentName,
    attendance,
    loading,
    authLoading,
    error,
    isFallback,
    login,
    fetchAttendance,
    logout
  }
}