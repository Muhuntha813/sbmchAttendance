import React, { useEffect, useMemo, useRef, useState } from 'react'
import useAttendance from './hooks/useAttendance.js'

// =====================
// Config & Constants
// =====================
// Endpoint URLs: Change these to match your backend.
// For example: const API_BASE = 'http://localhost:3000';
// const LOGIN_URL = API_BASE + '/api/login';
// const ATTENDANCE_URL = API_BASE + '/api/attendance';
// For deployment, update BASE_URL in useAttendance (or set VITE_API env)
const TOKEN_KEY = 'ATT_TOKEN'
const THEME_KEY = 'ATT_THEME'
const REMEMBER_KEY = 'ATT_REMEMBER'
const USER_KEY = 'ATT_USERNAME'
const PASS_KEY = 'ATT_PASSWORD'
const FROM_KEY = 'ATT_FROM'
const TO_KEY = 'ATT_TO'

// =====================
// Helpers
// =====================
const formatToday = () => {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

// Compute minimal r such that ((present + r) / (total + r)) * 100 >= 75
function computeRequiredSessions(present, total) {
  // If already above threshold, none are required
  if ((total > 0 && (present / total) * 100 >= 75) || (total === 0 && present >= 0)) return 0
  const r = Math.ceil(3 * total - 4 * present)
  return Math.max(0, r)
}

// Compute how many more classes you can miss and still stay >= 75%
// Formula: max(0, floor(present / 0.75 - total))
function computeCanMissSessions(present, total) {
  if (present < 0 || total <= 0) return 0
  const threshold = 0.75
  const allowed = Math.floor(present / threshold - total)
  return Math.max(0, allowed)
}

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

// Typewriter effect for the date
function useTypewriter(text, speed = 28) {
  const [out, setOut] = useState('')
  useEffect(() => {
    setOut('')
    let i = 0
    const id = setInterval(() => {
      setOut(text.slice(0, i + 1))
      i++
      if (i >= text.length) clearInterval(id)
    }, speed)
    return () => clearInterval(id)
  }, [text, speed])
  return out
}

// Smooth animated number from 0 to target
function useAnimatedNumber(target, duration = 900) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    let start = performance.now()
    const from = 0
    const to = target
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(from + (to - from) * eased)
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [target, duration])
  return value
}

// Toast component
function Toast({ type = 'info', message, onClose }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => onClose?.(), 3500)
    return () => clearTimeout(t)
  }, [message, onClose])
  if (!message) return null
  const tone = type === 'error' ? 'bg-red-500/90' : type === 'success' ? 'bg-emerald-500/90' : 'bg-slate-700/90'
  return (
    <div className="fixed top-4 right-4 z-50">
      <div className={classNames('text-sm px-4 py-2 rounded-lg shadow-lg text-white backdrop-blur-md', tone)} role="alert">
        {message}
      </div>
    </div>
  )
}

// Progress Ring (SVG) with smooth animation
function ProgressRing({ percent }) {
  const size = 64
  const stroke = 6
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const animated = useAnimatedNumber(Math.min(100, Math.max(0, percent)), 1000)
  const offset = useMemo(() => circumference * (1 - animated / 100), [animated, circumference])
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
      <defs>
        <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={stroke}
        stroke="currentColor"
        className="text-white/15 dark:text-white/10"
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={stroke}
        stroke="url(#ringGrad)"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        fill="none"
        style={{ transition: 'stroke-dashoffset 800ms ease-out' }}
      />
    </svg>
  )
}

