# SBMCH Attendance

Simple attendance dashboard for SBMCH students, powered by an Express backend and a React + Vite frontend.

## Setup

- Install dependencies: `npm ci`
- Copy environment template: `cp .env.example .env`
- Provide required environment variables (`SECRET`, `FRONTEND_URL`, optional `SENTRY_DSN`, etc.) in `.env`

## Dev

- Start the backend API: `npm run server`
- Launch the Vite frontend: `npm run dev`
- The frontend runs on `http://localhost:5173` by default and proxies requests to the backend.

## Test

- Run the Vitest suite: `npm test`
- Use `npm test -- --watch` for watch mode during development.

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

