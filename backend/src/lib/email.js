// backend/src/lib/email.js
// Email notification utilities

import logger from '../../lib/logger.js'

// Email configuration from environment
const SMTP_HOST = process.env.SMTP_HOST || ''
const SMTP_PORT = Number(process.env.SMTP_PORT || 587)
const SMTP_USER = process.env.SMTP_USER || ''
const SMTP_PASS = process.env.SMTP_PASSWORD || ''
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'noreply@sbmch-attendance.com'
const SMTP_ENABLED = SMTP_HOST && SMTP_USER && SMTP_PASS

let nodemailer = null
let transporter = null

// Lazy load nodemailer
async function getTransporter() {
  if (!SMTP_ENABLED) {
    logger.warn('[email] SMTP not configured - emails will be logged only')
    return null
  }

  if (!transporter) {
    try {
      // Use dynamic import for ESM compatibility
      if (!nodemailer) {
        nodemailer = (await import('nodemailer')).default
      }
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS
        }
      })
      logger.info('[email] SMTP transporter initialized', { host: SMTP_HOST, port: SMTP_PORT })
    } catch (err) {
      logger.error('[email] Failed to initialize nodemailer', { error: err.message })
      return null
    }
  }
  return transporter
}

/**
 * Send subscription expired email
 * @param {Object} user - User object with email and name
 * @returns {Promise<boolean>} - True if sent successfully, false otherwise
 */
export async function sendSubscriptionExpiredEmail(user) {
  const email = user.email || user.student_id
  const name = user.name || user.student_id || 'User'
  
  if (!email) {
    logger.warn('[email] Cannot send subscription expired email - no email address', { userId: user.id })
    return false
  }

  const subject = 'Your SBMCH Attendance Subscription Has Expired'
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #3399cc; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f9f9f9; }
        .button { display: inline-block; padding: 12px 24px; background-color: #3399cc; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>SBMCH Attendance</h1>
        </div>
        <div class="content">
          <h2>Subscription Expired</h2>
          <p>Hello ${name},</p>
          <p>Your subscription to SBMCH Attendance has expired. To continue accessing your attendance data and features, please renew your subscription.</p>
          <p style="text-align: center;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/pay" class="button">Renew Subscription</a>
          </p>
          <p>If you have any questions, please contact support.</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} SBMCH Attendance. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `

  const text = `
Hello ${name},

Your subscription to SBMCH Attendance has expired. To continue accessing your attendance data and features, please renew your subscription.

Visit: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/pay

If you have any questions, please contact support.

© ${new Date().getFullYear()} SBMCH Attendance. All rights reserved.
  `

  const mailOptions = {
    from: SMTP_FROM,
    to: email,
    subject,
    text,
    html
  }

  const transport = await getTransporter()
  if (!transport) {
    // Log email instead of sending
    logger.info('[email] Subscription expired email (not sent - SMTP disabled)', {
      to: email,
      subject,
      text
    })
    return true // Return true since we "handled" it
  }

  try {
    const info = await transport.sendMail(mailOptions)
    logger.info('[email] Subscription expired email sent', {
      to: email,
      messageId: info.messageId
    })
    return true
  } catch (err) {
    logger.error('[email] Failed to send subscription expired email', {
      to: email,
      error: err.message
    })
    return false
  }
}

/**
 * Send trial expired email
 * @param {Object} user - User object with email and name
 * @returns {Promise<boolean>} - True if sent successfully, false otherwise
 */
export async function sendTrialExpiredEmail(user) {
  const email = user.email || user.student_id
  const name = user.name || user.student_id || 'User'
  
  if (!email) {
    logger.warn('[email] Cannot send trial expired email - no email address', { userId: user.id })
    return false
  }

  const subject = 'Your SBMCH Attendance Free Trial Has Ended'
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #3399cc; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f9f9f9; }
        .button { display: inline-block; padding: 12px 24px; background-color: #3399cc; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>SBMCH Attendance</h1>
        </div>
        <div class="content">
          <h2>Free Trial Ended</h2>
          <p>Hello ${name},</p>
          <p>Your 30-day free trial has ended. To continue accessing your attendance data and features, please subscribe now.</p>
          <p style="text-align: center;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/pay" class="button">Subscribe Now</a>
          </p>
          <p>If you have any questions, please contact support.</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} SBMCH Attendance. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `

  const text = `
Hello ${name},

Your 30-day free trial has ended. To continue accessing your attendance data and features, please subscribe now.

Visit: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/pay

If you have any questions, please contact support.

© ${new Date().getFullYear()} SBMCH Attendance. All rights reserved.
  `

  const mailOptions = {
    from: SMTP_FROM,
    to: email,
    subject,
    text,
    html
  }

  const transport = await getTransporter()
  if (!transport) {
    // Log email instead of sending
    logger.info('[email] Trial expired email (not sent - SMTP disabled)', {
      to: email,
      subject,
      text
    })
    return true // Return true since we "handled" it
  }

  try {
    const info = await transport.sendMail(mailOptions)
    logger.info('[email] Trial expired email sent', {
      to: email,
      messageId: info.messageId
    })
    return true
  } catch (err) {
    logger.error('[email] Failed to send trial expired email', {
      to: email,
      error: err.message
    })
    return false
  }
}

export default {
  sendSubscriptionExpiredEmail,
  sendTrialExpiredEmail
}

