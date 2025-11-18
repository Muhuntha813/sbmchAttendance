// server.js (ESM)
// IMPORTANT: Load environment variables FIRST, before any modules that depend on them
import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import fetchCookie from 'fetch-cookie';
import * as cheerio from 'cheerio';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import logger from './lib/logger.js';
import Razorpay from 'razorpay';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import subscriptionsRouter from './routes/subscriptions.js';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createCheckAccess } from './src/middleware/checkAccess.js';

const app = express();

// Security headers
app.use(helmet());

app.use(bodyParser.json());

// Rate limiting - skip for localhost in development
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 1000 : 100, // Much higher limit in dev
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again later.',
  // Skip rate limiting for localhost in development
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || ''
      const isLocalhost = ip === '127.0.0.1' || 
                          ip === '::1' || 
                          ip === '::ffff:127.0.0.1' || 
                          ip.startsWith('127.0.0.1') || 
                          ip.startsWith('::1') ||
                          ip === 'localhost' ||
                          !ip || ip === 'undefined'
      if (isLocalhost) {
        return true // Skip rate limiting for localhost in dev
      }
    }
    return false
  }
});

// --- CORS + Request Logging ---
// IMPORTANT: CORS must be applied BEFORE routes to handle OPTIONS preflight requests
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:3000',
      'http://localhost:3001'
    ];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow any localhost port for development
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return callback(null, true);
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

app.use('/api/', apiLimiter);
// Mount new auth router for student_id-based login + trial creation
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/subscriptions', subscriptionsRouter);

// Log every incoming request for debugging (without leaking sensitive payloads)
app.use((req, res, next) => {
  const start = Date.now();
  const { method, originalUrl } = req;
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    logger.info(`[req] ${method} ${originalUrl}`, {
      status: res.statusCode,
      durationMs,
      ip: req.ip,
    });
  });
  next();
});
// --- End CORS + Logging ---

// Enforce SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SECRET) {
  logger.error('FATAL: SECRET env var is required in production');
  process.exit(1);
}

// Use JWT_SECRET if set, otherwise SECRET, otherwise dev fallback
const SECRET = process.env.JWT_SECRET || process.env.SECRET || 'dev-secret-for-local';
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL || '';
const SCRAPER_URL = process.env.SCRAPER_URL || '';
if (DB_URL) {
  // Log connection info (without password)
  const dbInfo = DB_URL.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
  logger.info('Database URL configured', { url: dbInfo });
} else {
  logger.warn('DATABASE_URL not set in environment');
}
if (SCRAPER_URL) {
  logger.info('Scraper URL configured', { url: SCRAPER_URL });
} else {
  logger.warn('SCRAPER_URL not set - scraper verification disabled');
}
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_PLAN_ID = process.env.RAZORPAY_PLAN_ID || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

// Razorpay configuration validation (only warn if partially configured)
// Note: Razorpay is optional - only required if using payment features
if (process.env.NODE_ENV === 'production') {
  const razorpayVars = [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_PLAN_ID, RAZORPAY_WEBHOOK_SECRET];
  const configuredCount = razorpayVars.filter(v => v).length;
  
  if (configuredCount > 0 && configuredCount < 4) {
    logger.warn('Razorpay partially configured - payment features may not work correctly', {
      configured: configuredCount,
      total: 4
    });
  } else if (configuredCount === 0) {
    logger.info('Razorpay not configured - payment features disabled');
  } else {
    logger.info('Razorpay fully configured - payment features enabled');
  }
}

// File storage removed - now using database storage
// const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
// if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Simple in-memory rate limiter & scrape trackers ---
const lastLoginAt = {}; // username -> timestamp ms
const scrapingStatus = {}; // username -> { running: boolean, promise: Promise }

// ---- Subscriptions / DB ----
const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false
});

const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

// --- Helpers ---
function signToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (err) {
    logger.debug('JWT verification failed', { message: err.message });
    return null;
  }
}

// File write function removed - now using database storage
// function atomicWrite(filePath, data) {
//   const tmp = filePath + '.tmp';
//   fs.writeFileSync(tmp, data, 'utf8');
//   fs.renameSync(tmp, filePath);
// }