// =====================
// Main Component (default export)
// =====================
export default function AttendanceApp() {
  // Theme handling
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved) return saved
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // Hook manages token and data
  const {
    attendance,
    studentName,
    loading,
    authLoading,
    error,
    isFallback,
    login,
    fetchAttendance,
    logout
  } = useAttendance()

  // Routing within single file: login or dashboard
  const [view, setView] = useState(() => (localStorage.getItem(TOKEN_KEY) ? 'dashboard' : 'login'))

  // Auth form
  const savedRemember = localStorage.getItem(REMEMBER_KEY) === '1'
  const [rememberMe, setRememberMe] = useState(savedRemember)
  const [username, setUsername] = useState(() => (savedRemember ? localStorage.getItem(USER_KEY) || '' : ''))
  const [password, setPassword] = useState(() => (savedRemember ? localStorage.getItem(PASS_KEY) || '' : ''))
  const [fromDate, setFromDate] = useState(() => (savedRemember ? localStorage.getItem(FROM_KEY) || '08-10-2025' : '08-10-2025'))
  const [toDate, setToDate] = useState(() => formatToday())
  const [toast, setToast] = useState({ type: 'info', message: '' })

  // Animations
  const [animateKey, setAnimateKey] = useState(0)
  // Prevent repeated auto-focus on username across re-renders
  const didAutoFocus = useRef(false)

  const todayStr = formatToday()
  const typedDate = useTypewriter(todayStr, 20)

  // Fetch attendance when moving to dashboard
  useEffect(() => {
    if (view !== 'dashboard') return
    let mounted = true
    ;(async () => {
      const result = await fetchAttendance()
      if (!mounted) return
      if (result?.unauthorized) {
        setToast({ type: 'error', message: 'Session expired. Please login again.' })
        localStorage.removeItem(TOKEN_KEY)
        setView('login')
        return
      }
      setAnimateKey((k) => k + 1)
      if (result?.fallbackUsed) {
        setToast({ type: 'info', message: 'Demo data loaded (backend offline).' })
      }
    })()
    return () => {
      mounted = false
    }
  }, [view])

  // One-time focus on username when first landing on login view
  useEffect(() => {
    if (view === 'login' && !didAutoFocus.current) {
      const el = document.getElementById('username')
      el && el.focus()
      didAutoFocus.current = true
    }
  }, [view])

  // Handlers
  const handleLogin = async (e) => {
    e.preventDefault()
    const result = await login({ username, password, fromDate, toDate })
    // Persist credentials based on Remember Me
    if (rememberMe) {
      localStorage.setItem(REMEMBER_KEY, '1')
      localStorage.setItem(USER_KEY, username)
      localStorage.setItem(PASS_KEY, password)
      localStorage.setItem(FROM_KEY, fromDate)
      localStorage.setItem(TO_KEY, toDate)
    } else {
      localStorage.removeItem(REMEMBER_KEY)
      localStorage.removeItem(USER_KEY)
      localStorage.removeItem(PASS_KEY)
      localStorage.removeItem(FROM_KEY)
      localStorage.removeItem(TO_KEY)
    }
    if (result?.ok) {
      setToast({ type: 'success', message: 'Signed in successfully!' })
    } else {
      setToast({ type: 'info', message: 'Using demo data — backend offline.' })
    }
    setView('dashboard')
  }

  const handleLogout = () => {
    logout()
    setView('login')
    setToast({ type: 'info', message: 'You have been logged out.' })
  }

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // Skeleton cards
  const SkeletonCard = ({ idx }) => (
    <div
      className={classNames(
        'rounded-2xl p-5 backdrop-blur-xl border border-white/10',
        'bg-white/10 dark:bg-white/5 shadow-lg',
        'animate-card-enter'
      )}
      style={{ animationDelay: `${idx * 80}ms` }}
    >
      <div className="flex items-start justify-between">
        <div className="h-6 w-40 rounded-md bg-gradient-to-r from-white/10 via-white/20 to-white/10 bg-[length:200%_100%] animate-shimmer" />
        <div className="h-6 w-20 rounded-md bg-gradient-to-r from-white/10 via-white/20 to-white/10 bg-[length:200%_100%] animate-shimmer" />
      </div>
      <div className="mt-3 flex gap-2">
        <div className="h-6 w-24 rounded-full bg-gradient-to-r from-white/10 via-white/20 to-white/10 bg-[length:200%_100%] animate-shimmer" />
        <div className="h-6 w-24 rounded-full bg-gradient-to-r from-white/10 via-white/20 to-white/10 bg-[length:200%_100%] animate-shimmer" />
        <div className="h-6 w-24 rounded-full bg-gradient-to-r from-white/10 via-white/20 to-white/10 bg-[length:200%_100%] animate-shimmer" />
      </div>
      <div className="mt-6 flex items-center justify-between">
        <div className="h-10 w-28 rounded-md bg-gradient-to-r from-white/10 via-white/20 to-white/10 bg-[length:200%_100%] animate-shimmer" />
        <div className="h-16 w-16 rounded-full bg-gradient-to-r from-white/10 via-white/20 to-white/10 bg-[length:200%_100%] animate-shimmer" />
      </div>
    </div>
  )

  // Subject card
  const SubjectCard = ({ item, idx, real = true }) => {
    const present = item.present ?? 0
    const total = item.total ?? (item.present ?? 0) + (item.absent ?? 0)
    const percent = item.percent ?? (total > 0 ? (present / total) * 100 : 0)
    const required = item.required ?? computeRequiredSessions(present, total)
    const isLow = percent < 75
    const canMiss = computeCanMissSessions(present, total)
    const marginText = isLow ? `Required: ${required}` : `Margin: ${canMiss}`
    const pctAnim = useAnimatedNumber(percent, 900)

    return (
      <div
        className={classNames(
          'group rounded-2xl p-5 backdrop-blur-xl',
          'border border-white/10 bg-white/10 dark:bg-white/5 shadow-lg',
          'transition hover:shadow-xl hover:scale-[1.01]',
          real ? 'animate-fade-in-left' : 'animate-card-enter'
        )}
        style={{ animationDelay: `${idx * 80}ms` }}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white/90">{item.subject}</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">Present: {present}</span>
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-pink-500/20 text-pink-300 border border-pink-400/30">Absent: {item.absent ?? 0}</span>
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-700/30 text-slate-200 border border-white/10">Total: {total}</span>
            </div>
          </div>
          <div className="text-right">
            <div
              className={classNames(
                'text-sm font-medium',
                isLow ? 'text-red-400' : 'text-white/70'
              )}
              title={isLow ? `Need ${required} more present sessions to reach 75%.` : 'At or above 75%'}
            >
              {marginText}
            </div>
          </div>
        </div>
        <div className="mt-6 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className={classNames('text-4xl font-bold tracking-tight', isLow ? 'text-red-400' : 'text-emerald-300')}>
              {Math.round(pctAnim * 100) / 100}%
            </span>
            <span className="text-xs text-white/60">attendance</span>
          </div>
          <ProgressRing percent={percent} />
        </div>
      </div>
    )
  }

  // Layout wrappers
  const Container = ({ children }) => (
    <div className="min-h-screen px-4 py-8 md:px-8">
      <div className="mx-auto max-w-6xl">
        {children}
      </div>
    </div>
  )

  // Login Page (inline JSX to avoid remount blur)

  // Dashboard Page
  const DashboardPage = () => (
    <Container>
      <div className="flex items-center justify-between mb-6">
        {/* Left: name & date with entrance animation */}
        <div className="flex items-baseline gap-3">
          <h2 key={`name-${animateKey}`} className="text-2xl font-bold text-white/90 animate-fade-in-left">{studentName}</h2>
          <span key={`date-${animateKey}`} className="text-sm text-white/60 animate-type-in">{typedDate}</span>
        </div>
        {/* Right: actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-lg px-3 py-2 text-sm bg-white/10 border border-white/10 text-white/80 hover:bg-white/15"
            aria-label="Toggle dark mode"
          >
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg px-3 py-2 text-sm bg-red-500/20 border border-red-400/30 text-red-200 hover:bg-red-500/30"
            aria-label="Logout"
          >
            Logout
          </button>
        </div>
      </div>
      {isFallback && (
        <div className="mb-4 rounded-lg border border-yellow-400/30 bg-yellow-500/10 text-yellow-200 px-3 py-2 text-sm">
          Demo Data (Backend offline)
        </div>
      )}
      {/* Cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {loading && Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} idx={i} />)}
        {!loading && attendance?.length > 0 && attendance.map((item, idx) => (
          <SubjectCard item={item} key={item.subject + idx} idx={idx} real={!isFallback} />
        ))}
        {!loading && attendance?.length === 0 && (
          <div className="col-span-full text-center text-white/70">
            No attendance data available.
          </div>
        )}
      </div>
    </Container>
  )

  return (
    <div className="relative">
      { view === 'dashboard' && loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onMouseDown={(e)=>e.stopPropagation()}>
          <div className="p-5 rounded-xl bg-white/10 text-center">
            <div className="animate-spin mx-auto h-8 w-8 border-4 border-t-transparent border-white/70 rounded-full"></div>
            <div className="mt-3 text-sm text-gray-200">Fetching real attendance...</div>
          </div>
        </div>
      )}
      {/* Decorative shapes only on dashboard to avoid clutter on login */}
      {view === 'dashboard' && (
        <>
          <div className="pointer-events-none absolute -top-32 -left-16 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-cyan-500/20 blur-3xl" />
        </>
      )}
      {/* App Views */}
      {view === 'login' ? (
        <div className="min-h-screen px-4 py-8 md:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-md">
              {/* Header row with right-aligned theme toggle */}
              <div className="mb-6 flex items-center justify-between">
                <div className="text-left">
                  <h1 className="text-3xl font-bold text-white/90">SBMCH Attendance</h1>
                  <p className="mt-1 text-sm text-white/60">Glassy dashboard — sign in to view your details</p>
                </div>
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="inline-flex items-center rounded-lg px-3 py-2 text-sm bg-white/10 border border-white/10 text-white/80 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  aria-label="Toggle dark mode"
                >
                  {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                </button>
              </div>
              <form
                onSubmit={handleLogin}
                className="rounded-2xl p-6 backdrop-blur-xl bg-white/10 dark:bg-white/5 border border-white/10 shadow-lg"
                onMouseDown={(e)=>e.stopPropagation()}
              >
                <div className="mb-4">
                  <label htmlFor="username" className="block text-sm font-medium text-white/80">Username</label>
                  <input
                    id="username"
                    type="text"
                    aria-label="Username"
                    value={username}
                    onFocus={(e)=>e.stopPropagation()}
                    onChange={(e) => setUsername(() => e.target.value)}
                    autoComplete="off"
                    spellCheck="false"
                    inputMode="text"
                    className="mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    placeholder="Enter username"
                    required
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="password" className="block text-sm font-medium text-white/80">Password</label>
                  <input
                    id="password"
                    type="password"
                    aria-label="Password"
                    value={password}
                    onFocus={(e)=>e.stopPropagation()}
                    onChange={(e) => setPassword(() => e.target.value)}
                    autoComplete="off"
                    spellCheck="false"
                    inputMode="text"
                    className="mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    placeholder="Enter password"
                    required
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fromDate" className="block text-sm font-medium text-white/80">From Date</label>
                    <input
                      id="fromDate"
                      type="text"
                      aria-label="From Date in DD-MM-YYYY"
                      value={fromDate}
                      onFocus={(e)=>e.stopPropagation()}
                      onChange={(e) => setFromDate(() => e.target.value)}
                      inputMode="numeric"
                      autoComplete="off"
                      spellCheck="false"
                      className="mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="DD-MM-YYYY"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="toDate" className="block text-sm font-medium text-white/80">To Date</label>
                    <input
                      id="toDate"
                      type="text"
                      aria-label="To Date in DD-MM-YYYY"
                      value={toDate}
                      onFocus={(e)=>e.stopPropagation()}
                      onChange={(e) => setToDate(() => e.target.value)}
                      inputMode="numeric"
                      autoComplete="off"
                      spellCheck="false"
                      className="mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="DD-MM-YYYY"
                      required
                    />
                  </div>
                </div>
                <label className="mt-3 inline-flex items-center gap-2 text-white/80">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 rounded border-white/20 bg-white/10"
                  />
                  <span className="text-sm">Remember me (stores credentials locally)</span>
                </label>
                {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
                <button
                  type="submit"
                  className={classNames(
                    'mt-6 w-full rounded-lg px-4 py-2.5 text-white font-semibold',
                    'bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-400',
                    authLoading && 'opacity-60 cursor-not-allowed'
                  )}
                  aria-busy={authLoading}
                >
                  {authLoading ? 'Signing In…' : 'Sign In'}
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : <DashboardPage />}
      <Toast type={toast.type} message={toast.message} onClose={() => setToast({ type: 'info', message: '' })} />
    </div>
  )
}