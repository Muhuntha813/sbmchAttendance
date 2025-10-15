import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// Initialize theme from localStorage before rendering
const THEME_KEY = 'ATT_THEME'
const saved = localStorage.getItem(THEME_KEY)
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const initialTheme = saved ? saved : (prefersDark ? 'dark' : 'light')
document.documentElement.classList.toggle('dark', initialTheme === 'dark')

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)