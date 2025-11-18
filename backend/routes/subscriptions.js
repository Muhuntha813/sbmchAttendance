import express from 'express'
import Razorpay from 'razorpay'
import jwt from 'jsonwebtoken'
import { query } from '../src/db.js'
import logger from '../lib/logger.js'

const router = express.Router()

const JWT_SECRET = process.env.JWT_SECRET || process.env.SECRET || 'dev-secret-for-local'
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || ''
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || ''
const RAZORPAY_PLAN_ID = process.env.RAZORPAY_PLAN_ID || ''

const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (err) {
    return null
  }
}

async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id])
  return rows[0] || null
}

// Create subscription endpoint
router.post('/create', async (req, res) => {
  try {
    // Verify authentication
    const auth = req.headers.authorization || ''
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    const token = auth.slice(7)
    const payload = verifyToken(token)
    if (!payload || !payload.userId) {
      return res.status(401).json({ error: 'unauthorized' })
    }

    // Get user
    const user = await getUserById(payload.userId)
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' })
    }

    // Check Razorpay configuration
    if (!razorpay) {
      return res.status(500).json({ error: 'razorpay_not_configured' })
    }

    if (!RAZORPAY_PLAN_ID) {
      return res.status(500).json({ error: 'razorpay_plan_not_configured' })
    }

    // Get or create Razorpay customer
    let customerId = user.razorpay_customer_id
    if (!customerId) {
      const email = user.email || user.student_id || `user_${user.id}@example.com`
      const name = user.name || email
      try {
        const customer = await razorpay.customers.create({ email, name })
        customerId = customer?.id || null
        if (customerId) {
          await query('UPDATE users SET razorpay_customer_id=$1 WHERE id=$2', [customerId, user.id])
          logger.info('[subscriptions] Created Razorpay customer', { userId: user.id, customerId })
        }
      } catch (err) {
        logger.error('[subscriptions] Failed to create Razorpay customer', { error: err.message })
        return res.status(500).json({ error: 'customer_creation_failed' })
      }
    }

    // Create subscription
    try {
      const subscription = await razorpay.subscriptions.create({
        plan_id: RAZORPAY_PLAN_ID,
        customer_notify: 1,
        total_count: 1, // One-time payment subscription
        notes: {
          user_id: user.id
        }
      })

      const subscriptionId = subscription?.id || null
      if (!subscriptionId) {
        throw new Error('No subscription ID returned from Razorpay')
      }

      // Save subscription_id to user
      await query('UPDATE users SET subscription_id=$1 WHERE id=$2', [subscriptionId, user.id])

      logger.info('[subscriptions] Created subscription', { userId: user.id, subscriptionId })

      // Return checkout options for Razorpay
      const options = {
        key: RAZORPAY_KEY_ID,
        subscription_id: subscriptionId,
        name: 'SBMCH Attendance',
        description: '28-day access to attendance tracking',
        prefill: {
          email: user.email || user.student_id || undefined,
          name: user.name || undefined
        },
        notes: {
          user_id: user.id
        },
        theme: {
          color: '#0f62fe'
        }
      }

      return res.json({
        subscriptionId,
        subscription_id: subscriptionId, // Support both formats
        options
      })
    } catch (err) {
      logger.error('[subscriptions] Failed to create subscription', { 
        error: err.message, 
        userId: user.id,
        stack: err.stack 
      })
      return res.status(500).json({ 
        error: 'subscription_creation_failed', 
        message: err.message 
      })
    }
  } catch (err) {
    logger.error('[subscriptions] Unexpected error', { error: err.message, stack: err.stack })
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
