# SBMCH Attendance

Simple attendance dashboard for SBMCH students, powered by an Express backend and a React + Vite frontend.

## Setup

- Install dependencies: `npm ci`
- Copy environment template: `cp .env.example .env`
  - Fill in backend variables (`DATABASE_URL`, `JWT_SECRET`, `SCRAPER_URL`, `SCRAPER_TIMEOUT_MS`, `PORT`, `ALLOW_CREATE_IF_SCRAPER_DOWN`, `ADMIN_API_KEY`)
  - Optionally set `VITE_API_URL` (or `REACT_APP_API_URL`) if you want to override auto-detection on the frontend
- For local development, point `SCRAPER_URL` to the mock scraper (`http://localhost:4000`)

## Dev

1. **Run the mock scraper (dev helper):** `node mock-scraper.js`
   - Responds on `http://localhost:4000`
   - Returns `found=true` for IDs starting with `known` or `std`, `found=false` otherwise
2. **Start the backend API:** `npm run server`
   - Backend runs on port 3000 by default (or the port specified in `PORT`)
   - Logs the configured `DATABASE_URL` and `SCRAPER_URL` on startup for debugging
3. **Launch the Vite frontend:** `npm run dev`
   - Frontend runs on `http://localhost:5173`
   - Auto-detects the backend by trying common ports (3000, 3001, etc.)
   - Use the "Set Backend" button on the login form to override the base URL (stored in `localStorage.API_OVERRIDE`)

### Scraper verification & admin tools

- First login for a new `student_id` calls the scraper (`SCRAPER_URL/{student_id}`) to verify the account.
- Successful responses create a local user, start a 30-day trial automatically, and mark `needs_verification=false`.
- When the scraper reports `found=false`, the attempt is stored in the `scraper_failures` table and the API returns `404`.
- If the scraper is unreachable:
  - With `ALLOW_CREATE_IF_SCRAPER_DOWN=true` (or when `NODE_ENV=development`), the user is created with `needs_verification=true` so an admin can confirm later.
  - Otherwise the API responds with `502 { error: 'scraper_unavailable' }`.
- Admins can review pending users via `GET /api/admin/unverified` with the header `x-admin-key: <ADMIN_API_KEY>`.

**Backend URL Configuration:**
- **Auto-detection**: The frontend automatically tries common backend ports (3000, 3001, etc.)
- **Environment variable**: Set `VITE_API_URL=http://localhost:YOUR_PORT` in `.env` for explicit configuration
- **Manual override**: If auto-detection fails, use the "Set Backend" button on the login page to enter a custom URL
- The override is saved in `localStorage.API_OVERRIDE` and persists across sessions

**Troubleshooting:**
- If you see "Verification service unavailable" on login:
  - Ensure backend is running
  - Click "Set Backend" button and enter the correct backend URL (e.g., `http://localhost:3000`)
  - Check browser console (F12) for detailed connection logs
- Backend must have CORS enabled for the frontend origin

## Attendance Data Polling

After login, the frontend may receive a `202 (Pending)` response from `/api/attendance` if the background scraper hasn't finished yet. The frontend should implement polling with exponential backoff.

### Polling Strategy

1. **Initial Request**: Call `/api/attendance` immediately after login
2. **If 202 Response**: Poll with backoff:
   - Attempt 1: Wait 1 second
   - Attempt 2: Wait 2 seconds  
   - Attempt 3: Wait 3 seconds
   - Attempt 4: Wait 4 seconds
   - Attempt 5: Wait 5 seconds
   - Attempt 6: Wait 6 seconds
   - **Total**: Up to 6 attempts (~21 seconds total)
3. **Stop Polling On**:
   - HTTP 200: Use the returned data
   - HTTP 500: Show error message
   - After 6 attempts: Show fallback/demo data

### Example Frontend Implementation

```javascript
async function fetchAttendanceWithPolling(token, maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('/api/attendance', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.status === 200) {
        return await response.json(); // Success!
      }
      
      if (response.status === 202) {
        // Still pending, wait and retry
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          continue;
        }
      }
      
      if (response.status === 500) {
        throw new Error('Server error');
      }
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  
  // Fallback to demo data after all attempts
  return getDemoData();
}
```

### Configuration

- **`SCRAPE_WAIT_MS`** (default: 12000ms): Maximum time the login endpoint will wait for the scraper to finish before returning the token. Set to `0` to disable waiting entirely (client polling only).

### Server Logs

Watch for these log messages to track scraping progress:
- `[auth/login] Triggering attendance scrape for <username>`
- `[auth] Scrape job started for <username>`
- `[scraperService] LMS login successful for <username>`
- `[scraperService] Successfully inserted N attendance rows for <username>, latest id <id>`
- `[attendance] no snapshot for <username> — returning 202`
- `[attendance] returned snapshot fetchedAt=<timestamp> for <username>`

## Payment Integration

The platform supports Razorpay subscriptions for paid access after the 30-day free trial.

### Setup

1. **Create Razorpay Account:**
   - Sign up at https://razorpay.com
   - Get test API keys from Settings → API Keys
   - Create a plan (₹49, 28-day cycle) in Products → Plans

2. **Configure Environment:**
   ```ini
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=your_test_key_secret
   RAZORPAY_PLAN_ID=plan_xxxxxxxxxxxxx
   RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
   ```

3. **Run Database Migrations:**
   ```bash
   # See SQL_MIGRATIONS.sql for exact statements
   psql $DATABASE_URL -f SQL_MIGRATIONS.sql
   ```

4. **Test Webhook Locally (with ngrok):**
   ```bash
   # Install ngrok
   npm install -g ngrok
   
   # Expose backend
   ngrok http 3000
   
   # Update webhook URL in Razorpay dashboard to ngrok URL
   ```

### Testing

See `TEST_STEPS.md` for complete testing guide including:
- User creation and trial expiry
- Subscription creation
- Razorpay Checkout flow
- Webhook simulation
- Idempotency verification

### Test Scripts

- **Webhook Tester:** `./tools/send_razorpay_webhook.sh`
- **Full Flow Test:** `./tools/test_payment_flow.sh`
- **Postman Collection:** `tools/postman_collection.json`

## Test

- Run the Vitest suite: `npm test`
- Use `npm test -- --watch` for watch mode during development.
- See `TEST_STEPS.md` for payment integration testing.

## Lint

- Check lint status: `npm run lint`
- Auto-fix where possible: `npm run lint:fix`

## Deployment (Render)

### Backend (Web Service)

- **Build Command:** `npm ci`
- **Start Command:** `npm run server`
- **Environment Variables:** `SECRET`, `FRONTEND_URL`, `NODE_ENV=production`, optional `SENTRY_DSN`, `LOG_LEVEL`, others as needed.

### Frontend (Static Site)

- **Root Directory:** `frontend`
- **Build Command:** `npm ci && npm run build`
- **Publish Directory:** `dist`
- **Build Env:** `VITE_API=https://<your-backend-service>.onrender.com`

After deploying, confirm both services share the same `SECRET` and allowed origins so the dashboard can authenticate against the API.