// ---------- DB helpers and schema ----------
async function ensureSchema() {
  try {
    if (!DB_URL) {
      logger.warn('DATABASE_URL not set - skipping schema initialization');
      return;
    }
    // Test connection first
    await pool.query('SELECT 1');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text UNIQUE,
        password_hash text NOT NULL,
        razorpay_customer_id text,
        subscription_id text,
        trial_started_at timestamptz NOT NULL DEFAULT now(),
        trial_expires_at timestamptz NOT NULL,
        subscription_status text NOT NULL DEFAULT 'trial',
        created_at timestamptz NOT NULL DEFAULT now(),
        student_id text,
        name text,
        scraper_checked_at timestamptz,
        scraper_exists boolean DEFAULT NULL,
        needs_verification boolean DEFAULT FALSE
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        razorpay_payment_id text,
        amount integer,
        currency text,
        status text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scraper_failures (
        id BIGSERIAL PRIMARY KEY,
        student_id TEXT NOT NULL,
        checked_at TIMESTAMPTZ DEFAULT now(),
        ip TEXT
      );
    `);
    // Add missing columns if table already exists
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS student_id TEXT`).catch(e => logger.warn('Column student_id may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`).catch(e => logger.warn('Column name may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scraper_checked_at TIMESTAMPTZ`).catch(e => logger.warn('Column scraper_checked_at may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scraper_exists BOOLEAN DEFAULT NULL`).catch(e => logger.warn('Column scraper_exists may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_verification BOOLEAN DEFAULT FALSE`).catch(e => logger.warn('Column needs_verification may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ`).catch(e => logger.warn('Column subscription_started_at may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ`).catch(e => logger.warn('Column subscription_expires_at may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notified_subscription_expired BOOLEAN DEFAULT FALSE`).catch(e => logger.warn('Column notified_subscription_expired may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notified_trial_expired BOOLEAN DEFAULT FALSE`).catch(e => logger.warn('Column notified_trial_expired may already exist:', e.message));
    // Make email nullable if it was NOT NULL (for student_id-based logins)
    await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`).catch(e => logger.debug('Email column constraint update (may already be nullable):', e.message));
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_student_id ON users (student_id) WHERE student_id IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_needs_verification ON users(needs_verification)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_razorpay_payment_id ON payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL`).catch(e => logger.warn('Index may already exist:', e.message));
    
    // Attendance storage tables (replaces file storage)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        username text NOT NULL,
        student_name text,
        subject text,
        present integer,
        absent integer,
        total integer,
        percent numeric,
        margin integer,
        required integer,
        recorded_at timestamptz DEFAULT now(),
        source text
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_username ON attendance(username)`).catch(e => logger.warn('Index may already exist:', e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_recorded_at ON attendance(recorded_at DESC)`).catch(e => logger.warn('Index may already exist:', e.message));
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS upcoming_classes (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        username text NOT NULL,
        class_id text,
        class_name text,
        start_time timestamptz,
        end_time timestamptz,
        metadata jsonb,
        fetched_at timestamptz DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_upcoming_classes_username ON upcoming_classes(username)`).catch(e => logger.warn('Index may already exist:', e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_upcoming_classes_start_time ON upcoming_classes(start_time)`).catch(e => logger.warn('Index may already exist:', e.message));
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS latest_snapshot (
        username text PRIMARY KEY,
        attendance_id uuid REFERENCES attendance(id) ON DELETE SET NULL,
        fetched_at timestamptz DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_latest_snapshot_attendance_id ON latest_snapshot(attendance_id)`).catch(e => logger.warn('Index may already exist:', e.message));
    
    logger.info('DB schema ensured');
  } catch (err) {
    logger.error('DB ensure schema error', { error: err.message });
  }
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

function requireAuth(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return verifyToken(token);
}

// Create checkAccess middleware (replaces old checkTrial)
// Initialize after verifyToken and getUserById are defined
let checkAccess = null;

// Initialize checkAccess middleware
function initializeCheckAccess() {
  if (!checkAccess) {
    checkAccess = createCheckAccess(verifyToken, getUserById);
  }
  return checkAccess;
}

// Keep old checkTrial for backward compatibility (deprecated)
// This ensures checkAccess is initialized before use
async function checkTrial(req, res, next) {
  const middleware = initializeCheckAccess();
  return middleware(req, res, next);
}

// compute required r such that ((p+r)/(t+r))*100 >= 75
function computeRequired(present, total) {
  if (total === 0) return 0;
  const current = (present / total) * 100;
  if (current >= 75) return 0;
  let r = 0;
  while (true) {
    const pct = ((present + r) / (total + r)) * 100;
    if (pct >= 75) return r;
    r++;
    // safety cap to avoid infinite loop (shouldn't be needed)
    if (r > 2000) return r;
  }
}

function computePercent(present, total) {
  if (total === 0) return 0;
  return +((present / total) * 100).toFixed(2);
}

// Compute how many more classes can be missed while staying >= 75%
// x_max = floor(present / 0.75 - total); clamp to 0
function computeCanMiss(present, total) {
  if (present < 0 || total <= 0) return 0;
  const threshold = 0.75;
  const allowed = Math.floor(present / threshold - total);
  return Math.max(0, allowed);
}

const LMS_BASE = 'https://sbmchlms.com/lms';
const LOGIN_URL = `${LMS_BASE}/site/userlogin`;
const DASHBOARD_URL = `${LMS_BASE}/user/user/dashboard`;
const ATTENDANCE_PAGE_URL = `${LMS_BASE}/user/attendence/subjectbyattendance`;
const ATTENDANCE_API_URL = `${LMS_BASE}/user/attendence/subjectgetdaysubattendence`;
const ORIGIN = 'https://sbmchlms.com';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function withDefaultHeaders(headers = {}) {
  return { ...DEFAULT_HEADERS, ...headers };
}

async function loginToLms({ username, password }) {
  const jar = new CookieJar();
  const fetchWithCookies = fetchCookie(fetch, jar);
  const client = (url, options = {}) => {
    const headers = withDefaultHeaders(options.headers);
    return fetchWithCookies(url, { ...options, headers });
  };

  const loginPage = await client(LOGIN_URL, { method: 'GET' });
  if (!loginPage.ok) {
    throw new Error(`Login page request failed (${loginPage.status})`);
  }
  const loginHtml = await loginPage.text();
  const $login = cheerio.load(loginHtml);
  const hiddenInputs = {};
  $login('input[type="hidden"]').each((_, el) => {
    const name = $login(el).attr('name');
    if (!name) return;
    hiddenInputs[name] = $login(el).attr('value') ?? '';
  });

  const form = new URLSearchParams();
  form.set('username', username);
  form.set('password', password);
  Object.entries(hiddenInputs).forEach(([key, value]) => form.append(key, value ?? ''));

  const loginResponse = await client(LOGIN_URL, {
    method: 'POST',
    body: form,
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ORIGIN,
      Referer: LOGIN_URL
    }),
    redirect: 'manual'
  });

  if ([301, 302, 303].includes(loginResponse.status)) {
    const location = loginResponse.headers.get('location');
    if (location) {
      const destination = new URL(location, LOGIN_URL).toString();
      await client(destination, { method: 'GET' });
    }
  } else {
    const body = await loginResponse.text();
    if (!loginResponse.ok || /invalid username|password/i.test(body)) {
      throw new Error('Login failed: the LMS rejected the credentials or returned an unexpected response.');
    }
  }

  return { client };
}

function parseUpcomingClasses($) {
  const upcoming = [];
  $('.user-progress .lecture-list').each((_, li) => {
    const $li = $(li);
    const avatar = cleanText($li.find('img').attr('src') || $li.find('img').attr('data-src') || '');
    let title = cleanText($li.find('.media-title').first().text());
    if (!title) {
      title = cleanText($li.find('.bmedium').first().text());
    }
    const subtitle = cleanText($li.find('.text-muted').first().text());
    const msAuto = $li.find('.ms-auto').first();
    let location = '';
    let time = '';
    if (msAuto && msAuto.length) {
      location = cleanText(msAuto.find('.bmedium').first().text());
      if (!location) {
        location = cleanText(msAuto.children().first().text());
      }
      time = cleanText(msAuto.find('.text-muted').first().text());
      if (!time && msAuto.children().length > 1) {
        time = cleanText(msAuto.children().eq(1).text());
      }
    }
    upcoming.push({ title, subtitle, location, time, avatar });
  });
  return upcoming;
}

async function fetchStudentDashboard(client, username) {
  const dashboardResponse = await client(DASHBOARD_URL, { method: 'GET' });
  if (!dashboardResponse.ok) {
    throw new Error(`Dashboard request failed (${dashboardResponse.status})`);
  }
  const html = await dashboardResponse.text();
  if (/Student Login/i.test(html) && /Username/i.test(html)) {
    throw new Error('Session invalid – dashboard returned login page.');
  }
  const $ = cheerio.load(html);
  let studentName = cleanText($('h4.mt0').first().text().replace(/Welcome,/i, ''));
  if (!studentName) {
    studentName = username;
  }
  const upcomingClasses = parseUpcomingClasses($);
  return { studentName, upcomingClasses };
}

function parseAttendanceRows(resultPage) {
  if (!resultPage) return [];
  const $ = cheerio.load(resultPage);
  const rows = [];
  
  // Look for .attendance_result table first (like working Puppeteer code)
  const resultBox = $('.attendance_result');
  const table = resultBox.length ? resultBox.find('table') : $('table');
  
  if (!table.length) {
    logger.warn('No attendance table found in result page');
    return [];
  }
  
  table.find('tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.find('td');
    if (tds.length < 3) return;
    const subject = cleanText($(tds[0]).text());
    const percentText = cleanText($(tds[1]).text());
    const presentText = cleanText($(tds[2]).text());
    const percentMatch = percentText.match(/[\d.]+/);
    const percentValue = percentMatch ? parseFloat(percentMatch[0]) : NaN;
    const ratioMatch = presentText.match(/(\d+)\s*\/\s*(\d+)/);
    const sessionsCompleted = ratioMatch ? parseInt(ratioMatch[1], 10) : 0;
    const totalSessions = ratioMatch ? parseInt(ratioMatch[2], 10) : 0;
    const present = sessionsCompleted;
    const total = totalSessions;
    const absent = total >= present ? total - present : 0;
    const percent = !Number.isNaN(percentValue)
      ? +percentValue.toFixed(2)
      : (total ? +((present / total) * 100).toFixed(2) : 0);
    rows.push({
      subject,
      sessionsCompleted,
      totalSessions,
      present,
      total,
      absent,
      percent
    });
  });
  return rows;
}

async function fetchAttendanceTable(client, { fromDate, toDate, subjectId = '' }) {
  // First, visit the attendance page (like Puppeteer does)
  await client(ATTENDANCE_PAGE_URL, { method: 'GET' });
  
  // Calculate date range (from working Puppeteer code: FROM_DATE = '11-11-2024', TO_DATE = today)
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const defaultFromDate = fromDate || '11-11-2024'; // Default from working code
  const defaultToDate = toDate || `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  
  logger.info('Fetching attendance with date range', { 
    fromDate: defaultFromDate, 
    toDate: defaultToDate,
    subjectId: subjectId || 'all'
  });

  const payload = new URLSearchParams();
  payload.set('date', defaultFromDate);
  payload.set('end_date', defaultToDate);
  payload.set('subject', subjectId ?? ''); // Empty string = all subjects

  const response = await client(ATTENDANCE_API_URL, {
    method: 'POST',
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: ATTENDANCE_PAGE_URL,
      Accept: 'application/json, text/javascript, */*; q=0.01'
    }),
    body: payload
  });

  if (!response.ok) {
    throw new Error(`Attendance API request failed (${response.status})`);
  }

  const json = await response.json().catch(() => null);
  if (!json) {
    throw new Error('Attendance API returned an empty response.');
  }
  if (String(json.status) !== '1') {
    if (json.result_page) {
      return parseAttendanceRows(json.result_page);
    }
    return [];
  }
  return parseAttendanceRows(json.result_page || '');
}

// --- Combined scrape function ---
async function scrapeAttendance({ username, password, fromDate, toDate }) {
  logger.debug('scrapeAttendance invoked', { username });
  const { client } = await loginToLms({ username, password });
  const { studentName, upcomingClasses } = await fetchStudentDashboard(client, username);
  const attendanceRows = await fetchAttendanceTable(client, { fromDate, toDate, subjectId: '' });
  return { studentName, upcomingClasses, attendanceRows };
}

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// --- Routes ---
// Auth: Signup (30-day trial)
app.post('/api/auth/signup', [
  body('email').isEmail().withMessage('valid email required'),
  body('password').isString().isLength({ min: 6 }).withMessage('password min 6 chars'),
  validateRequest
], async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'user_exists' });

    const hash = await bcrypt.hash(password, 10);
    const trialExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(
      `INSERT INTO users(email, password_hash, trial_started_at, trial_expires_at, subscription_status)
       VALUES($1, $2, now(), $3, 'trial') RETURNING *`,
      [email, hash, trialExpires]
    );
    const user = rows[0];

    // Create Razorpay customer
    let customerId = null;
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
      const customer = await razorpay.customers.create({ email, name: email });
      customerId = customer?.id || null;
      if (customerId) {
        await pool.query('UPDATE users SET razorpay_customer_id=$1 WHERE id=$2', [customerId, user.id]);
      }
    }

    const token = signToken({ userId: user.id, email }, '7d');
    return res.json({ token, user: { id: user.id, email, trial_expires_at: user.trial_expires_at, subscription_status: user.subscription_status, razorpay_customer_id: customerId } });
  } catch (err) {
    logger.error('signup error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy email/password login removed. Use new router at /api/auth/login.

// Payments: Ensure/Create customer (idempotent)
app.post('/api/payments/create-customer', async (req, res) => {
  try {
    const payload = requireAuth(req);
    if (!payload || !payload.userId) return res.status(401).json({ error: 'unauthorized' });
    const user = await getUserById(payload.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (user.razorpay_customer_id) return res.json({ razorpay_customer_id: user.razorpay_customer_id });
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return res.status(400).json({ error: 'razorpay_not_configured' });
    const customer = await razorpay.customers.create({ email: user.email, name: user.email });
    const cid = customer?.id || null;
    if (cid) await pool.query('UPDATE users SET razorpay_customer_id=$1 WHERE id=$2', [cid, user.id]);
    return res.json({ razorpay_customer_id: cid });
  } catch (err) {
    logger.error('create-customer error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Subscriptions route is now in backend/routes/subscriptions.js

// Razorpay Webhook: signature verification & updates (fully defensive)
app.post('/api/webhook/razorpay', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signatureHeader =
      req.headers['x-razorpay-signature'] ||
      req.headers['X-Razorpay-Signature'];

    // raw JSON string for signature check
    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body);

    // Basic validation
    if (!signatureHeader) {
      console.warn('[webhook] missing_signature_header', {
        hasSignature: false,
        hasSecret: !!secret
      });
      return res.status(400).json({ error: 'missing_signature' });
    }
    if (!secret) {
      console.error('[webhook] Server missing RAZORPAY_WEBHOOK_SECRET');
      return res.status(500).json({ error: 'server_misconfigured' });
    }

    // Compute expected signature
    const expected = crypto
      .createHmac('sha256', secret)
      .update(raw)
      .digest('hex');

    // Validate signature
    if (expected !== signatureHeader) {
      console.warn('[webhook] signature_mismatch', {
        expected,
        received: signatureHeader
      });
      return res.status(401).json({ error: 'invalid_signature' });
    }

    console.info('[webhook] signature_verified', {
      event: req.body?.event
    });

    // Extract event - ONLY accept subscription.activated
    const event = req.body?.event || 'unknown';
    
    // Only process subscription.activated events
    if (event !== 'subscription.activated') {
      console.info('[webhook] Ignoring non-activation event', { event });
      return res.status(200).json({ 
        success: true, 
        message: `Event ${event} ignored - only processing subscription.activated` 
      });
    }
    const subscriptionEntity =
      req.body?.payload?.subscription?.entity ?? null;
    const paymentEntity = req.body?.payload?.payment?.entity ?? null;
    const invoiceEntity = req.body?.payload?.invoice?.entity ?? null;

    // userId from Razorpay notes
    const userId =
      subscriptionEntity?.notes?.user_id ??
      paymentEntity?.notes?.user_id ??
      invoiceEntity?.notes?.user_id ??
      null;

    if (!userId) {
      console.warn('[webhook] no_user_id_in_payload', {
        event,
        subscriptionEntity,
        paymentEntity,
        invoiceEntity
      });
      return res
        .status(400)
        .json({ error: 'missing_user_id', message: 'payload missing user_id' });
    }

    // Validate and normalize userId
    // Accept both UUID format and integer IDs (for flexibility)
    let normalizedUserId = userId;
    
    // Convert to string and check if it's numeric
    const userIdStr = String(userId).trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isNumeric = /^\d+$/.test(userIdStr);
    
    console.log('[webhook] userId validation', { 
      userId, 
      userIdStr, 
      isNumeric, 
      type: typeof userId 
    });
    
    if (isNumeric) {
      // If userId is numeric, query database to get the actual UUID
      try {
        console.info('[webhook] Looking up user by numeric ID', { userId });
        
        // First, try to get all users ordered by creation
        const { rows } = await pool.query('SELECT id, student_id FROM users ORDER BY created_at LIMIT 100');
        const userIndex = parseInt(userId) - 1; // Convert to 0-based index (user ID 1 = index 0, user ID 2 = index 1, etc.)
        
        if (rows.length > userIndex && userIndex >= 0) {
          normalizedUserId = rows[userIndex].id;
          console.info('[webhook] Resolved numeric user_id to UUID', { 
            original: userId, 
            resolved: normalizedUserId,
            student_id: rows[userIndex].student_id 
          });
        } else {
          // If not found by position, show available users and suggest using one of them
          const availableUsers = rows.map((r, i) => ({ 
            position: i + 1, 
            id: r.id, 
            student_id: r.student_id || 'N/A' 
          }));
          
          console.error('[webhook] User not found by numeric ID', { 
            userId, 
            totalUsers: rows.length,
            availableUsers
          });
          
          // Suggest using the first available user ID
          const suggestedId = rows.length > 0 ? 1 : null;
          return res.status(404).json({ 
            error: 'user_not_found', 
            message: `No user found at position ${userId}. Available users: ${rows.length}. Available user positions: ${availableUsers.map(u => u.position).join(', ')}. Try using user_id: ${suggestedId || 'N/A'}`,
            availableUsers: availableUsers.map(u => ({ position: u.position, student_id: u.student_id }))
          });
        }
      } catch (lookupErr) {
        console.error('[webhook] Error looking up user', { userId, error: lookupErr.message, stack: lookupErr.stack });
        return res.status(500).json({ 
          error: 'user_lookup_failed', 
          message: `Failed to lookup user: ${lookupErr.message}` 
        });
      }
    } else if (!uuidRegex.test(String(userId))) {
      console.error('[webhook] invalid_user_id_format', {
        userId,
        event,
        message: 'user_id must be a valid UUID format or numeric ID'
      });
      return res.status(400).json({ 
        error: 'invalid_user_id', 
        message: `user_id must be a valid UUID format or numeric ID. Received: ${userId}. Get a real user ID from database: SELECT id FROM users LIMIT 1;` 
      });
    }
    
    // Use normalized user ID for all subsequent operations
    const finalUserId = normalizedUserId;

    // ============================
    //   DB PROCESSING (PRESERVE)
    // ============================
    try {
      // Extract meaningful entities (preserve existing logic)
      const subEntity = subscriptionEntity || req.body?.payload?.subscription?.entity || null;
      const invEntity = invoiceEntity || req.body?.payload?.invoice?.entity || null;
      const payEntity = paymentEntity || req.body?.payload?.payment?.entity || null;

      let subscriptionId = subEntity?.id || invEntity?.subscription_id || null;
      const amount = invEntity?.amount || payEntity?.amount || null; // in paise
      const currency = invEntity?.currency || payEntity?.currency || 'INR';
      const status = invEntity?.status || payEntity?.status || 'processed';
      const razorpayPaymentId = payEntity?.id || null;
      const userIdNote = finalUserId || (subEntity?.notes && subEntity.notes.user_id) || (invEntity?.notes && invEntity.notes.user_id) || null;

      // Check if this is a subscription activation event
      const isActivationEvent = event === 'subscription.activated' || 
                                event === 'invoice.paid' || 
                                event === 'payment.captured' ||
                                (subEntity && subEntity.status === 'active') ||
                                (invEntity && invEntity.status === 'paid');

      // If we have subscription_id or notes.user_id, update user status and dates
      if (subscriptionId) {
        if (isActivationEvent) {
          // Set subscription as active with 28-day expiry
          await pool.query(
            `UPDATE users 
             SET subscription_status='active', 
                 subscription_started_at=NOW(), 
                 subscription_expires_at=NOW() + interval '28 days',
                 notified_subscription_expired=false
             WHERE subscription_id=$1`,
            [subscriptionId]
          );
          logger.info('[webhook] Subscription activated', { subscriptionId, event });
        } else {
          // Just update status (for other events)
          await pool.query(`UPDATE users SET subscription_status='active' WHERE subscription_id=$1`, [subscriptionId]);
        }
      }
      if (userIdNote) {
        if (isActivationEvent) {
          // Set subscription as active with 28-day expiry
          await pool.query(
            `UPDATE users 
             SET subscription_status='active', 
                 subscription_started_at=NOW(), 
                 subscription_expires_at=NOW() + interval '28 days',
                 notified_subscription_expired=false
             WHERE id=$1`,
            [userIdNote]
          );
          logger.info('[webhook] Subscription activated via user_id', { userId: userIdNote, event });
        } else {
          // Just update status (for other events)
          await pool.query(`UPDATE users SET subscription_status='active' WHERE id=$1`, [userIdNote]);
        }
      }

      // Record payment if available (preserve idempotency logic)
      if ((userIdNote || subscriptionId) && (razorpayPaymentId || amount)) {
        // Resolve user_id by subscription if not in notes
        let resolvedUserId = userIdNote;
        if (!resolvedUserId && subscriptionId) {
          const { rows } = await pool.query('SELECT id FROM users WHERE subscription_id=$1', [subscriptionId]);
          resolvedUserId = rows[0]?.id || null;
        }
        if (resolvedUserId && razorpayPaymentId) {
          // Use transaction for idempotency check
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            
            // Check for duplicate payment (idempotency) with row lock
            const { rows: existing } = await client.query(
              'SELECT id FROM payments WHERE razorpay_payment_id=$1 FOR UPDATE',
              [razorpayPaymentId]
            );
            
            if (existing.length > 0) {
              logger.info('[webhook] Payment already recorded (idempotent)', { userId: resolvedUserId, razorpayPaymentId });
              await client.query('COMMIT');
            } else {
              // Insert payment record
              await client.query(
                `INSERT INTO payments(user_id, razorpay_payment_id, amount, currency, status, metadata)
                 VALUES($1, $2, $3, $4, $5, $6)`,
                [resolvedUserId, razorpayPaymentId, amount, currency, status, JSON.stringify(req.body)]
              );
              logger.info('[webhook] Payment recorded', { userId: resolvedUserId, razorpayPaymentId });
              await client.query('COMMIT');
            }
          } catch (dbErr) {
            await client.query('ROLLBACK');
            logger.error('[webhook] Payment record transaction failed', {
              error: dbErr.message,
              userId: resolvedUserId,
              razorpayPaymentId
            });
            // Don't fail webhook if payment record fails - subscription activation is more important
          } finally {
            client.release();
          }
        } else if (resolvedUserId && amount && !razorpayPaymentId) {
          // Record payment even without razorpay_payment_id (for tracking)
          try {
            await pool.query(
              `INSERT INTO payments(user_id, razorpay_payment_id, amount, currency, status, metadata)
               VALUES($1, $2, $3, $4, $5, $6)`,
              [resolvedUserId, null, amount, currency, status, JSON.stringify(req.body)]
            );
            logger.info('[webhook] Payment recorded (no payment_id)', { userId: resolvedUserId, amount });
          } catch (dbErr) {
            logger.error('[webhook] Failed to record payment without payment_id', {
              error: dbErr.message,
              userId: resolvedUserId
            });
          }
        }
      }

      console.info('[webhook] processing_finished', {
        userId: finalUserId,
        event
      });
      return res.status(200).json({ success: true, event, userId: finalUserId });

    } catch (dbErr) {
      console.error('[webhook] db_error', {
        message: dbErr?.message,
        stack: dbErr?.stack
      });
      return res.status(500).json({ error: 'db_error', message: dbErr?.message });
    }

  } catch (err) {
    console.error('[webhook] unexpected_error', {
      message: err?.message,
      stack: err?.stack,
      payload: req.body
    });
    return res.status(500).json({ error: 'internal_error', message: err?.message });
  }
});
app.post('/api/login', [
  body('username').isString().trim().notEmpty().withMessage('username is required'),
  body('password').isString().notEmpty().withMessage('password is required'),
  body('fromDate').optional().isString().trim(),
  body('toDate').optional().isString().trim(),
  validateRequest
], async (req, res) => {
  try {
    const { username, password, fromDate, toDate } = req.body || {};

    // simple rate-limit: 1 request per 30s per user
    const now = Date.now();
    if (lastLoginAt[username] && (now - lastLoginAt[username] < 30 * 1000)) {
      return res.status(429).json({ error: 'Too many login attempts. Wait 30 seconds.' });
    }
    lastLoginAt[username] = now;

    // Sign token
    const token = signToken({ username });

    // Start scrape in background but also wait short time so client can call attendance soon.
    if (!scrapingStatus[username] || !scrapingStatus[username].running) {
      const status = { running: true, promise: null };
      scrapingStatus[username] = status;
      const job = (async () => {
        try {
          logger.info('[auth] Scrape job started for <username>', { username });
          // Use date range like working Puppeteer code
          const now = new Date();
          const pad = n => String(n).padStart(2, '0');
          const normalizedFrom = fromDate || '11-11-2024'; // Default from working code
          const normalizedTo = toDate || `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
          
          logger.info('Using date range for scraping', { from: normalizedFrom, to: normalizedTo });
          
          const result = await scrapeAttendance({
            username,
            password,
            fromDate: normalizedFrom,
            toDate: normalizedTo
          });

          const processed = (result.attendanceRows || []).map(row => {
            const present = typeof row.present === 'number' ? row.present : (row.sessionsCompleted ?? 0);
            const total = typeof row.total === 'number' ? row.total : (row.totalSessions ?? 0);
            const absent = Number.isFinite(row.absent) ? row.absent : Math.max(0, total - present);
            const percent = Number.isFinite(row.percent) ? +row.percent.toFixed(2) : computePercent(present, total);
            const required = computeRequired(present, total);
            const margin = computeCanMiss(present, total);
            return {
              subject: row.subject,
              present,
              absent,
              total,
              percent,
              margin,
              required
            };
          });

          const studentName = result.studentName || username;
          const fetchedAt = new Date().toISOString();

          logger.info('Starting database save for scraped data', { 
            username, 
            attendanceCount: processed.length,
            upcomingClassesCount: result.upcomingClasses?.length || 0
          });

          // Delete old data for this username (guarantees fresh data on every login)
          try {
            const deleteAttendanceResult = await pool.query('DELETE FROM attendance WHERE username = $1', [username]);
            const deleteClassesResult = await pool.query('DELETE FROM upcoming_classes WHERE username = $1', [username]);
            logger.info('Deleted old attendance data for user', { 
              username,
              deletedAttendanceRows: deleteAttendanceResult.rowCount,
              deletedClassesRows: deleteClassesResult.rowCount
            });
          } catch (deleteErr) {
            logger.error('Error deleting old data', { username, error: deleteErr.message, stack: deleteErr.stack });
            throw deleteErr; // Re-throw to prevent inserting into stale data
          }

          // Bulk insert attendance records
          if (processed.length > 0) {
            // Use a transaction for better performance and atomicity
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              
              // Insert records one by one in a transaction (safer for large datasets)
              let insertedCount = 0;
              for (const row of processed) {
                try {
                  await client.query(
                    `INSERT INTO attendance (username, student_name, subject, present, absent, total, percent, margin, required, source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                      username,
                      studentName,
                      row.subject,
                      row.present,
                      row.absent,
                      row.total,
                      row.percent,
                      row.margin,
                      row.required,
                      'scraper'
                    ]
                  );
                  insertedCount++;
                } catch (insertErr) {
                  logger.error('Error inserting attendance record', { 
                    username, 
                    subject: row.subject, 
                    error: insertErr.message 
                  });
                  throw insertErr; // Re-throw to rollback transaction
                }
              }
              
              await client.query('COMMIT');
              logger.info('Successfully inserted attendance records', { 
                username, 
                count: insertedCount,
                expected: processed.length 
              });
            } catch (err) {
              await client.query('ROLLBACK');
              logger.error('Transaction failed, rolled back', { 
                username, 
                error: err.message, 
                stack: err.stack 
              });
              throw err;
            } finally {
              client.release();
            }
          } else {
            logger.warn('No attendance records to insert', { username });
          }

          // Insert upcoming classes
          if (result.upcomingClasses && result.upcomingClasses.length > 0) {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              
              let insertedClassesCount = 0;
              for (const cls of result.upcomingClasses) {
                try {
                  await client.query(
                    `INSERT INTO upcoming_classes (username, class_id, class_name, start_time, end_time, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                      username,
                      cls.id || cls.class_id || null,
                      cls.name || cls.class_name || cls.title || null,
                      cls.start_time ? new Date(cls.start_time) : null,
                      cls.end_time ? new Date(cls.end_time) : null,
                      JSON.stringify(cls.metadata || cls)
                    ]
                  );
                  insertedClassesCount++;
                } catch (insertErr) {
                  logger.error('Error inserting upcoming class', { 
                    username, 
                    class: cls.name || cls.class_name, 
                    error: insertErr.message 
                  });
                  throw insertErr;
                }
              }
              
              await client.query('COMMIT');
              logger.info('Successfully inserted upcoming classes', { 
                username, 
                count: insertedClassesCount,
                expected: result.upcomingClasses.length 
              });
            } catch (err) {
              await client.query('ROLLBACK');
              logger.error('Upcoming classes transaction failed, rolled back', { 
                username, 
                error: err.message, 
                stack: err.stack 
              });
              throw err;
            } finally {
              client.release();
            }
          } else {
            logger.info('No upcoming classes to insert', { username });
          }

          // Update latest_snapshot - get the most recent attendance record for this user
          const { rows: latestRows } = await pool.query(
            `SELECT id FROM attendance WHERE username = $1 ORDER BY recorded_at DESC LIMIT 1`,
            [username]
          );
          
          if (latestRows.length > 0) {
            await pool.query(
              `INSERT INTO latest_snapshot (username, attendance_id, fetched_at)
               VALUES ($1, $2, now())
               ON CONFLICT (username) DO UPDATE SET
                 attendance_id = EXCLUDED.attendance_id,
                 fetched_at = EXCLUDED.fetched_at`,
              [username, latestRows[0].id]
            );
          }

          // Verify data was actually saved
          const { rows: verifyRows } = await pool.query(
            `SELECT COUNT(*) as count FROM attendance WHERE username = $1`,
            [username]
          );
          const savedCount = parseInt(verifyRows[0]?.count || 0);

          logger.info('Attendance scraped and saved to database', {
            username,
            subjects: processed.length,
            savedToDatabase: savedCount,
            upcomingClasses: result.upcomingClasses?.length || 0,
            verified: savedCount === processed.length
          });

          if (savedCount !== processed.length && processed.length > 0) {
            logger.error('Data verification failed - count mismatch', {
              username,
              expected: processed.length,
              actual: savedCount
            });
          }
        } catch (err) {
          logger.error('Scrape job error', { 
            username, 
            error: err.message, 
            stack: err.stack,
            errorCode: err.code,
            errorDetail: err.detail
          });
          // Log database connection errors specifically
          if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.message?.includes('connection')) {
            logger.error('Database connection error during scrape', { 
              username,
              error: err.message,
              databaseUrl: DB_URL ? 'configured' : 'missing'
            });
          }
        } finally {
          status.running = false;
        }
      })();
      status.promise = job;
      
      // Optionally wait for scrape to finish (bounded wait for better UX)
      const WAIT_MS = Number(process.env.SCRAPE_WAIT_MS || 12000);
      if (WAIT_MS > 0 && scrapingStatus[username] && scrapingStatus[username].promise) {
        const waitStart = Date.now();
        try {
          await Promise.race([
            scrapingStatus[username].promise,
            new Promise(resolve => setTimeout(resolve, WAIT_MS))
          ]);
          const waited = Date.now() - waitStart;
          if (waited < WAIT_MS) {
            logger.info('[auth/login] waited Xms for scrape to finish', { 
              username, 
              waitedMs: waited 
            });
          } else {
            logger.info('[auth/login] scrape not finished after WAIT_MS', { 
              username, 
              waitMs: WAIT_MS 
            });
          }
        } catch (e) {
          logger.warn('[auth/login] Error waiting for scrape', { 
            username, 
            error: e.message 
          });
        }
      }
    } else {
      logger.info('Scrape already running for user', { username });
    }

    return res.json({ token });
  } catch (err) {
    logger.error('Login endpoint error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/attendance', checkTrial, async (req, res) => {
  try {
    // Note: checkTrial middleware already verifies token and checks trial/subscription expiry
    // If we reach here, the user is authorized and has active trial/subscription
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = auth.slice(7);
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Invalid token' });

    // Support both old format (username) and new format (student_id)
    const username = payload.student_id || payload.username;
    if (!username) return res.status(401).json({ error: 'Invalid token: missing student_id or username' });

    logger.info('[attendance] Checking attendance for user', { username });

    // Step 1: Check latest_snapshot first (fast lookup)
    const { rows: snapshotRows } = await pool.query(
      `SELECT attendance_id, fetched_at FROM latest_snapshot WHERE username = $1`,
      [username]
    );

    // Step 2: If no snapshot exists, return 202 (Pending)
    if (snapshotRows.length === 0) {
      logger.info('[attendance] no snapshot for <username> — returning 202', { username });
      return res.status(202).json({ 
        status: 'pending', 
        message: 'Attendance not yet available. Retry shortly.' 
      });
    }

    const snapshot = snapshotRows[0];
    logger.info('[attendance] latest snapshot found for <username>', { 
      username, 
      attendance_id: snapshot.attendance_id,
      fetched_at: snapshot.fetched_at 
    });

    // Step 3: Query attendance data from database using snapshot
    const { rows: attendanceRows } = await pool.query(
      `SELECT student_name, subject, present, absent, total, percent, margin, required, recorded_at
       FROM attendance
       WHERE username = $1
       ORDER BY recorded_at DESC, subject ASC`,
      [username]
    );

    if (attendanceRows.length === 0) {
      logger.warn('[attendance] Snapshot exists but no attendance rows found', { username });
      return res.status(202).json({ 
        status: 'pending', 
        message: 'Attendance not yet available. Retry shortly.' 
      });
    }

    // Get student name from first record (all should have same student_name)
    const studentName = attendanceRows[0]?.student_name || username;
    
    // Get fromDate and toDate from query params or use defaults
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';
    
    // Get the most recent fetched_at timestamp from snapshot
    const fetchedAt = snapshot.fetched_at?.toISOString() || attendanceRows[0].recorded_at?.toISOString() || new Date().toISOString();
    
    logger.info('[attendance] returned snapshot fetchedAt=<timestamp> for <username>', { 
      username, 
      fetchedAt,
      attendanceCount: attendanceRows.length 
    });

    // Query upcoming classes
    const { rows: upcomingClassesRows } = await pool.query(
      `SELECT class_id, class_name, start_time, end_time, metadata
       FROM upcoming_classes
       WHERE username = $1
       ORDER BY start_time ASC`,
      [username]
    );

    // Transform upcoming classes to match expected format
    const upcomingClasses = upcomingClassesRows.map(row => {
      const base = {
        id: row.class_id,
        name: row.class_name,
        start_time: row.start_time?.toISOString(),
        end_time: row.end_time?.toISOString()
      };
      
      // Merge metadata if available
      if (row.metadata) {
        try {
          const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
          return { ...base, ...metadata };
        } catch (e) {
          return base;
        }
      }
      return base;
    });

    // Transform attendance to match expected format (same as file format)
    const attendance = attendanceRows.map(row => ({
      subject: row.subject,
      present: row.present,
      absent: row.absent,
      total: row.total,
      percent: parseFloat(row.percent) || 0,
      margin: row.margin,
      required: row.required
    }));

    // Return in same format as before (maintains frontend compatibility)
    const response = {
      studentName,
      fetchedAt,
      fromDate,
      toDate,
      attendance,
      upcomingClasses
    };

    logger.debug('[attendance] Returning attendance data', { 
      username, 
      subjects: attendance.length, 
      classes: upcomingClasses.length 
    });
    return res.json(response);
  } catch (err) {
    logger.error('Attendance endpoint error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Health
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', time: Date.now(), timestamp: new Date().toISOString() }));

// health check for Render
app.get('/healthz', (req, res) => {
  return res.status(200).json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack, url: req.url, method: req.method });

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS policy: origin not allowed' });
  }

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'internal_server_error' : err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Export app for testing
export { app };

// Only start server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  // Ensure DB schema on boot (non-blocking)
  ensureSchema().catch((e) => logger.error('ensureSchema boot error', { error: e.message }));
  
  // Cron jobs disabled - not needed
  // (async () => {
  //   try {
  //     const { startSubscriptionNotifier } = await import('./cron/subscriptionNotifier.js');
  //     startSubscriptionNotifier();
  //     logger.info('Subscription notifier cron job started');
  //   } catch (err) {
  //     logger.warn('Failed to start subscription notifier cron job', { error: err.message });
  //   }
  // })();
  
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Attendance API server running on http://0.0.0.0:${PORT}`);
    // File storage removed - now using database storage
    // logger.info(`Output directory: ${OUTPUT_DIR}`);
    if (!process.env.SECRET) {
      logger.warn('SECRET env var not set - using dev secret. Set SECRET in production!');
    }
  });
}
