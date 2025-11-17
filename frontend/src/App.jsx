import React, { useEffect, useMemo, useRef, useState } from 'react'
import useAttendance from './hooks/useAttendance.js'

// =====================
// Config & Constants
// =====================
// API configuration is centralized in src/config/api.js
// Set VITE_API_URL environment variable to configure the backend URL
// Default: http://localhost:3000
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
          <stop offset="0%" stopColor="var(--ring-1, var(--accent-1, #22d3ee))" />
          <stop offset="100%" stopColor="var(--ring-2, var(--accent-2, #6366f1))" />
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
  // Theme handling: three themes
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY)
    // Migrate old values 'dark'/'light' if present
    if (saved === 'dark') return 'cool-down-buddy'
    if (saved === 'light') return 'daylight-bliss'
    return saved || 'cool-down-buddy'
  })

  useEffect(() => {
    const darkThemes = ['cool-down-buddy', 'midnight-drift']
    const themeClassMap = {
      'cool-down-buddy': 'theme-cool',
      'midnight-drift': 'theme-midnight',
      'daylight-bliss': 'theme-daylight'
    }
    // Dark mode toggle for Tailwind
    const isDark = darkThemes.includes(theme)
    document.documentElement.classList.toggle('dark', isDark)
    // Switch body theme class
    document.body.classList.remove('theme-cool', 'theme-midnight', 'theme-daylight')
    document.body.classList.add(themeClassMap[theme] || 'theme-cool')
    // Accent colors per theme
    if (theme === 'cool-down-buddy') {
      document.body.style.setProperty('--accent-1', '#22d3ee')
      document.body.style.setProperty('--accent-2', '#6366f1')
    } else if (theme === 'midnight-drift') {
      document.body.style.setProperty('--accent-1', '#8b5cf6')
      document.body.style.setProperty('--accent-2', '#0ea5e9')
    } else {
      document.body.style.setProperty('--accent-1', '#f59e0b')
      document.body.style.setProperty('--accent-2', '#ef4444')
    }
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // Theme helpers for conditional light/dark UI tweaks
  const isDarkTheme = ['cool-down-buddy', 'midnight-drift'].includes(theme)

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
    logout,
    upcomingClasses,
    clearError
  } = useAttendance()

  // Routing within single file: login, dashboard, pay, or about
  // Always start with login - we'll validate token and redirect if valid
  const [view, setView] = useState('login')
  const [isValidatingToken, setIsValidatingToken] = useState(true)

  // Auth form
  const savedRemember = localStorage.getItem(REMEMBER_KEY) === '1'
  const [rememberMe, setRememberMe] = useState(savedRemember)
  const [username, setUsername] = useState(() => (savedRemember ? localStorage.getItem(USER_KEY) || '' : ''))
  const [password, setPassword] = useState(() => (savedRemember ? localStorage.getItem(PASS_KEY) || '' : ''))
  const [showPassword, setShowPassword] = useState(false)
  const [fromDate, setFromDate] = useState(() => (savedRemember ? localStorage.getItem(FROM_KEY) || '08-10-2025' : '08-10-2025'))
  const [toDate, setToDate] = useState(() => formatToday())
  const [toast, setToast] = useState({ type: 'info', message: '' })
  const [showBackendModal, setShowBackendModal] = useState(false)
  const [backendUrl, setBackendUrl] = useState(() => localStorage.getItem('API_OVERRIDE') || 'http://localhost:3000')

  // Animations
  const [animateKey, setAnimateKey] = useState(0)
  // Prevent repeated auto-focus on username across re-renders
  const didAutoFocus = useRef(false)
  // Guard to prevent duplicate attendance fetches (e.g., React StrictMode)
  const isFetching = useRef(false)
  const didFetchOnce = useRef(false)

  const todayStr = formatToday()
  const typedDate = useTypewriter(todayStr, 20)

  // Validate token on initial mount before redirecting to dashboard
  useEffect(() => {
    const validateTokenAndRedirect = async () => {
      const storedToken = localStorage.getItem(TOKEN_KEY)
      if (!storedToken) {
        setIsValidatingToken(false)
        return
      }

      // Get API base URL
      const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined
      const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined
      const apiBase = reactApi || viteApi || localStorage.getItem('API_OVERRIDE') || 'http://localhost:3000'

      try {
        // Validate token using status endpoint
        const statusResp = await fetch(`${apiBase}/api/auth/status`, {
          headers: { 'Authorization': `Bearer ${storedToken}` }
        })

        if (statusResp.ok) {
          // Token is valid - redirect to dashboard
          const statusData = await statusResp.json()
          if (statusData.subscription_status === 'trial' || statusData.subscription_status === 'active') {
            setView('dashboard')
          } else if (statusData.subscription_status === 'expired') {
            // Trial/subscription expired - go to payment page
            setView('pay')
          } else {
            // Unknown status - go to login
            localStorage.removeItem(TOKEN_KEY)
            setView('login')
          }
        } else {
          // Token is invalid or expired - remove it and stay on login
          localStorage.removeItem(TOKEN_KEY)
          setView('login')
        }
      } catch (err) {
        // Network error or backend unavailable - remove token and stay on login
        console.log('[App] Token validation failed, staying on login:', err.message)
        localStorage.removeItem(TOKEN_KEY)
        setView('login')
      } finally {
        setIsValidatingToken(false)
      }
    }

    validateTokenAndRedirect()
  }, []) // Run only once on mount

  // Fetch attendance when moving to dashboard - ALWAYS check on every load/refresh
  // This ensures trial/subscription expiry is checked on every request
  useEffect(() => {
    // Don't fetch if we're still validating the token
    if (isValidatingToken) {
      return
    }

    if (view !== 'dashboard') {
      // Reset guards when leaving dashboard
      isFetching.current = false
      didFetchOnce.current = false
      return
    }
    
    // Check if token exists before attempting fetch
    const storedToken = localStorage.getItem(TOKEN_KEY)
    if (!storedToken) {
      // No token, go to login without showing error (initial load)
      setView('login')
      return
    }

    // Prevent concurrent fetches but allow new fetches on refresh/view change
    if (isFetching.current) {
      console.log('[dashboard] Fetch already in progress, skipping...')
      return
    }

  // Only fetch on dashboard view - NOT on payment page (prevents demo data fallback)
  if (view !== 'dashboard') {
    return
  }
  
  // Always fetch on dashboard view to check trial/subscription expiry
  // This ensures expiry is checked on every page load/refresh
  isFetching.current = true
  ;(async () => {
    try {
      console.log('[dashboard] fetchAttendance:start - checking trial/subscription status')
      const result = await fetchAttendance()
        if (result?.paymentRedirect) {
          // Trial or subscription expired - redirect to payment page
          console.log('[dashboard] Trial/subscription expired, redirecting to payment')
          clearError() // Clear any error before switching to payment page
          setView('pay')
          return
        }
        if (result?.unauthorized) {
          // Only show session expired if we actually had a token (not initial load)
          const hadToken = localStorage.getItem(TOKEN_KEY)
          if (hadToken) {
            setToast(prev => {
              const newToast = { type: 'error', message: 'Session expired. Please login again.' }
              // Only update if different
              if (prev.type === newToast.type && prev.message === newToast.message) return prev
              return newToast
            })
          }
          localStorage.removeItem(TOKEN_KEY)
          clearError() // Clear error before switching to login
          setView('login')
          return
        }
        // Success - update UI
        if (result?.records || result?.fallbackUsed) {
          didFetchOnce.current = true
          setAnimateKey((k) => k + 1)
          if (result?.fallbackUsed) {
            setToast(prev => {
              const newToast = { type: 'info', message: 'Demo data loaded (backend offline).' }
              // Only update if different
              if (prev.type === newToast.type && prev.message === newToast.message) return prev
              return newToast
            })
          }
        }
        console.log('[dashboard] fetchAttendance:done')
      } finally {
        isFetching.current = false
      }
    })()
  }, [view, fetchAttendance, clearError, isValidatingToken])

  // Prevent fetchAttendance from running on payment page
  useEffect(() => {
    if (view === 'pay') {
      // Don't fetch attendance on payment page - it causes fallback to demo data
      isFetching.current = false
    }
  }, [view])

  // Clear error and focus username when landing on login view
  useEffect(() => {
    if (view === 'login') {
      // Clear any errors from previous attempts or dashboard
      clearError()
      // Clear toast after a short delay to allow user to see it if needed
      const timer = setTimeout(() => {
        setToast(prev => {
          if (prev.type === 'info' && prev.message === '') return prev
          return { type: 'info', message: '' }
        })
      }, 100)
      if (!didAutoFocus.current) {
        const el = document.getElementById('username')
        el && el.focus()
        didAutoFocus.current = true
      }
      return () => clearTimeout(timer)
    }
    // clearError is stable from useAttendance hook (useCallback), safe to include
  }, [view, clearError])

  // Handlers
  const handleLogin = async (e) => {
    e.preventDefault()
    console.log('[handleLogin] submitted')
    clearError() // Clear any previous errors before attempting login
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
    if (result?.ok && result?.success) {
      console.log('[handleLogin] success')
      setToast({ type: 'success', message: 'Signed in successfully!' })
      setView('dashboard')
    } else if (result?.paymentRedirect) {
      // Trial or subscription expired - redirect to payment page
      clearError() // Clear any error before switching to payment page
      setView('pay')
    } else {
      // Login failed - stay on login page and show error
      if (result?.error === 'api_unreachable' || result?.error === 'connection_failed') {
        // Show backend override UI for unreachable or connection failed errors
        setShowBackendModal(true)
      } else if (result?.error) {
        // Error already displayed via setError in login function
        console.log('[handleLogin] failed:', result.error, result.message)
        // Show toast with the error message if available
        if (result.message) {
          setToast({ type: 'error', message: result.message })
        } else {
          setToast({ type: 'error', message: 'Login failed. Please try again.' })
        }
      } else {
        console.log('[handleLogin] unknown error state:', result)
        setToast({ type: 'error', message: 'Login failed. Please try again.' })
      }
      // Don't navigate to dashboard on failure
    }
  }

  const handleSetBackend = () => {
    if (backendUrl.trim()) {
      localStorage.setItem('API_OVERRIDE', backendUrl.trim())
      setShowBackendModal(false)
      // Retry login - create a mock event object
      const mockEvent = { preventDefault: () => {} }
      handleLogin(mockEvent)
    }
  }

  const handleLogout = () => {
    logout()
    setView('login')
    didFetchOnce.current = false
    setToast({ type: 'info', message: 'You have been logged out.' })
  }

  const ThemeSelect = () => {
    const [open, setOpen] = useState(false)
    const btnRef = useRef(null)
    const menuRef = useRef(null)
    const isDark = ['cool-down-buddy', 'midnight-drift'].includes(theme)
    const btnCls = isDark
      ? 'rounded-lg px-3 py-2 text-sm bg-white/10 border border-white/10 text-white/80 hover:bg-white/15'
      : 'rounded-lg px-3 py-2 text-sm bg-white/70 border border-slate-300 text-slate-800 hover:bg-white/80'

    useEffect(() => {
      const onDocClick = (e) => {
        if (!menuRef.current || !btnRef.current) return
        if (!menuRef.current.contains(e.target) && !btnRef.current.contains(e.target)) {
          setOpen(false)
        }
      }
      document.addEventListener('mousedown', onDocClick)
      return () => document.removeEventListener('mousedown', onDocClick)
    }, [])

    const options = [
      { value: 'cool-down-buddy', label: 'Cool Down Buddy' },
      { value: 'midnight-drift', label: 'Midnight Drift' },
      { value: 'daylight-bliss', label: 'Daylight Bliss' }
    ]

    const menuCls = isDark
      ? 'absolute right-0 mt-1 w-56 rounded-lg shadow-lg border border-slate-700 bg-slate-800 text-slate-100 z-50'
      : 'absolute right-0 mt-1 w-56 rounded-lg shadow-lg border border-slate-300 bg-white text-slate-800 z-50'
    const itemCls = isDark
      ? 'px-3 py-2 hover:bg-slate-700 cursor-pointer'
      : 'px-3 py-2 hover:bg-slate-100 cursor-pointer'

    const currentLabel = options.find(o => o.value === theme)?.label || 'Theme'

    return (
      <div className="relative z-40 select-none">
        <button
          ref={btnRef}
          type="button"
          className={btnCls + ' flex items-center gap-2'}
          onClick={() => setOpen(o => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span>{currentLabel}</span>
          <svg className="h-4 w-4 opacity-70" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.25 8.29a.75.75 0 01-.02-1.08z" />
          </svg>
        </button>
        {open && (
          <ul ref={menuRef} role="listbox" className={menuCls}>
            {options.map(opt => (
              <li
                key={opt.value}
                role="option"
                aria-selected={theme === opt.value}
                className={itemCls + (theme === opt.value ? ' bg-[var(--accent-1)]/10' : '')}
                onClick={() => { setTheme(opt.value); setOpen(false) }}
              >
                {opt.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  // Upcoming Classes UI
  const UpcomingCard = React.memo(({ item, idx }) => (
    <div
      className={classNames(
        'rounded-2xl p-5 backdrop-blur-xl border border-white/10',
        'bg-white/10 dark:bg-white/5 shadow-lg',
        'animate-card-enter'
      )}
      style={{ animationDelay: `${idx * 80}ms` }}
    >
      <div className="flex items-start gap-4">
        {item.avatar && <img src={item.avatar} alt="avatar" loading="lazy" className="h-10 w-10 rounded-full border border-white/10 object-cover" />}
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-white/90">{item.title || 'Class'}</h3>
            {item.time && <span className="text-xs text-white/60">{item.time}</span>}
          </div>
          {item.subtitle && <div className="mt-1 text-xs text-white/70">{item.subtitle}</div>}
          {item.location && <div className="mt-2 text-xs text-white/60">Location: {item.location}</div>}
        </div>
      </div>
    </div>
  ))

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
  const SubjectCard = React.memo(function SubjectCard({ item, idx, real = true, theme }) {
    const present = item.present ?? 0
    const total = item.total ?? (item.present ?? 0) + (item.absent ?? 0)
    const percent = item.percent ?? (total > 0 ? (present / total) * 100 : 0)
    const required = item.required ?? computeRequiredSessions(present, total)
    const isLow = percent < 75
    const canMiss = computeCanMissSessions(present, total)
    const marginText = isLow ? `Required: ${required}` : `Margin: ${canMiss}`
    const pctAnim = useAnimatedNumber(percent, 900)
    const isDarkTheme = ['cool-down-buddy', 'midnight-drift'].includes(theme)
    const ringColors = isLow
      ? ['#F87171', '#DC2626'] // red gradient for critical
      : (theme === 'daylight-bliss'
          ? ['#14B8A6', '#0D9488'] // teal for light theme
          : ['#34D399', '#10B981']) // green for dark themes

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
            <span className={classNames(
              'text-4xl font-bold tracking-tight',
              isLow ? 'text-red-600' : (theme === 'daylight-bliss' ? 'text-teal-700' : 'text-emerald-300')
            )}>
              {Math.round(pctAnim * 100) / 100}%
            </span>
            <span className="text-xs text-white/60">attendance</span>
          </div>
          <div style={{ '--ring-1': ringColors[0], '--ring-2': ringColors[1] }}>
            <ProgressRing percent={percent} />
          </div>
        </div>
      </div>
    )
  })

  // Layout wrappers
  const Container = ({ children }) => (
    <div className="min-h-screen px-4 py-8 md:px-8">
      <div className="mx-auto max-w-6xl">
        {children}
      </div>
    </div>
  )

  // About Page Component
  const AboutPage = React.memo(() => {
    const handleWhatsAppSupport = () => {
      const supportNumber = '917845689813' // +91 78456 89813
      const message = encodeURIComponent('Hello, I need support with the SBMCH Attendance website.')
      window.open(`https://wa.me/${supportNumber}?text=${message}`, '_blank')
    }

    return (
      <Container>
        <div className="max-w-3xl mx-auto">
          <div className={classNames(
            'rounded-2xl p-8 backdrop-blur-xl border border-white/10',
            'bg-white/10 dark:bg-white/5 shadow-lg',
            'animate-fade-in'
          )}>
            <div className="flex items-center justify-between mb-6">
              <h1 className={classNames(
                'text-3xl font-bold',
                isDarkTheme ? 'text-white/90' : 'text-slate-900'
              )}>
                About
              </h1>
              <button
                onClick={() => {
                  const hadToken = localStorage.getItem(TOKEN_KEY)
                  setView(hadToken ? 'dashboard' : 'login')
                }}
                className={classNames(
                  'px-4 py-2 rounded-lg font-medium transition-colors',
                  isDarkTheme
                    ? 'bg-white/10 hover:bg-white/20 text-white/80 border border-white/20'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300'
                )}
              >
                ← Back
              </button>
            </div>
            
            <div className="space-y-6 text-sm leading-relaxed">
              <div>
                <p className={classNames(
                  'mb-3',
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  This website is a <strong>student-made tool</strong> created to make daily life easier for SBMCH students.
                </p>
                <p className={classNames(
                  'font-semibold mb-2',
                  isDarkTheme ? 'text-white/90' : 'text-slate-800'
                )}>
                  Our purpose is simple:
                </p>
                <p className={classNames(
                  'italic mb-3',
                  isDarkTheme ? 'text-white/70' : 'text-slate-600'
                )}>
                  to help students quickly access important information, track academics, and enjoy their student life with less stress.
                </p>
                <p className={classNames(
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  This platform is built for convenience, comfort, and speed so you don't have to waste time navigating multiple portals. Everything here is designed by students, for students—to make student life smoother, lighter, and more enjoyable.
                </p>
              </div>
              
              <div className={classNames(
                'pt-6 border-t',
                isDarkTheme ? 'border-white/10' : 'border-slate-300'
              )}>
                <h2 className={classNames(
                  'text-xl font-semibold mb-3',
                  isDarkTheme ? 'text-yellow-300' : 'text-orange-700'
                )}>
                  Important Note
                </h2>
                <p className={classNames(
                  'mb-2',
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  This is <strong>NOT</strong> an official website of Sree Balaji Medical College & Hospital (SBMCH).
                </p>
                <p className={classNames(
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  It is an independent student project and is not affiliated, endorsed, or supported by the institution in any manner.
                </p>
              </div>
              
              <div className={classNames(
                'pt-6 border-t',
                isDarkTheme ? 'border-white/10' : 'border-slate-300'
              )}>
                <h2 className={classNames(
                  'text-xl font-semibold mb-3',
                  isDarkTheme ? 'text-yellow-300' : 'text-orange-700'
                )}>
                  Usage Warning
                </h2>
                <p className={classNames(
                  'mb-2',
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  Please use this tool responsibly.
                </p>
                <p className={classNames(
                  'mb-2',
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  Avoid misuse, overloading, or exploiting any features.
                </p>
                <p className={classNames(
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  This platform exists to help students, not to create issues for the college or its systems.
                </p>
              </div>

              <div className={classNames(
                'pt-6 border-t',
                isDarkTheme ? 'border-white/10' : 'border-slate-300'
              )}>
                <h2 className={classNames(
                  'text-xl font-semibold mb-4 flex items-center gap-2',
                  isDarkTheme ? 'text-white/90' : 'text-slate-900'
                )}>
                  <span>⭐</span> Support & Troubleshooting
                </h2>
                <p className={classNames(
                  'mb-4',
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  If you face any difficulties, such as:
                </p>
                <ul className={classNames(
                  'list-none space-y-2 mb-6',
                  isDarkTheme ? 'text-white/80' : 'text-slate-700'
                )}>
                  <li className="flex items-start gap-2">
                    <span className="text-red-400">❗</span>
                    <span>Attendance not loading</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-red-400">❗</span>
                    <span>Payment-related errors</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-red-400">❗</span>
                    <span>Slow loading or unexpected bugs</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-red-400">❗</span>
                    <span>UI issues or feature not working</span>
                  </li>
                </ul>
                <p className={classNames(
                  'mb-4 font-semibold',
                  isDarkTheme ? 'text-white/90' : 'text-slate-800'
                )}>
                  We're here to help!
                </p>
                <div>
                  <p className={classNames(
                    'mb-3',
                    isDarkTheme ? 'text-white/80' : 'text-slate-700'
                  )}>
                    <strong>Contact Support</strong>
                  </p>
                  <p className={classNames(
                    'mb-4 text-xs',
                    isDarkTheme ? 'text-white/60' : 'text-slate-600'
                  )}>
                    Click below to open WhatsApp and message support directly:
                  </p>
                  <button
                    onClick={handleWhatsAppSupport}
                    className={classNames(
                      'w-full rounded-lg px-6 py-3 font-semibold transition-all transform hover:scale-[1.02]',
                      'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500',
                      'text-white shadow-lg flex items-center justify-center gap-2'
                    )}
                  >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                    </svg>
                    <span>👉 WhatsApp Support</span>
                  </button>
                  <p className={classNames(
                    'mt-2 text-xs text-center',
                    isDarkTheme ? 'text-white/50' : 'text-slate-500'
                  )}>
                    (You will be redirected to WhatsApp chat with the support number.)
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Container>
    )
  })

  // Login Page (inline JSX to avoid remount blur)

  // Payment Page
  const PaymentPage = React.memo(() => {
    const [razorpayLoading, setRazorpayLoading] = useState(false)
    const [razorpayReady, setRazorpayReady] = useState(false)
    const razorpayReadyRef = useRef(false) // Track if we've already set ready state
    const intervalRef = useRef(null) // Track interval for cleanup
    const timeoutRef = useRef(null) // Track timeout for cleanup
    const hasSetReadyRef = useRef(false) // Track if we've called setRazorpayReady

    // Load Razorpay script with robust error handling
    useEffect(() => {
      // Skip if already ready
      if (razorpayReadyRef.current || hasSetReadyRef.current) {
        return
      }
      
      let isCleanedUp = false
      
      const checkRazorpay = () => {
        // Don't check if already cleaned up or already ready
        if (isCleanedUp || razorpayReadyRef.current || hasSetReadyRef.current) {
          return true
        }
        
        if (window.Razorpay && typeof window.Razorpay === 'function') {
          // Mark as ready immediately to prevent multiple calls
          razorpayReadyRef.current = true
          hasSetReadyRef.current = true
          
          // Clean up intervals/timeouts FIRST - before state update
          if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
          }
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
            timeoutRef.current = null
          }
          
          // Set state only once using functional update to prevent re-renders if already true
          console.log('[PaymentPage] ✅ Razorpay is available')
          setRazorpayReady(prev => {
            if (prev === true) return prev // Already true, don't update
            return true
          })
          
          return true
        }
        return false
      }
      
      // Immediate check
      if (checkRazorpay()) {
        return () => {
          isCleanedUp = true
        }
      }

      // Check if script already exists in DOM
      const existingScript = document.querySelector('script[src*="checkout.razorpay.com"]')
      if (existingScript) {
        console.log('[PaymentPage] Script tag exists, polling for window.Razorpay...')
        // Poll for Razorpay to become available (max 40 checks = 8 seconds)
        let pollCount = 0
        const maxPolls = 40
        intervalRef.current = setInterval(() => {
          if (isCleanedUp || razorpayReadyRef.current) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current)
              intervalRef.current = null
            }
            return
          }
          pollCount++
          if (checkRazorpay() || pollCount >= maxPolls) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current)
              intervalRef.current = null
            }
          }
        }, 200)
        
        // Timeout after 8 seconds
        timeoutRef.current = setTimeout(() => {
          if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
          }
          if (!razorpayReadyRef.current && !isCleanedUp) {
            console.error('[PaymentPage] ❌ Timeout: Razorpay not available after 8s')
            setToast({ type: 'error', message: 'Payment gateway timeout. Click "Retry" button below.' })
          }
        }, 8000)
        
        return () => {
          isCleanedUp = true
          if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
          }
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
            timeoutRef.current = null
          }
        }
      }

      // Create and load script
      console.log('[PaymentPage] 📥 Creating script tag for Razorpay...')
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.async = true
      script.id = 'razorpay-checkout-script'
      
      script.onload = () => {
        if (isCleanedUp) return
        console.log('[PaymentPage] 📦 Script onload fired')
        // Wait a bit for Razorpay to initialize
        setTimeout(() => {
          if (isCleanedUp) return
          if (checkRazorpay()) {
            return
          }
          // If still not available, start polling
          console.log('[PaymentPage] ⏳ Script loaded but Razorpay not ready, polling...')
          let pollCount = 0
          const maxPolls = 25 // 5 seconds max
          intervalRef.current = setInterval(() => {
            if (isCleanedUp || razorpayReadyRef.current) {
              if (intervalRef.current) {
                clearInterval(intervalRef.current)
                intervalRef.current = null
              }
              return
            }
            pollCount++
            if (checkRazorpay() || pollCount >= maxPolls) {
              if (intervalRef.current) {
                clearInterval(intervalRef.current)
                intervalRef.current = null
              }
            }
          }, 200)
          
          // Final timeout
          timeoutRef.current = setTimeout(() => {
            if (intervalRef.current) {
              clearInterval(intervalRef.current)
              intervalRef.current = null
            }
            if (!razorpayReadyRef.current && !isCleanedUp) {
              console.error('[PaymentPage] ❌ Razorpay still not available after script load')
              setToast({ type: 'error', message: 'Payment gateway failed to initialize. Try refreshing or check console.' })
            }
          }, 5000)
        }, 500)
      }
      
      script.onerror = (err) => {
        if (isCleanedUp) return
        console.error('[PaymentPage] ❌ Script onerror fired', err)
        setToast({ type: 'error', message: 'Failed to load payment gateway. Check internet connection or try retry button.' })
      }
      
      // Global timeout
      timeoutRef.current = setTimeout(() => {
        if (!razorpayReadyRef.current && !isCleanedUp) {
          console.error('[PaymentPage] ❌ Global timeout: Razorpay not loaded after 10s')
          setToast({ type: 'error', message: 'Payment gateway loading timeout. Use retry button or refresh page.' })
        }
      }, 10000)
      
      try {
        document.head.appendChild(script)
        console.log('[PaymentPage] ✅ Script tag appended to <head>')
      } catch (err) {
        console.error('[PaymentPage] ❌ Failed to append script', err)
        if (!isCleanedUp) {
          setToast({ type: 'error', message: 'Failed to load payment script. Please refresh the page.' })
        }
      }
      
      // Cleanup
      return () => {
        isCleanedUp = true
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
      }
    }, [])

    // Check trial status when payment page loads - in case admin extended trial
    // Use a simpler status check instead of fetchAttendance to avoid fallback data
    // Only run once when component mounts, not on every render
    useEffect(() => {
      let mounted = true
      let timeout = null
      
      // Clear any error state and toast when payment page loads
      // Use functional updates to prevent unnecessary re-renders
      clearError()
      setToast(prev => {
        if (prev.type === 'info' && prev.message === '') return prev
        return { type: 'info', message: '' }
      })
      
      // Debounce the check to avoid rate limiting - wait longer to give login time to complete
      timeout = setTimeout(async () => {
        if (!mounted) return
        
        const storedToken = localStorage.getItem(TOKEN_KEY)
        // Don't redirect to login immediately - user might be on payment page legitimately
        // Only redirect if we get a 401 from the status check
        if (!storedToken) {
          // Log but don't redirect - let the user try to pay (they'll get redirected if token is truly missing)
          console.log('[PaymentPage] No token found, but staying on payment page')
          return
        }
        
        console.log('[PaymentPage] Checking subscription status...', { hasToken: !!storedToken })

        // Use status endpoint instead of fetchAttendance to avoid triggering fallback
        try {
          const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined
          const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined
          const apiBase = reactApi || viteApi || localStorage.getItem('API_OVERRIDE') || 'http://localhost:3000'
          
          const statusResp = await fetch(`${apiBase}/api/auth/status`, {
            headers: { 'Authorization': `Bearer ${storedToken}` }
          })
          
          if (!mounted) return
          
          // Handle 401 - token is invalid
          if (statusResp.status === 401) {
            console.warn('[PaymentPage] Status check returned 401 - token may be invalid')
            // Don't immediately redirect - user might have just logged in
            // Only redirect if we're sure the token is bad (check token exists first)
            const currentToken = localStorage.getItem(TOKEN_KEY)
            if (!currentToken) {
              console.log('[PaymentPage] No token found, redirecting to login')
              if (mounted) setView('login')
              return
            }
            // Token exists but got 401 - might be expired or invalid
            // Log but don't redirect - let user try to pay (they'll get proper error then)
            console.log('[PaymentPage] Token exists but status check failed - staying on payment page')
            return
          }
          
          if (statusResp.ok) {
            const statusData = await statusResp.json()
            console.log('[PaymentPage] Status check result:', {
              subscription_status: statusData.subscription_status,
              trial_expires_at: statusData.trial_expires_at
            })
            // If subscription is active or trial is still valid, redirect to dashboard
            if (statusData.subscription_status === 'active') {
              console.log('[PaymentPage] Subscription is active, redirecting to dashboard')
              if (mounted) setView('dashboard')
              return
            }
            if (statusData.subscription_status === 'trial' && statusData.trial_expires_at) {
              const trialExpires = new Date(statusData.trial_expires_at)
              if (trialExpires > new Date()) {
                console.log('[PaymentPage] Trial still active, redirecting to dashboard')
                if (mounted) setView('dashboard')
                return
              }
            }
            // Trial expired or subscription expired - stay on payment page
            console.log('[PaymentPage] Trial/subscription expired - staying on payment page')
          } else if (statusResp.status === 429) {
            // Rate limited - don't retry, just log
            console.log('[PaymentPage] Rate limited, skipping trial status check')
          } else {
            // Other errors (500, etc) - log but stay on payment page
            console.log('[PaymentPage] Status check failed with status:', statusResp.status, '- staying on payment page')
          }
          // For all errors, stay on payment page - don't redirect
        } catch (err) {
          // Silently handle errors - user is already on payment page
          if (mounted) {
            console.log('[PaymentPage] Error checking trial status (expected if trial expired):', err.message)
          }
        }
      }, 2000) // Wait 2 seconds before checking to avoid immediate rate limit and give login time to complete
      
      return () => {
        mounted = false
        if (timeout) clearTimeout(timeout)
      }
    }, []) // Empty deps - only run once on mount

    const handleRazorpayCheckout = async () => {
      // Debug: Check token before doing anything
      const storedToken = localStorage.getItem(TOKEN_KEY)
      console.log('[PaymentPage] 🔍 Pay button clicked - DEBUG:', {
        hasToken: !!storedToken,
        tokenLength: storedToken?.length || 0,
        tokenPreview: storedToken ? storedToken.substring(0, 20) + '...' : 'none',
        TOKEN_KEY: TOKEN_KEY,
        allLocalStorageKeys: Object.keys(localStorage)
      })
      
      if (!storedToken) {
        console.error('[PaymentPage] ❌ No token found when clicking Pay button')
        console.error('[PaymentPage] Available localStorage keys:', Object.keys(localStorage))
        setToast(prev => {
          const newToast = { type: 'error', message: 'Please login to continue' }
          if (prev.type === newToast.type && prev.message === newToast.message) return prev
          return newToast
        })
        // Don't remove token if it doesn't exist - just redirect
        setView('login')
        return
      }
      
      console.log('[PaymentPage] ✅ Pay button clicked, token exists:', !!storedToken)

      if (!razorpayReady || !window.Razorpay) {
        setToast(prev => {
          const newToast = { type: 'error', message: 'Payment gateway not ready. Please refresh the page.' }
          if (prev.type === newToast.type && prev.message === newToast.message) return prev
          return newToast
        })
        return
      }

      setRazorpayLoading(true)

      try {
        // Get API base
        const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined
        const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined
        const apiBase = reactApi || viteApi || localStorage.getItem('API_OVERRIDE') || 'http://localhost:3000'

        console.log('[PaymentPage] Creating subscription...', { apiBase, hasToken: !!storedToken })

        // Call backend to create subscription
        const response = await fetch(`${apiBase}/api/subscriptions/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${storedToken}`
          }
        })

        console.log('[PaymentPage] 📡 Response status:', response.status, response.statusText)

        // Handle 401 - unauthorized FIRST (before reading body)
        if (response.status === 401) {
          console.error('[PaymentPage] ❌ 401 Unauthorized - token invalid or expired')
          console.error('[PaymentPage] Token that was sent:', storedToken ? storedToken.substring(0, 20) + '...' : 'none')
          
          // Try to read error message
          let errorMessage = 'Session expired. Please login again.'
          try {
            const errorData = await response.json()
            errorMessage = errorData.message || errorData.error || errorMessage
            console.error('[PaymentPage] 401 Error details:', errorData)
          } catch (e) {
            console.error('[PaymentPage] Could not parse 401 error response')
          }
          
          localStorage.removeItem(TOKEN_KEY)
          setToast(prev => {
            const newToast = { type: 'error', message: errorMessage }
            if (prev.type === newToast.type && prev.message === newToast.message) return prev
            return newToast
          })
          setView('login')
          setRazorpayLoading(false)
          return
        }

        // Handle other errors
        if (!response.ok) {
          let errorData
          try {
            errorData = await response.json()
            console.error('[PaymentPage] ❌ API Error Response:', {
              status: response.status,
              statusText: response.statusText,
              error: errorData
            })
          } catch {
            const responseText = await response.text().catch(() => 'Could not read response')
            console.error('[PaymentPage] ❌ API Error (non-JSON):', {
              status: response.status,
              statusText: response.statusText,
              body: responseText.substring(0, 200)
            })
            errorData = { message: `Server error: ${response.status} ${response.statusText}` }
          }
          throw new Error(errorData.message || errorData.error || `Failed to create subscription (${response.status})`)
        }

        const data = await response.json()
        const { subscriptionId, options } = data

        if (!subscriptionId || !options) {
          throw new Error('Invalid response from server: missing subscription details')
        }

        // Initialize Razorpay Checkout
        const razorpay = new window.Razorpay({
          ...options,
          handler: async (response) => {
            console.log('[PaymentPage] Payment successful', response)
            setToast(prev => {
              const newToast = { type: 'success', message: 'Waiting for confirmation...' }
              if (prev.type === newToast.type && prev.message === newToast.message) return prev
              return newToast
            })
            setRazorpayLoading(true)
            
            // Poll backend to check subscription status - every 2s for up to 30s
            const pollApiBase = reactApi || viteApi || localStorage.getItem('API_OVERRIDE') || 'http://localhost:3000'
            const pollToken = localStorage.getItem(TOKEN_KEY)
            if (!pollToken) {
              setToast(prev => {
                const newToast = { type: 'error', message: 'Session expired. Please login again.' }
                if (prev.type === newToast.type && prev.message === newToast.message) return prev
                return newToast
              })
              setRazorpayLoading(false)
              setView('login')
              return
            }
            
            let pollCount = 0
            const maxPolls = 15 // 15 attempts * 2s = 30 seconds max
            const pollInterval = 2000 // Poll every 2 seconds
            
            const pollStatus = async () => {
              try {
                const statusResp = await fetch(`${pollApiBase}/api/auth/status`, {
                  headers: { 'Authorization': `Bearer ${pollToken}` }
                })
                
                // Handle 401 during polling
                if (statusResp.status === 401) {
                  localStorage.removeItem(TOKEN_KEY)
                  setToast(prev => {
                    const newToast = { type: 'error', message: 'Session expired. Please login again.' }
                    if (prev.type === newToast.type && prev.message === newToast.message) return prev
                    return newToast
                  })
                  setRazorpayLoading(false)
                  setView('login')
                  return
                }
                
                if (statusResp.ok) {
                  const statusData = await statusResp.json()
                  if (statusData.subscription_status === 'active') {
                    setToast(prev => {
                      const newToast = { type: 'success', message: 'Subscription activated! Redirecting...' }
                      if (prev.type === newToast.type && prev.message === newToast.message) return prev
                      return newToast
                    })
                    setTimeout(() => {
                      setView('dashboard')
                      setRazorpayLoading(false)
                    }, 1000)
                    return
                  }
                }
                
                pollCount++
                if (pollCount < maxPolls) {
                  setTimeout(pollStatus, pollInterval)
                } else {
                  // Timeout - show message with refresh option
                  setToast(prev => {
                    const newToast = { type: 'info', message: 'Payment received, verification pending — refresh later' }
                    if (prev.type === newToast.type && prev.message === newToast.message) return prev
                    return newToast
                  })
                  setRazorpayLoading(false)
                }
              } catch (pollErr) {
                console.error('[PaymentPage] Polling error:', pollErr)
                pollCount++
                if (pollCount < maxPolls) {
                  setTimeout(pollStatus, pollInterval)
                } else {
                  setToast(prev => {
                    const newToast = { type: 'info', message: 'Payment received, verification pending — refresh later' }
                    if (prev.type === newToast.type && prev.message === newToast.message) return prev
                    return newToast
                  })
                  setRazorpayLoading(false)
                }
              }
            }
            
            // Start polling after 2 seconds (give webhook time to process)
            setTimeout(pollStatus, 2000)
          },
          modal: {
            ondismiss: () => {
              setRazorpayLoading(false)
              console.log('[PaymentPage] Payment modal closed')
            }
          }
        })

        razorpay.on('payment.failed', (error) => {
          console.error('[PaymentPage] Payment failed', error)
          setRazorpayLoading(false)
          setToast(prev => {
            const newToast = { type: 'error', message: error.error?.description || 'Payment failed. Please try again.' }
            if (prev.type === newToast.type && prev.message === newToast.message) return prev
            return newToast
          })
        })

        razorpay.open()
        // Don't set loading to false here - let the modal handlers do it
      } catch (err) {
        console.error('[PaymentPage] Subscription creation error:', err)
        setRazorpayLoading(false)
        if (err.message === 'unauthorized') {
          // Already handled above
          return
        }
        const errorMessage = err.message || 'Failed to initialize payment. Please try again.'
        setToast(prev => {
          const newToast = { type: 'error', message: errorMessage }
          if (prev.type === newToast.type && prev.message === newToast.message) return prev
          return newToast
        })
        console.error('[PaymentPage] Full error details:', {
          message: err.message,
          stack: err.stack,
          response: err.response
        })
      }
    }

    return (
      <Container>
        <div className="max-w-2xl mx-auto">
          <div className={classNames(
            'rounded-2xl p-8 backdrop-blur-xl border border-white/10',
            'bg-white/10 dark:bg-white/5 shadow-lg',
            'animate-fade-in'
          )}>
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-r from-cyan-500 to-indigo-500 mb-4">
                <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h1 className="text-3xl font-bold text-white/90 mb-2">Trial Expired</h1>
              <p className="text-white/70 text-lg mb-4">
                Your trial has ended. Pay ₹49 to continue using attendance services.
              </p>
            </div>

          <div className={classNames(
            'rounded-xl p-6 mb-6 border',
            isDarkTheme 
              ? 'bg-white/5 border-white/10' 
              : 'bg-white/20 border-white/20'
          )}>
            <div className="text-center">
              <div className="text-5xl font-bold text-white/90 mb-2">₹49</div>
              <div className="text-white/60 mb-4">for 28 days</div>
              <ul className="text-left space-y-3 text-white/80 mb-6">
                <li className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  Full access to attendance dashboard
                </li>
                <li className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  Upcoming classes schedule
                </li>
                <li className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  Real-time attendance tracking
                </li>
                <li className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  Detailed attendance analytics
                </li>
              </ul>
            </div>
          </div>

          <div className="space-y-4">
            <button
              onClick={handleRazorpayCheckout}
              disabled={razorpayLoading || !razorpayReady}
              className={classNames(
                'w-full rounded-lg px-6 py-3 text-white font-semibold',
                'bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]',
                'transition-all transform hover:scale-[1.02]',
                (razorpayLoading || !razorpayReady) && 'opacity-60 cursor-not-allowed'
              )}
            >
              {!razorpayReady ? 'Loading Payment Gateway...' : razorpayLoading ? 'Opening payment...' : 'Pay ₹49 Now'}
            </button>
            <button
              onClick={() => {
                handleLogout()
                setView('login')
              }}
              className={classNames(
                'w-full rounded-lg px-6 py-3 font-medium',
                isDarkTheme
                  ? 'bg-white/10 border border-white/20 text-white/80 hover:bg-white/15'
                  : 'bg-white/20 border border-white/30 text-slate-800 hover:bg-white/30'
              )}
            >
              Logout
            </button>
            <button
              onClick={async () => {
                // Manual refresh button to check trial status
                setToast({ type: 'info', message: 'Checking trial status...' })
                try {
                  const result = await fetchAttendance()
                  if (!result?.paymentRedirect && !result?.unauthorized) {
                    setToast({ type: 'success', message: 'Trial active! Redirecting...' })
                    setTimeout(() => setView('dashboard'), 500)
                  } else {
                    setToast({ type: 'info', message: 'Trial still expired. Please subscribe to continue.' })
                  }
                } catch (err) {
                  console.error('[PaymentPage] Error checking trial status:', err)
                  setToast({ type: 'error', message: 'Failed to check trial status. Please try again.' })
                }
              }}
              className={classNames(
                'w-full rounded-lg px-4 py-2 text-sm font-medium',
                isDarkTheme
                  ? 'bg-blue-500/20 border border-blue-400/30 text-blue-200 hover:bg-blue-500/30'
                  : 'bg-blue-100 border border-blue-300 text-blue-800 hover:bg-blue-200'
              )}
            >
              🔄 Refresh & Check Trial Status
            </button>
            {!razorpayReady && (
              <div className="space-y-2">
                <button
                  onClick={() => {
                    // Force reload Razorpay script
                    console.log('[PaymentPage] 🔄 Force reloading Razorpay script...')
                    const existing = document.querySelectorAll('script[src*="checkout.razorpay.com"], script[id="razorpay-checkout-script"]')
                    existing.forEach(s => {
                      console.log('[PaymentPage] Removing existing script:', s.src)
                      s.remove()
                    })
                    delete window.Razorpay
                    setRazorpayReady(false)
                    
                    // Create new script
                    const script = document.createElement('script')
                    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
                    script.async = true
                    script.id = 'razorpay-checkout-script'
                    script.onload = () => {
                      console.log('[PaymentPage] ✅ Retry: Script loaded')
                      setTimeout(() => {
                        if (window.Razorpay && typeof window.Razorpay === 'function') {
                          setRazorpayReady(true)
                          setToast({ type: 'success', message: 'Payment gateway loaded!' })
                        } else {
                          console.error('[PaymentPage] ❌ Retry: window.Razorpay still not available')
                          setToast({ type: 'error', message: 'Still loading... Check browser console (F12) for errors' })
                        }
                      }, 1000)
                    }
                    script.onerror = () => {
                      console.error('[PaymentPage] ❌ Retry: Script failed to load')
                      setToast({ type: 'error', message: 'Failed to load. Check internet connection or refresh page.' })
                    }
                    try {
                      document.head.appendChild(script)
                      console.log('[PaymentPage] ✅ Retry: Script appended')
                    } catch (err) {
                      console.error('[PaymentPage] ❌ Retry: Failed to append script', err)
                      setToast({ type: 'error', message: 'Failed to load script. Please refresh the page.' })
                    }
                  }}
                  className={classNames(
                    'w-full rounded-lg px-4 py-2 text-sm font-medium',
                    isDarkTheme
                      ? 'bg-orange-500/20 border border-orange-400/30 text-orange-200 hover:bg-orange-500/30'
                      : 'bg-orange-100 border border-orange-300 text-orange-800 hover:bg-orange-200'
                  )}
                >
                  🔄 Retry Loading Payment Gateway
                </button>
                <div className="text-xs text-white/50 text-center px-2">
                  Open browser console (F12) to see detailed logs. If still stuck, refresh the page.
                </div>
              </div>
            )}
          </div>

            <div className="mt-6 text-center text-sm text-white/60">
              Need help? Contact support for assistance.
            </div>
            {/* About Button */}
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => setView('about')}
                className={classNames(
                  'text-sm underline transition-colors',
                  isDarkTheme
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-slate-600 hover:text-slate-800'
                )}
              >
                About
              </button>
            </div>
          </div>
        </div>
      </Container>
    )
  })

  // Dashboard Page
  const DashboardPage = React.memo(() => (
    <Container>
      <div className="flex items-center justify-between mb-6">
        {/* Left: name & date with entrance animation */}
        <div className="flex items-baseline gap-3">
          <h2 key={`name-${animateKey}`} className="text-2xl font-bold text-white/90 animate-fade-in-left">{studentName}</h2>
          <span key={`date-${animateKey}`} className="text-sm text-white/60 animate-type-in">{typedDate}</span>
        </div>
        {/* Right: actions */}
        <div className="flex items-center gap-2">
          <ThemeSelect />
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
      {/* Upcoming classes section */}
      {Array.isArray(upcomingClasses) && upcomingClasses.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-white/90 mb-2">Upcoming Classes</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {upcomingClasses.map((u, i) => (
              <UpcomingCard key={(u.title||'') + i} item={u} idx={i} />
            ))}
          </div>
        </div>
      )}
      {/* Cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {loading && Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} idx={i} />)}
        {!loading && attendance?.length > 0 && attendance.map((item, idx) => (
          <SubjectCard item={item} key={item.subject + idx} idx={idx} real={!isFallback} theme={theme} />
        ))}
        {!loading && attendance?.length === 0 && (
          <div className="col-span-full text-center text-white/70">
            No attendance data available.
          </div>
        )}
      </div>
      {/* About Button */}
      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={() => setView('about')}
          className={classNames(
            'text-sm underline transition-colors',
            isDarkTheme
              ? 'text-white/60 hover:text-white/80'
              : 'text-slate-600 hover:text-slate-800'
          )}
        >
          About
        </button>
      </div>
    </Container>
  ))

  return (
    <div className="relative overflow-x-hidden">
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
          <div className="pointer-events-none fixed -top-32 -left-16 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" style={{ willChange: 'transform, opacity', transform: 'translateZ(0)' }} />
          <div className="pointer-events-none fixed -bottom-24 -right-16 h-72 w-72 rounded-full bg-cyan-500/20 blur-3xl" style={{ willChange: 'transform, opacity', transform: 'translateZ(0)' }} />
        </>
      )}
      {/* App Views */}
      {view === 'about' ? <AboutPage /> : view === 'pay' ? <PaymentPage /> : view === 'login' ? (
        <div className="min-h-screen px-4 py-8 md:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-md">
              {/* Header row with right-aligned theme toggle */}
              <div className="mb-6 flex items-center justify-between">
                <div className="text-left">
                  <h1 className="text-3xl font-bold text-white/90">SBMCH Attendance</h1>
                  <p className="mt-1 text-sm text-white/60">Glassy dashboard — sign in to view your details</p>
                </div>
                <ThemeSelect />
              </div>
              {/* Show loading state while validating token */}
              {isValidatingToken ? (
                <div className={isDarkTheme
                  ? 'rounded-2xl p-6 backdrop-blur-xl bg-white/10 dark:bg-white/5 border border-white/10 shadow-lg'
                  : 'rounded-2xl p-6 backdrop-blur-xl bg-white/90 border border-slate-300 shadow-lg'}>
                  <div className="flex flex-col items-center justify-center py-8">
                    <div className="w-8 h-8 border-4 border-white/20 border-t-white/80 rounded-full animate-spin mb-4"></div>
                    <p className={isDarkTheme ? 'text-white/70' : 'text-slate-600'}>Checking authentication...</p>
                  </div>
                </div>
              ) : (
              <>
              <form
                onSubmit={handleLogin}
                className={isDarkTheme
                  ? 'rounded-2xl p-6 backdrop-blur-xl bg-white/10 dark:bg-white/5 border border-white/10 shadow-lg'
                  : 'rounded-2xl p-6 backdrop-blur-xl bg-white/90 border border-slate-300 shadow-lg'}
                onMouseDown={(e)=>e.stopPropagation()}
              >
                <div className="mb-4">
                  <label htmlFor="username" className={
                    'block text-sm font-medium ' + (isDarkTheme ? 'text-white/80' : 'text-slate-700')
                  }>Student ID</label>
                  <input
                    id="username"
                    type="text"
                    aria-label="Student ID"
                    value={username}
                    onFocus={(e)=>e.stopPropagation()}
                    onChange={(e) => setUsername(() => e.target.value)}
                    autoComplete="off"
                    spellCheck="false"
                    inputMode="text"
                    className={isDarkTheme
                      ? 'mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'
                      : 'mt-2 w-full rounded-lg bg-white/90 border border-slate-300 text-slate-900 placeholder:text-slate-500 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'}
                    placeholder="Enter student ID"
                    required
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="password" className={
                    'block text-sm font-medium ' + (isDarkTheme ? 'text-white/80' : 'text-slate-700')
                  }>Password</label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      aria-label="Password"
                      value={password}
                      onFocus={(e)=>e.stopPropagation()}
                      onChange={(e) => setPassword(() => e.target.value)}
                      autoComplete="off"
                      spellCheck="false"
                      inputMode="text"
                      className={isDarkTheme
                        ? 'mt-2 w-full pr-12 rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'
                        : 'mt-2 w-full pr-12 rounded-lg bg-white/90 border border-slate-300 text-slate-900 placeholder:text-slate-500 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'}
                      placeholder="Enter password"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className={classNames(
                        'absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-colors',
                        isDarkTheme
                          ? 'text-white/40 hover:text-white/80 hover:bg-white/10'
                          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                      )}
                      style={{ top: 'calc(50% + 4px)' }}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      tabIndex={0}
                    >
                      {showPassword ? (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.29 3.29m0 0L3 3m3.29 3.29L3 3m6.29 6.29L3 3m6.29 6.29l3.29 3.29m0 0L21 21m-3.29-3.29L21 21m-6.29-6.29L21 21m-6.29-6.29l-3.29-3.29" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fromDate" className={
                      'block text-sm font-medium ' + (isDarkTheme ? 'text-white/80' : 'text-slate-700')
                    }>From Date</label>
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
                      className={isDarkTheme
                        ? 'mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'
                        : 'mt-2 w-full rounded-lg bg-white/90 border border-slate-300 text-slate-900 placeholder:text-slate-500 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'}
                      placeholder="DD-MM-YYYY"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="toDate" className={
                      'block text-sm font-medium ' + (isDarkTheme ? 'text-white/80' : 'text-slate-700')
                    }>To Date</label>
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
                      className={isDarkTheme
                        ? 'mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'
                        : 'mt-2 w-full rounded-lg bg-white/90 border border-slate-300 text-slate-900 placeholder:text-slate-500 p-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]'}
                      placeholder="DD-MM-YYYY"
                      required
                    />
                  </div>
                </div>
                <label className={
                  'mt-3 inline-flex items-center gap-2 ' + (isDarkTheme ? 'text-white/80' : 'text-slate-700')
                }>
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className={isDarkTheme
                      ? 'h-4 w-4 rounded border-white/20 bg-white/10'
                      : 'h-4 w-4 rounded border-slate-300 bg-white'}
                  />
                  <span className="text-sm">Remember me (stores credentials locally)</span>
                </label>
                {/* Network error banner with Set Backend button */}
                {(error && (error.includes('Set Backend') || error.includes('Cannot connect to backend'))) && (
                  <div className={classNames(
                    'mt-3 p-3 rounded-lg border',
                    isDarkTheme 
                      ? 'bg-orange-500/20 border-orange-400/30 text-orange-200' 
                      : 'bg-orange-100 border-orange-300 text-orange-800'
                  )}>
                    <p className="text-sm mb-2">{error}</p>
                    <button
                      type="button"
                      onClick={() => setShowBackendModal(true)}
                      className={classNames(
                        'text-sm px-3 py-1.5 rounded font-medium',
                        isDarkTheme
                          ? 'bg-orange-500/30 hover:bg-orange-500/40 text-orange-100'
                          : 'bg-orange-500 hover:bg-orange-600 text-white'
                      )}
                    >
                      Set Backend
                    </button>
                  </div>
                )}
                {/* Other errors */}
                {error && !error.includes('Set Backend') && !error.includes('Cannot connect to backend') && (
                  <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>
                )}
                <button
                  type="submit"
                  className={classNames(
                    'mt-6 w-full rounded-lg px-4 py-2.5 text-white font-semibold',
                    'bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400',
                    'focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]',
                    authLoading && 'opacity-60 cursor-not-allowed'
                  )}
                  aria-busy={authLoading}
                >
                  {authLoading ? 'Signing In…' : 'Sign In'}
                </button>
              </form>
              {/* About Button */}
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => setView('about')}
                  className={classNames(
                    'text-sm underline transition-colors',
                    isDarkTheme
                      ? 'text-white/60 hover:text-white/80'
                      : 'text-slate-600 hover:text-slate-800'
                  )}
                >
                  About
                </button>
              </div>
              </>
              )}
            </div>
          </div>
        </div>
      ) : <DashboardPage />}
      {/* Backend URL Override Modal */}
      {showBackendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowBackendModal(false)} />
          <div className={classNames(
            'relative w-full max-w-md rounded-2xl p-6 shadow-xl',
            isDarkTheme
              ? 'bg-white/10 border border-white/10 text-white'
              : 'bg-white border border-slate-200 text-slate-900'
          )}>
            <button
              type="button"
              onClick={() => setShowBackendModal(false)}
              className={classNames(
                'absolute top-3 right-3 text-sm',
                isDarkTheme ? 'text-white/70 hover:text-white' : 'text-slate-500 hover:text-slate-900'
              )}
              aria-label="Close"
            >
              ✕
            </button>
            <h3 className={classNames('text-lg font-semibold mb-2', isDarkTheme ? 'text-white' : 'text-slate-900')}>
              Set Backend URL
            </h3>
            <p className={classNames('text-sm mb-4', isDarkTheme ? 'text-white/70' : 'text-slate-600')}>
              Enter the backend API URL (e.g., http://localhost:3000)
            </p>
            <input
              type="text"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              placeholder="http://localhost:3000"
              className={classNames(
                'w-full rounded-lg p-2.5 mb-4 focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)]',
                isDarkTheme
                  ? 'bg-white/10 border border-white/20 text-white placeholder:text-white/40'
                  : 'bg-white border border-slate-300 text-slate-900 placeholder:text-slate-500'
              )}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSetBackend()
                }
              }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSetBackend}
                className={classNames(
                  'flex-1 rounded-lg px-4 py-2.5 text-white font-semibold',
                  'bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400'
                )}
              >
                Save & Retry
              </button>
              <button
                type="button"
                onClick={() => setShowBackendModal(false)}
                className={classNames(
                  'px-4 py-2.5 rounded-lg font-medium',
                  isDarkTheme
                    ? 'bg-white/10 hover:bg-white/20 text-white'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-800'
                )}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <Toast type={toast.type} message={toast.message} onClose={() => setToast({ type: 'info', message: '' })} />
    </div>
  )
}