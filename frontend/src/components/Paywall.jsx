// frontend/src/components/Paywall.jsx
// Razorpay Checkout Integration Component
// Handles complete payment flow: subscription creation → Razorpay Checkout → success/failure handling

import React, { useState, useEffect, useRef, useCallback } from 'react'

const TOKEN_KEY = 'ATT_TOKEN' // Token key used by the app

/**
 * Load Razorpay script dynamically
 * @returns {Promise<boolean>} True if loaded successfully
 */
async function loadRazorpayScript() {
  if (typeof window === 'undefined') return false
  if (window.Razorpay) return true
  
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.async = true
    script.onload = () => resolve(true)
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
}

export default function Paywall({ onLogin, onSuccess, apiBase: providedApiBase }) {
  const [loading, setLoading] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [razorpayReady, setRazorpayReady] = useState(false)
  const pollRef = useRef(null)

  // Get API base URL
  const getApiBase = useCallback(() => {
    if (providedApiBase) return providedApiBase
    const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined
    const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined
    return reactApi || viteApi || localStorage.getItem('API_OVERRIDE') || 'http://localhost:3000'
  }, [providedApiBase])

  // Get token from localStorage
  const getToken = useCallback(() => {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch (e) {
      return null
    }
  }, [])

  // Handle unauthorized - clear token and redirect to login
  const handleUnauthorized = useCallback(() => {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch (e) {
      // Ignore
    }
    if (onLogin) {
      onLogin()
    }
  }, [onLogin])

  // Load Razorpay script on mount
  useEffect(() => {
    let mounted = true
    let hasSetReady = false

    const checkAndLoad = async () => {
      if (typeof window !== 'undefined' && window.Razorpay) {
        if (mounted && !hasSetReady) {
          hasSetReady = true
          setRazorpayReady(prev => prev === true ? prev : true)
        }
        return
      }

      const loaded = await loadRazorpayScript()
      if (mounted && !hasSetReady && loaded) {
        hasSetReady = true
        setRazorpayReady(prev => prev === true ? prev : true)
      }
    }

    checkAndLoad()

    return () => {
      mounted = false
    }
  }, [])

  // Create subscription on backend
  const createSubscription = useCallback(async () => {
    const token = getToken()
    if (!token) {
      handleUnauthorized()
      return null
    }

    const apiBase = getApiBase()
    const resp = await fetch(`${apiBase}/api/subscriptions/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({}) // Send empty body or any extra info if backend expects it
    })

    if (resp.status === 401) {
      handleUnauthorized()
      throw new Error('unauthorized')
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ message: 'unknown error' }))
      throw new Error(err.message || 'subscription_create_failed')
    }

    return resp.json()
  }, [getToken, getApiBase, handleUnauthorized])

  // Poll subscription status until active or timeout
  const pollSubscriptionStatus = useCallback(async (maxSeconds = 30) => {
    const token = getToken()
    if (!token) {
      handleUnauthorized()
      return false
    }

    const apiBase = getApiBase()
    const deadline = Date.now() + maxSeconds * 1000

    return new Promise((resolve) => {
      pollRef.current = setInterval(async () => {
        try {
          const resp = await fetch(`${apiBase}/api/auth/status`, {
            headers: { 'Authorization': `Bearer ${token}` }
          })

          if (resp.status === 401) {
            clearInterval(pollRef.current)
            pollRef.current = null
            handleUnauthorized()
            resolve(false)
            return
          }

          if (!resp.ok) {
            // Keep polling unless 401
            if (Date.now() > deadline) {
              clearInterval(pollRef.current)
              pollRef.current = null
              resolve(false)
            }
            return
          }

          const data = await resp.json()
          // Check subscription_status field (adjust path if different)
          const status = data?.subscription_status ?? data?.user?.subscription_status ?? null

          if (status === 'active') {
            clearInterval(pollRef.current)
            pollRef.current = null
            resolve(true)
            return
          }

          if (Date.now() > deadline) {
            clearInterval(pollRef.current)
            pollRef.current = null
            resolve(false)
            return
          }
        } catch (err) {
          if (Date.now() > deadline) {
            clearInterval(pollRef.current)
            pollRef.current = null
            resolve(false)
          }
        }
      }, 2000) // Poll every 2 seconds
    })
  }, [getToken, getApiBase, handleUnauthorized])

  // Handle pay button click
  const handlePayClick = useCallback(async () => {
    setLoading(true)

    try {
      // Step 1: Create subscription on backend
      const subscriptionData = await createSubscription()
      if (!subscriptionData) {
        // Already handled unauthorized
        return
      }

      const { subscriptionId, options } = subscriptionData

      if (!subscriptionId || !options) {
        throw new Error('Invalid response from server: missing subscription details')
      }

      // Step 2: Ensure Razorpay script is loaded
      const loaded = await loadRazorpayScript()
      if (!loaded) {
        throw new Error('razorpay_script_failed')
      }

      // Step 3: Prepare Razorpay options
      const razorpayOptions = {
        key: options.key,
        subscription_id: options.subscription_id || subscriptionId,
        name: options.name || 'SBMCH Attendance',
        description: options.description || '28-day access',
        prefill: options.prefill || {},
        notes: options.notes || {},
        theme: options.theme || { color: '#0f62fe' },
        handler: async function (response) {
          // Payment succeeded at Razorpay side; now wait for backend to activate
          console.log('[Paywall] Payment successful', response)
          setWaiting(true)
          
          const ok = await pollSubscriptionStatus(30)
          
          setWaiting(false)
          setLoading(false)

          if (ok) {
            // Subscription activated - call success callback
            if (onSuccess) {
              onSuccess('Subscription activated successfully!')
            }
          } else {
            // Timeout - show message
            if (onSuccess) {
              onSuccess('Payment received. Verification pending. Please refresh in a few seconds or check subscription status.')
            }
          }
        },
        modal: {
          ondismiss: function () {
            // User closed checkout
            setLoading(false)
            setWaiting(false)
          }
        }
      }

      // Step 4: Initialize and open Razorpay Checkout
      const rzp = new window.Razorpay(razorpayOptions)

      // Handle payment errors
      rzp.on('payment.failed', function (error) {
        console.error('[Paywall] Payment failed', error)
        setLoading(false)
        setWaiting(false)
        if (onSuccess) {
          onSuccess('Payment failed: ' + (error.error?.description || error.error?.reason || 'Unknown error'))
        }
      })

      rzp.open()
    } catch (err) {
      setLoading(false)
      setWaiting(false)
      
      if (err.message === 'unauthorized') {
        // Already handled
        return
      }
      
      if (onSuccess) {
        onSuccess('Payment start failed: ' + (err.message || 'unknown error'))
      }
    }
  }, [createSubscription, pollSubscriptionStatus, onSuccess])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [])

  // Manual check subscription status (for testing)
  const handleCheckStatus = useCallback(async () => {
    const token = getToken()
    if (!token) {
      handleUnauthorized()
      return
    }

    const apiBase = getApiBase()
    try {
      const resp = await fetch(`${apiBase}/api/auth/status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })

      if (resp.status === 401) {
        handleUnauthorized()
        return
      }

      const data = await resp.json()
      const status = data?.subscription_status ?? data?.user?.subscription_status ?? data
      
      if (onSuccess) {
        onSuccess('Status: ' + JSON.stringify(status))
      }
    } catch (err) {
      if (onSuccess) {
        onSuccess('Error checking status: ' + err.message)
      }
    }
  }, [getToken, getApiBase, handleUnauthorized, onSuccess])

  return {
    handlePayClick,
    handleCheckStatus,
    loading,
    waiting,
    razorpayReady,
    isReady: razorpayReady && !loading && !waiting
  }
}
