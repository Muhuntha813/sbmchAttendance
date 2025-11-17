// backend/routes/subscriptions.js
// Razorpay Subscription Creation Endpoint

import express from 'express'
import Razorpay from 'razorpay'
import { query } from '../src/db.js'
import logger from '../lib/logger.js'

const router = express.Router()

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || ''
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || ''
const RAZORPAY_PLAN_ID = process.env.RAZORPAY_PLAN_ID || ''

// Initialize Razorpay client
const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null

/**
 * Helper to get user by ID
 */
async function getUserById(userId) {
  const { rows } = await query(
    `SELECT id, student_id, email, name, trial_expires_at, razorpay_customer_id, subscription_id, subscription_status
     FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  )
  return rows[0] || null
}

/**
 * Helper to verify JWT token
 */
function requireAuth(req) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return null
  }
  const token = auth.slice(7)
  try {
    const jwt = require('jsonwebtoken')
    const JWT_SECRET = process.env.JWT_SECRET || process.env.SECRET || ''
    return jwt.verify(token, JWT_SECRET)
  } catch (err) {
    logger.debug('[subscriptions] JWT verification failed', { error: err.message })
    return null
  }
}

/**
 * POST /api/subscriptions/create
 * Creates a Razorpay subscription for the authenticated user
 * 
 * Body (optional):
 *   - plan_id: Override default plan ID
 * 
 * Returns:
 *   - subscription_id: Razorpay subscription ID
 *   - razorpay_key_id: Public Razorpay key for frontend
 *   - checkout_options: Options for Razorpay Checkout initialization
 */
router.post('/create', async (req, res) => {
  try {
    // Verify authentication
    const payload = requireAuth(req)
    if (!payload || !payload.userId) {
      logger.warn('[subscriptions/create] Unauthorized request', { ip: req.ip })
      return res.status(401).json({ 
        error: 'unauthorized', 
        message: 'Authentication required' 
      })
    }

    // Get user
    const user = await getUserById(payload.userId)
    if (!user) {
      logger.warn('[subscriptions/create] User not found', { userId: payload.userId })
      return res.status(404).json({ 
        error: 'user_not_found', 
        message: 'User not found' 
      })
    }

    // Check Razorpay configuration
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      logger.error('[subscriptions/create] Razorpay not configured')
      return res.status(500).json({ 
        error: 'razorpay_not_configured', 
        message: 'Payment gateway not configured. Please contact support.' 
      })
    }

    if (!razorpay) {
      logger.error('[subscriptions/create] Razorpay client not initialized')
      return res.status(500).json({ 
        error: 'razorpay_not_configured', 
        message: 'Payment gateway not initialized.' 
      })
    }

    // Get or create Razorpay customer
    let customerId = user.razorpay_customer_id
    if (!customerId) {
      try {
        const customerEmail = user.email || `${user.student_id}@sbmch.local`
        const customerName = user.name || user.student_id || 'User'
        
        logger.info('[subscriptions/create] Creating Razorpay customer', { 
          userId: user.id, 
          email: customerEmail 
        })
        
        const customer = await razorpay.customers.create({ 
          email: customerEmail, 
          name: customerName 
        })
        
        customerId = customer?.id || null
        if (customerId) {
          await query(
            'UPDATE users SET razorpay_customer_id=$1 WHERE id=$2', 
            [customerId, user.id]
          )
          logger.info('[subscriptions/create] Razorpay customer created', { 
            userId: user.id, 
            customerId 
          })
        }
      } catch (err) {
        logger.error('[subscriptions/create] Failed to create customer', { 
          error: err.message, 
          userId: user.id 
        })
        return res.status(500).json({ 
          error: 'customer_creation_failed', 
          message: 'Failed to create payment customer. Please try again.' 
        })
      }
    }

    // Get plan ID (from body or env)
    const planId = (req.body && req.body.plan_id) || RAZORPAY_PLAN_ID
    if (!planId) {
      logger.warn('[subscriptions/create] Plan ID missing', { userId: user.id })
      return res.status(400).json({ 
        error: 'missing_plan_id', 
        message: 'Subscription plan not configured. Please set RAZORPAY_PLAN_ID in environment variables.' 
      })
    }

    // Calculate subscription start time (30 days from now, or use trial_expires_at)
    const trialExpiresAt = user.trial_expires_at 
      ? new Date(user.trial_expires_at) 
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // Default: 30 days from now
    
    const startAtUnix = Math.floor(trialExpiresAt.getTime() / 1000)

    // Create Razorpay subscription
    try {
      logger.info('[subscriptions/create] Creating Razorpay subscription', {
        userId: user.id,
        customerId,
        planId,
        startAt: new Date(startAtUnix * 1000).toISOString()
      })

      const subscription = await razorpay.subscriptions.create({
        plan_id: planId,
        customer_id: customerId,
        total_count: null, // Unlimited recurring (or set to 12 for 12 months)
        start_at: startAtUnix,
        customer_notify: 1,
        notes: { 
          user_id: user.id,
          student_id: user.student_id || null
        }
      })

      const subscriptionId = subscription?.id
      if (!subscriptionId) {
        throw new Error('Subscription ID not returned from Razorpay')
      }

      // Update user with subscription ID
      await query(
        'UPDATE users SET subscription_id=$1, subscription_status=$2 WHERE id=$3',
        [subscriptionId, 'pending_activation', user.id]
      )

      logger.info('[subscriptions/create] Subscription created successfully', {
        userId: user.id,
        subscriptionId
      })

      // Prepare checkout options for frontend (exact format as required)
      const customerEmail = user.email || `${user.student_id}@sbmch.local`
      const customerName = user.name || user.student_id || 'User'
      const customerContact = user.contact || null // Add contact if available
      
      const checkoutOptions = {
        key: RAZORPAY_KEY_ID,
        subscription_id: subscriptionId,
        name: 'SBMCH Attendance',
        description: '28-day access',
        theme: { color: '#0f62fe' },
        prefill: {
          name: customerName,
          email: customerEmail,
          ...(customerContact && { contact: customerContact })
        }
      }

      return res.json({
        subscriptionId: subscriptionId,
        options: checkoutOptions
      })

    } catch (err) {
      logger.error('[subscriptions/create] Razorpay subscription creation failed', {
        error: err.message,
        errorCode: err.error?.code,
        errorDescription: err.error?.description,
        userId: user.id
      })

      // Return helpful error messages
      if (err.error?.code === 'BAD_REQUEST_ERROR') {
        return res.status(400).json({
          error: 'razorpay_bad_request',
          message: err.error?.description || 'Invalid subscription request'
        })
      }

      return res.status(500).json({
        error: 'subscription_creation_failed',
        message: 'Failed to create subscription. Please try again later.'
      })
    }

  } catch (err) {
    logger.error('[subscriptions/create] Unhandled error', {
      error: err.message,
      stack: err.stack
    })
    return res.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected error occurred. Please try again later.'
    })
  }
})

export default router

