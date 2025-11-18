import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles/globals.css'

// Service worker unregister (temporary migration to force fresh CSS fetch)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.unregister());
  }).catch(()=>{});
}

// CSS load monitor (optional but useful for debugging)
fetch('/css/tailwind.css', { method: 'HEAD', cache: 'no-store' })
  .then(res => {
    if (!res.ok) {
      console.error('Tailwind CSS fetch failed', res.status);
    }
  })
  .catch(err => {
    console.error('Tailwind CSS fetch error', err);
  });

// Initialize 3-theme system before rendering
const THEME_KEY = 'ATT_THEME'
let initialTheme = localStorage.getItem(THEME_KEY)
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
if (!initialTheme) {
  initialTheme = prefersDark ? 'cool-down-buddy' : 'daylight-bliss'
}
// Migrate old values
if (initialTheme === 'dark') initialTheme = 'cool-down-buddy'
if (initialTheme === 'light') initialTheme = 'daylight-bliss'

const darkThemes = ['cool-down-buddy', 'midnight-drift']
document.documentElement.classList.toggle('dark', darkThemes.includes(initialTheme))
document.body.classList.remove('theme-cool', 'theme-midnight', 'theme-daylight')
const themeClassMap = {
  'cool-down-buddy': 'theme-cool',
  'midnight-drift': 'theme-midnight',
  'daylight-bliss': 'theme-daylight'
}
document.body.classList.add(themeClassMap[initialTheme] || 'theme-cool')
localStorage.setItem(THEME_KEY, initialTheme)

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)