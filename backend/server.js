// server.js (ESM)
import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import fetchCookie from 'fetch-cookie';
import * as cheerio from 'cheerio';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';

dotenv.config();

const app = express();

// Security headers
app.use(helmet());

app.use(bodyParser.json());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/', apiLimiter);

// --- CORS + Request Logging ---
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Log every incoming request for debugging
app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.url} | body:`, req.body || {});
  next();
});
// --- End CORS + Logging ---

// Enforce SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SECRET) {
  console.error('FATAL: SECRET env var is required in production');
  process.exit(1);
}

const SECRET = process.env.SECRET || 'dev-secret-for-local';
const PORT = process.env.PORT || 3000;

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Simple in-memory rate limiter & scrape trackers ---
const lastLoginAt = {}; // username -> timestamp ms
const scrapingStatus = {}; // username -> { running: bool, promise: Promise }

// --- Helpers ---
function signToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (err) {
    return null;
  }
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
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
  $('table tbody tr').each((_, tr) => {
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
  await client(ATTENDANCE_PAGE_URL, { method: 'GET' });

  const payload = new URLSearchParams();
  payload.set('date', fromDate || '');
  payload.set('end_date', toDate || '');
  payload.set('subject', subjectId ?? '');

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
  console.log('[scrape] scrapeAttendance called for', username);
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
          console.log(`[job] starting scrape for ${username}`);
          const normalizedFrom = fromDate || '';
          const normalizedTo = toDate || '';
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

          const out = {
            studentName: result.studentName || username,
            fetchedAt: new Date().toISOString(),
            fromDate: normalizedFrom,
            toDate: normalizedTo,
            attendance: processed,
            upcomingClasses: result.upcomingClasses || []
          };

          const outPath = path.join(OUTPUT_DIR, `${username}-attendance.json`);
          atomicWrite(outPath, JSON.stringify(out, null, 2));
          const latestPath = path.join(OUTPUT_DIR, `latest-${username}.json`);
          atomicWrite(latestPath, JSON.stringify(out, null, 2));
          console.log(`[job] saved attendance for ${username} to ${outPath} (${processed.length} subjects, ${out.upcomingClasses.length} upcoming classes)`);
        } catch (err) {
          console.error('[job] scrape job error for', username, err && err.message ? err.message : err);
        } finally {
          status.running = false;
        }
      })();
      status.promise = job;
    } else {
      console.log('[job] scrape already running for', username);
    }

    return res.json({ token });
  } catch (err) {
    console.error('/api/login error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/attendance', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = auth.slice(7);
    const payload = verifyToken(token);
    if (!payload || !payload.username) return res.status(401).json({ error: 'Invalid token' });

    const username = payload.username;
    const filePath = path.join(OUTPUT_DIR, `${username}-attendance.json`);
    const latestPath = path.join(OUTPUT_DIR, `latest-${username}.json`);

    // If scraping is running, wait up to 10s for it to finish
    if (scrapingStatus[username] && scrapingStatus[username].running) {
      console.log('[api] scrape in progress for', username, 'waiting up to 10s');
      try {
        await Promise.race([
          scrapingStatus[username].promise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for scrape')), 10000))
        ]);
      } catch (e) {
        console.log('[api] wait ended:', e.message);
      }
    }

    // Prefer the per-username file; fallback to latest
    let dataFile = null;
    if (fs.existsSync(filePath)) dataFile = filePath;
    else if (fs.existsSync(latestPath)) dataFile = latestPath;

    if (!dataFile) return res.status(404).json({ error: 'No attendance data found. Please login to trigger a scrape.' });

    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return res.json(parsed);
  } catch (err) {
    console.error('/api/attendance error:', err && err.message ? err.message : err);
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
app.use((err, req, res, next) => {
  console.error('[error]', err.message || err);
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Attendance API server running on http://0.0.0.0:${PORT}`);
    console.log('Ensure .env SECRET is set. Output dir:', OUTPUT_DIR);
  });
}
