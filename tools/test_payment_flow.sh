#!/bin/bash
# test_payment_flow.sh
# Complete payment flow test script
#
# Prerequisites:
#   1. Backend running on http://localhost:3000
#   2. Database accessible
#   3. Valid LMS credentials for testing
#
# Usage: ./test_payment_flow.sh

set -e

BASE_URL="http://localhost:3000"
STUDENT_ID="std1582"
PASSWORD="test_password"

echo "=== Payment Flow Test ==="
echo ""

# A) Create user via login (first-login triggers trial creation)
echo "Step A: Creating user via login..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"student_id\": \"$STUDENT_ID\", \"password\": \"$PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  echo "❌ Login failed. Response: $LOGIN_RESPONSE"
  exit 1
fi
echo "✅ Login successful. Token: ${TOKEN:0:20}..."
echo ""

# B) Force trial expiry via SQL
echo "Step B: Expiring trial in database..."
echo "Run this SQL manually:"
echo "UPDATE users SET trial_expires_at = NOW() - interval '1 day' WHERE student_id = '$STUDENT_ID';"
echo "Press Enter after running SQL..."
read
echo ""

# C) Attempt protected request -> expect trial_expired
echo "Step C: Testing protected endpoint with expired trial..."
ATTENDANCE_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X GET "$BASE_URL/api/attendance" \
  -H "Authorization: Bearer $TOKEN")

HTTP_STATUS=$(echo "$ATTENDANCE_RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$ATTENDANCE_RESPONSE" | sed '/HTTP_STATUS/d')

if [ "$HTTP_STATUS" = "402" ]; then
  ERROR=$(echo "$BODY" | jq -r '.error // empty')
  if [ "$ERROR" = "trial_expired" ]; then
    echo "✅ Correctly returned 402 with trial_expired"
  else
    echo "⚠️  Got 402 but error is: $ERROR"
  fi
else
  echo "❌ Expected 402, got $HTTP_STATUS"
  echo "Response: $BODY"
fi
echo ""

# D) Start Razorpay Checkout (manual step)
echo "Step D: Razorpay Checkout"
echo "This requires frontend integration. For now, manually:"
echo "1. Call POST /api/subscriptions/create with token"
echo "2. Initialize Razorpay Checkout with returned subscription_id"
echo "3. Complete payment in Razorpay test mode"
echo ""

# E) Simulate successful payment via webhook
echo "Step E: Simulating successful payment via webhook..."
WEBHOOK_SECRET="${RAZORPAY_WEBHOOK_SECRET:-test_secret}"
./send_razorpay_webhook.sh "subscription.activated" "$WEBHOOK_SECRET" "$BASE_URL/api/webhook/razorpay"
echo ""

# F) Verify DB: subscription_status active
echo "Step F: Verify database (run manually):"
echo "SELECT subscription_status, subscription_expires_at FROM users WHERE student_id = '$STUDENT_ID';"
echo "Expected: subscription_status='active', subscription_expires_at ≈ NOW() + 28 days"
echo ""

# G) Re-run protected request -> 200
echo "Step G: Testing protected endpoint after subscription activation..."
ATTENDANCE_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X GET "$BASE_URL/api/attendance" \
  -H "Authorization: Bearer $TOKEN")

HTTP_STATUS=$(echo "$ATTENDANCE_RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
if [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ Access granted (200 OK)"
else
  echo "❌ Expected 200, got $HTTP_STATUS"
fi
echo ""

echo "=== Test Complete ==="












