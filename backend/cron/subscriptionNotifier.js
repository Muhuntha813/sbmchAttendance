// backend/cron/subscriptionNotifier.js
// Cron job to check and notify expired subscriptions and trials

import cron from 'node-cron'
import { query } from '../src/db.js'
import logger from '../lib/logger.js'
import { sendSubscriptionExpiredEmail, sendTrialExpiredEmail } from '../src/lib/email.js'

/**
 * Check and mark expired subscriptions
 * Updates subscription_status to 'expired' and sends email notifications
 */
export async function checkExpiredSubscriptions() {
  try {
    logger.info('[cron] Checking expired subscriptions...')

    // Check expired active subscriptions
    const { rows: expiredSubscriptions } = await query(
      `SELECT id, email, student_id, name, subscription_status, subscription_expires_at, notified_subscription_expired
       FROM users 
       WHERE subscription_status='active' 
         AND subscription_expires_at <= NOW() 
         AND notified_subscription_expired=false`
    )

    for (const user of expiredSubscriptions) {
      try {
        // Update status to expired
        await query(
          `UPDATE users SET subscription_status='expired', notified_subscription_expired=true WHERE id=$1`,
          [user.id]
        )

        // Send email notification
        const emailSent = await sendSubscriptionExpiredEmail(user)
        
        logger.info('[cron] Marked subscription as expired and sent notification', {
          userId: user.id,
          email: user.email || user.student_id,
          emailSent
        })
      } catch (err) {
        logger.error('[cron] Error processing expired subscription', {
          userId: user.id,
          error: err.message
        })
      }
    }

    // Check expired trials
    const { rows: expiredTrials } = await query(
      `SELECT id, email, student_id, name, subscription_status, trial_expires_at, notified_trial_expired
       FROM users 
       WHERE subscription_status='trial' 
         AND trial_expires_at <= NOW()
         AND (notified_trial_expired IS NULL OR notified_trial_expired = FALSE)`
    )

    for (const user of expiredTrials) {
      try {
        // Update status to expired and mark as notified
        await query(
          `UPDATE users SET subscription_status='expired', notified_trial_expired=TRUE WHERE id=$1`,
          [user.id]
        )

        // Send email notification (only if not already notified)
        // Note: We don't have a notified_trial_expired flag, so we'll send once
        // You can add that column if needed to prevent duplicate emails
        const emailSent = await sendTrialExpiredEmail(user)
        
        logger.info('[cron] Marked trial as expired and sent notification', {
          userId: user.id,
          email: user.email || user.student_id,
          emailSent
        })
      } catch (err) {
        logger.error('[cron] Error processing expired trial', {
          userId: user.id,
          error: err.message
        })
      }
    }

    const totalExpired = expiredSubscriptions.length + expiredTrials.length
    if (totalExpired > 0) {
      logger.info('[cron] Processed expired subscriptions and trials', {
        expiredSubscriptions: expiredSubscriptions.length,
        expiredTrials: expiredTrials.length,
        total: totalExpired
      })
    } else {
      logger.debug('[cron] No expired subscriptions or trials found')
    }
  } catch (err) {
    logger.error('[cron] Error in checkExpiredSubscriptions', {
      error: err.message,
      stack: err.stack
    })
  }
}

/**
 * Start the cron job
 * Runs every hour at minute 0 (e.g., 1:00, 2:00, 3:00)
 * You can change the schedule as needed
 */
export function startSubscriptionNotifier() {
  // Run every hour at minute 0
  const schedule = process.env.SUBSCRIPTION_CRON_SCHEDULE || '0 * * * *'
  
  logger.info('[cron] Starting subscription notifier', { schedule })
  
  cron.schedule(schedule, async () => {
    await checkExpiredSubscriptions()
  })

  // Also run immediately on startup (optional - remove if not desired)
  // checkExpiredSubscriptions().catch(err => {
  //   logger.error('[cron] Error in initial subscription check', { error: err.message })
  // })
}

export default {
  checkExpiredSubscriptions,
  startSubscriptionNotifier
}

