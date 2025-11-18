// backend/tools/testSubscriptionFlow.js
// End-to-end test script for subscription flow
// Tests: Login → Create Subscription → Simulate Webhook → Verify DB

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load .env from project root
dotenv.config({ 
  path: path.resolve(__dirname, '..', '..', '.env')
})

const API_BASE = process.env.API_BASE || 'http://localhost:3000'
const TEST_STUDENT_ID = process.env.TEST_STUDENT_ID || 'test123'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'testpass'

async function testSubscriptionFlow() {
  console.log('========================================')
  console.log('Subscription Flow Test')
  console.log('========================================\n')

  try {
    // Step 1: Login
    console.log('Step 1: Logging in...')
    const loginResp = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_id: TEST_STUDENT_ID,
        password: TEST_PASSWORD
      })
    })

    if (!loginResp.ok) {
      const error = await loginResp.json().catch(() => ({ message: 'Login failed' }))
      throw new Error(`Login failed: ${error.message || loginResp.statusText}`)
    }

    const loginData = await loginResp.json()
    const token = loginData.token
    const userId = loginData.user?.id

    if (!token) {
      throw new Error('No token received from login')
    }

    console.log('✅ Login successful')
    console.log(`   User ID: ${userId}`)
    console.log(`   Token: ${token.substring(0, 20)}...\n`)

    // Step 2: Create Subscription
    console.log('Step 2: Creating subscription...')
    const subResp = await fetch(`${API_BASE}/api/subscriptions/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    })

    if (!subResp.ok) {
      const error = await subResp.json().catch(() => ({ message: 'Subscription creation failed' }))
      throw new Error(`Subscription creation failed: ${error.message || subResp.statusText}`)
    }

    const subData = await subResp.json()
    const subscriptionId = subData.subscriptionId || subData.subscription_id
    const options = subData.options || subData.checkout_options

    if (!subscriptionId) {
      throw new Error('No subscription ID received')
    }

    console.log('✅ Subscription created')
    console.log(`   Subscription ID: ${subscriptionId}`)
    console.log(`   Checkout Options: ${JSON.stringify(options, null, 2)}\n`)

    // Step 3: Simulate Webhook (subscription.activated)
    console.log('Step 3: Simulating webhook (subscription.activated)...')
    
    const webhookPayload = {
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: {
            id: subscriptionId,
            status: 'active',
            plan_id: process.env.RAZORPAY_PLAN_ID || 'plan_test',
            notes: {
              user_id: userId || '1'
            }
          }
        },
        payment: {
          entity: {
            id: `pay_test_${Date.now()}`,
            amount: 4900, // ₹49 in paise
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    }

    // Compute signature
    const crypto = await import('crypto')
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET
    if (!secret) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET not set')
    }

    const rawBody = JSON.stringify(webhookPayload)
    const signature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')

    const webhookResp = await fetch(`${API_BASE}/api/webhook/razorpay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': signature
      },
      body: rawBody
    })

    if (!webhookResp.ok) {
      const error = await webhookResp.json().catch(() => ({ message: 'Webhook failed' }))
      throw new Error(`Webhook failed: ${error.message || webhookResp.statusText}`)
    }

    const webhookData = await webhookResp.json()
    console.log('✅ Webhook processed')
    console.log(`   Response: ${JSON.stringify(webhookData, null, 2)}\n`)

    // Step 4: Verify Subscription Status
    console.log('Step 4: Verifying subscription status...')
    const statusResp = await fetch(`${API_BASE}/api/auth/status`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })

    if (!statusResp.ok) {
      throw new Error(`Status check failed: ${statusResp.statusText}`)
    }

    const statusData = await statusResp.json()
    console.log('✅ Status retrieved')
    console.log(`   Subscription Status: ${statusData.subscription_status}`)
    console.log(`   Subscription Expires At: ${statusData.subscription_expires_at}`)
    console.log(`   Subscription Started At: ${statusData.subscription_started_at}\n`)

    // Step 5: Verify Access (should work now)
    console.log('Step 5: Testing protected endpoint access...')
    const attendanceResp = await fetch(`${API_BASE}/api/attendance`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })

    if (attendanceResp.status === 402) {
      console.log('⚠️  Access still blocked (subscription may not be active yet)')
      const error = await attendanceResp.json().catch(() => ({}))
      console.log(`   Error: ${error.message || 'Payment required'}`)
    } else if (attendanceResp.ok) {
      console.log('✅ Access granted - subscription is active!')
    } else {
      console.log(`⚠️  Unexpected status: ${attendanceResp.status}`)
    }

    console.log('\n========================================')
    console.log('✅ Test Flow Complete!')
    console.log('========================================')

  } catch (err) {
    console.error('\n❌ Test Failed:', err.message)
    console.error(err.stack)
    process.exit(1)
  }
}

// Run test
testSubscriptionFlow()




