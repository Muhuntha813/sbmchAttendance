# SBMCH Attendance Dashboard

Simple attendance dashboard for SBMCH students (React + Vite frontend, Express backend).

## Features

- React + Vite frontend
- Express.js backend with scraping logic
- JWT auth
- Rate limiting, Helmet, CORS restrictions, validation
- `/health` and `/healthz` endpoints

## Quick Setup (Local)

### Install dependencies:

```bash
npm ci
```

### Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

### Development:

- **Backend**: `npm run server` (or `node backend/server.js`)
- **Frontend**: `npm run dev`

### Tests & Lint:

```bash
npm test
npm run lint
```

## Deployment (Render Example)

### Backend (Render - Web Service)

- **Build Command**: `npm ci`
- **Start Command**: `npm run server`

**Env vars to set on Render:**

- `SECRET` (min 32 chars)
- `PORT` (optional, default 3000)
- `NODE_ENV=production`
- `FRONTEND_URL` (comma-separated allowed origins)
- `DATABASE_URL` (if using a managed DB)
- `SENTRY_DSN` (optional)

### Frontend (Render - Static Site)

- **Root Directory**: `frontend`
- **Build Command**: `npm ci && npm run build`
- **Publish Directory**: `dist`
- **Build-time env**: `VITE_API=https://<your-backend>.onrender.com`

## Docker (Local Test)

Build and run:

```bash
docker build -t sbmch-attendance .
docker run -e SECRET=your-jwt-secret -p 3000:3000 sbmch-attendance
```

## Logging & Monitoring

This project includes Winston for structured logs. You can enable Sentry by providing `SENTRY_DSN` in your environment.

## Contributing

Create PRs against main. CI runs build, lint, tests.

