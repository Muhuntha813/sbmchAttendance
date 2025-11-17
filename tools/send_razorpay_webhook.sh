#!/bin/bash
# send_razorpay_webhook.sh
# Sends a signed Razorpay webhook event to backend for testing
#
# Usage:
#   Option 1: Use predefined event types
#     ./send_razorpay_webhook.sh <event_type> <webhook_secret> [webhook_url]
#
#   Option 2: Use custom JSON file
#     ./send_razorpay_webhook.sh --file <payload.json> <webhook_secret> [webhook_url]
#
# Examples:
#   ./send_razorpay_webhook.sh subscription.activated "your_secret" "http://localhost:3000/api/webhook/razorpay"
#   ./send_razorpay_webhook.sh --file webhook_payload.json "your_secret"
#
# Event types: subscription.activated, invoice.paid, payment.captured

set -e

# Check if using file mode
if [ "$1" = "--file" ]; then
  PAYLOAD_FILE="$2"
  SECRET="$3"
  WEBHOOK_URL="${4:-http://localhost:3000/api/webhook/razorpay}"
  
  if [ ! -f "$PAYLOAD_FILE" ]; then
    echo "Error: Payload file not found: $PAYLOAD_FILE"
    exit 1
  fi
  
  PAYLOAD=$(cat "$PAYLOAD_FILE")
  EVENT_TYPE="custom"
else
  EVENT_TYPE="${1:-subscription.activated}"
  SECRET="${2:-test_webhook_secret}"
  WEBHOOK_URL="${3:-http://localhost:3000/api/webhook/razorpay}"

  # Sample event payloads
  case "$EVENT_TYPE" in
    "subscription.activated")
      PAYLOAD='{
        "event": "subscription.activated",
        "payload": {
          "subscription": {
            "entity": {
              "id": "sub_test123",
              "status": "active",
              "plan_id": "plan_test123",
              "notes": {
                "user_id": "00000000-0000-0000-0000-000000000001"
              }
            }
          }
        }
      }'
      ;;
    "invoice.paid")
      PAYLOAD='{
        "event": "invoice.paid",
        "payload": {
          "invoice": {
            "entity": {
              "id": "inv_test123",
              "subscription_id": "sub_test123",
              "amount": 4900,
              "currency": "INR",
              "status": "paid",
              "notes": {
                "user_id": "00000000-0000-0000-0000-000000000001"
              }
            }
          },
          "payment": {
            "entity": {
              "id": "pay_test123",
              "amount": 4900,
              "currency": "INR",
              "status": "captured"
            }
          }
        }
      }'
      ;;
    "payment.captured")
      PAYLOAD='{
        "event": "payment.captured",
        "payload": {
          "payment": {
            "entity": {
              "id": "pay_test123",
              "amount": 4900,
              "currency": "INR",
              "status": "captured"
            }
          }
        }
      }'
      ;;
    *)
      echo "Unknown event type: $EVENT_TYPE"
      echo "Supported: subscription.activated, invoice.paid, payment.captured"
      echo "Or use --file <payload.json> for custom payload"
      exit 1
      ;;
  esac
fi

# Compute HMAC SHA256 signature
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

echo "=========================================="
echo "Razorpay Webhook Tester"
echo "=========================================="
echo "Event Type: $EVENT_TYPE"
echo "URL: $WEBHOOK_URL"
echo "Signature: $SIGNATURE"
echo "=========================================="
echo ""

# Send webhook
echo "Sending webhook..."
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIGNATURE" \
  -d "$PAYLOAD")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

echo "Response Status: $HTTP_STATUS"
echo "Response Body:"
echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ Webhook sent successfully!"
else
  echo "⚠️  Webhook returned status $HTTP_STATUS"
fi
