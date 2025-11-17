// backend/tools/webhookTest.js
// Simple webhook test runner for Razorpay webhooks via ngrok

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load environment variables from project root .env file
dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

// Configuration - UPDATE THIS WITH YOUR NGROK URL
// Option 1: Set NGROK_URL in backend/.env (recommended)
// Option 2: Update the default value below
const NGROK_URL = process.env.NGROK_URL || 'https://micha-unmenacing-adrien.ngrok-free.dev'
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET

if (!WEBHOOK_SECRET) {
  console.error('❌ ERROR: RAZORPAY_WEBHOOK_SECRET not found in backend/.env')
  console.error('   Please add: RAZORPAY_WEBHOOK_SECRET=your_secret_here')
  process.exit(1)
}

// Load payload from payload.json
const payloadPath = path.join(__dirname, 'payload.json')
let payload
try {
  const payloadText = fs.readFileSync(payloadPath, 'utf8')
  payload = JSON.parse(payloadText)
  console.log('✅ Loaded payload from payload.json')
} catch (err) {
  console.error('❌ ERROR: Failed to load payload.json')
  console.error('   Error:', err.message)
  process.exit(1)
}

// Convert payload to string for signature computation
const payloadString = JSON.stringify(payload)

// Compute HMAC SHA256 signature
const signature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(payloadString)
  .digest('hex')

console.log('')
console.log('========================================')
console.log('Razorpay Webhook Test Runner')
console.log('========================================')
console.log('NGROK URL:', NGROK_URL)
console.log('Webhook Endpoint:', `${NGROK_URL}/api/webhook/razorpay`)
console.log('Event Type:', payload.event || 'unknown')
console.log('Signature:', signature)
console.log('========================================')
console.log('')

// Send webhook
const webhookUrl = `${NGROK_URL}/api/webhook/razorpay`

try {
  console.log('📤 Sending webhook...')
  
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signature
    },
    body: payloadString
  })

  const responseText = await response.text()
  let responseBody
  try {
    responseBody = JSON.parse(responseText)
  } catch {
    responseBody = responseText
  }

  console.log('')
  console.log('========================================')
  console.log('Response')
  console.log('========================================')
  console.log('Status Code:', response.status)
  console.log('Status Text:', response.statusText)
  console.log('Response Body:')
  console.log(JSON.stringify(responseBody, null, 2))
  console.log('========================================')
  console.log('')

  if (response.ok) {
    console.log('✅ Webhook sent successfully!')
    console.log('   Status:', response.status)
    if (responseBody && responseBody.ok) {
      console.log('   Server confirmed: OK')
    }
  } else {
    console.log('⚠️  Webhook returned error status')
    console.log('   Status:', response.status)
    if (responseBody && responseBody.error) {
      console.log('   Error:', responseBody.error)
      if (responseBody.message) {
        console.log('   Message:', responseBody.message)
      }
      if (responseBody.error === 'invalid_signature') {
        console.log('')
        console.log('❌ SIGNATURE VERIFICATION FAILED')
        console.log('   Check that RAZORPAY_WEBHOOK_SECRET in backend/.env')
        console.log('   matches the webhook secret in Razorpay dashboard.')
      }
    }
  }

} catch (err) {
  console.error('')
  console.error('❌ ERROR: Failed to send webhook')
  console.error('   Error:', err.message)
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
    console.error('')
    console.error('   Connection failed. Check:')
    console.error('   1. Ngrok is running and forwarding to localhost:3000')
    console.error('   2. NGROK_URL in this script matches your ngrok URL')
    console.error('   3. Backend is running on localhost:3000')
  }
  process.exit(1)
}

