// backend/src/middleware/checkAccess.js
// Middleware to check trial and subscription expiry

import { query } from '../db.js'
import logger from '../../lib/logger.js'

/**
 * Check access middleware - validates trial and subscription expiry
 * Replaces the old checkTrial middleware with full subscription support
 * 
 * Logic:
 * - If subscription_status='active' AND subscription_expires_at > NOW → allow
 * - If subscription_status='trial' AND trial_expires_at > NOW → allow
 * - Otherwise → block and update status to 'expired'
 * 
 * @param {Function} verifyToken - Function to verify JWT token
 * @param {Function} getUserById - Function to get user by ID
 * @returns {Function} Express middleware
 */
export function createCheckAccess(verifyToken, getUserById) {
  return async (req, res, next) => {
    try {
      // Verify token
      const auth = req.headers.authorization
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing Authorization header' })
      }
      const token = auth.slice(7)
      const payload = verifyToken(token)
      if (!payload || !payload.userId) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' })
      }

      // Get user from database
      const user = await getUserById(payload.userId)
      if (!user) {
        return res.status(401).json({ error: 'unauthorized', message: 'User not found' })
      }

      const now = new Date()
      const subscriptionStatus = String(user.subscription_status || 'trial')
      const trialExpiresAt = user.trial_expires_at ? new Date(user.trial_expires_at) : null
      const subscriptionExpiresAt = user.subscription_expires_at ? new Date(user.subscription_expires_at) : null

      // Debug logging - always log to track every check
      logger.info('[checkAccess] Checking access on every request', {
        userId: user.id,
        subscriptionStatus,
        trialExpiresAt: trialExpiresAt?.toISOString(),
        subscriptionExpiresAt: subscriptionExpiresAt?.toISOString(),
        now: now.toISOString(),
        isTrialExpired: trialExpiresAt ? trialExpiresAt <= now : 'no_trial_date',
        isSubscriptionExpired: subscriptionExpiresAt ? subscriptionExpiresAt <= now : 'no_sub_date',
        trialDaysRemaining: trialExpiresAt ? Math.ceil((trialExpiresAt - now) / (1000 * 60 * 60 * 24)) : null
      })

      // Check active subscription
      if (subscriptionStatus === 'active') {
        if (subscriptionExpiresAt && subscriptionExpiresAt > now) {
          // Subscription is active and not expired
          return next()
        } else {
          // Subscription expired - update status
          logger.info('[checkAccess] Subscription expired, updating status', { 
            userId: user.id, 
            subscriptionExpiresAt: subscriptionExpiresAt?.toISOString() 
          })
          await query(
            `UPDATE users SET subscription_status='expired' WHERE id=$1`,
            [user.id]
          )
          return res.status(402).json({ 
            error: 'subscription_expired', 
            message: 'Your subscription has expired. Please renew to continue.' 
          })
        }
      }

      // Check trial
      if (subscriptionStatus === 'trial') {
        // Check if trial has expired
        const isTrialExpired = !trialExpiresAt || trialExpiresAt <= now
        
        if (!isTrialExpired) {
          // Trial is active
          logger.debug('[checkAccess] Trial is active', {
            userId: user.id,
            trialExpiresAt: trialExpiresAt.toISOString(),
            now: now.toISOString()
          })
          return next()
        } else {
          // Trial expired - update status and block access
          logger.warn('[checkAccess] Trial expired, blocking access', { 
            userId: user.id, 
            trialExpiresAt: trialExpiresAt?.toISOString(),
            now: now.toISOString()
          })
          await query(
            `UPDATE users SET subscription_status='expired' WHERE id=$1`,
            [user.id]
          )
          return res.status(402).json({ 
            error: 'trial_expired', 
            message: 'Your free trial has ended. Please subscribe to continue.' 
          })
        }
      }

      // Status is 'expired' - but check if user actually has time left
      // This handles cases where admin updates trial_expires_at in DB
      if (subscriptionStatus === 'expired') {
        logger.info('[checkAccess] User status is expired, checking if trial/subscription was extended', {
          userId: user.id,
          trialExpiresAt: trialExpiresAt?.toISOString(),
          subscriptionExpiresAt: subscriptionExpiresAt?.toISOString(),
          now: now.toISOString()
        })
        
        // Check if trial actually has time left (admin may have extended it)
        if (trialExpiresAt && trialExpiresAt > now) {
          // Trial was extended - restore trial status
          logger.warn('[checkAccess] Trial was extended, restoring trial status', {
            userId: user.id,
            trialExpiresAt: trialExpiresAt.toISOString(),
            now: now.toISOString(),
            daysRemaining: Math.ceil((trialExpiresAt - now) / (1000 * 60 * 60 * 24))
          })
          try {
            await query(
              `UPDATE users SET subscription_status='trial' WHERE id=$1`,
              [user.id]
            )
            logger.info('[checkAccess] Successfully restored trial status', { userId: user.id })
          } catch (updateErr) {
            logger.error('[checkAccess] Failed to restore trial status', {
              userId: user.id,
              error: updateErr.message
            })
            // Continue anyway - don't block access if update fails
          }
          // Allow access with restored trial
          return next()
        }
        
        // Check if subscription actually has time left (admin may have extended it)
        if (subscriptionExpiresAt && subscriptionExpiresAt > now) {
          // Subscription was extended - restore active status
          logger.info('[checkAccess] Subscription was extended, restoring active status', {
            userId: user.id,
            subscriptionExpiresAt: subscriptionExpiresAt.toISOString(),
            now: now.toISOString()
          })
          await query(
            `UPDATE users SET subscription_status='active', notified_subscription_expired=false WHERE id=$1`,
            [user.id]
          )
          // Allow access with restored subscription
          return next()
        }
        
        // Actually expired - block access
        // Check if it was a trial or subscription that expired
        if (trialExpiresAt && (!subscriptionExpiresAt || subscriptionExpiresAt <= trialExpiresAt)) {
          return res.status(402).json({ 
            error: 'trial_expired', 
            message: 'Your free trial has ended. Please subscribe to continue.' 
          })
        } else {
          return res.status(402).json({ 
            error: 'subscription_expired', 
            message: 'Your subscription has expired. Please renew to continue.' 
          })
        }
      }

      // Unknown status - treat as expired
      logger.warn('[checkAccess] Unknown subscription status', { 
        userId: user.id, 
        status: subscriptionStatus 
      })
      return res.status(402).json({ 
        error: 'subscription_expired', 
        message: 'Access expired. Please subscribe to continue.' 
      })
    } catch (err) {
      logger.error('[checkAccess] Error:', { error: err.message, stack: err.stack })
      return res.status(500).json({ 
        error: 'Internal server error', 
        message: 'An error occurred while checking access' 
      })
    }
  }
}

export default { createCheckAccess }

