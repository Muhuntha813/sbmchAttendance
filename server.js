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
import puppeteer from 'puppeteer';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// --- CORS + Request Logging ---
app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false
}));

// Log every incoming request for debugging
app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.url} | body:`, req.body || {});
  next();
});
// --- End CORS + Logging ---

const SECRET = process.env.SECRET || 'changeme';
const PORT = process.env.PORT || 3000;
const PUPPETEER_TIMEOUT = parseInt(process.env.PUPPETEER_TIMEOUT || '30000', 10);

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

// --- Scraper Attempt: direct HTTP fetch + cheerio ---
// NOTE: update selectors according to your LMS HTML structure.
async function attemptDirectLogin({ username, password, fromDate, toDate }) {
  console.log('[scrape] attemptDirectLogin start for', username);
  try {
    const jar = new CookieJar();
    const fetchWithCookies = fetchCookie(fetch, jar);

    // 1) GET login page to obtain cookies / hidden tokens (if any)
    const LOGIN_URL = 'https://sbmchlms.com/lms/site/userlogin';
    const ATT_URL = 'https://sbmchlms.com/lms/user/attendence/subjectbyattendance';
    console.log('[debug] LOGIN_URL:', LOGIN_URL);
    console.log('[debug] ATT_URL:', ATT_URL);

    const loginPageRes = await fetchWithCookies(LOGIN_URL, { method: 'GET', timeout: PUPPETEER_TIMEOUT });
    const loginHtml = await loginPageRes.text();
    const $login = cheerio.load(loginHtml);

    // Try to find hidden inputs like CSRF - adapt selector if LMS uses them
    const hiddenInputs = {};
    $login('input[type="hidden"]').each((i, el) => {
      hiddenInputs[$login(el).attr('name')] = $login(el).val();
    });

    // Prepare form data - adapt field names to LMS form
    const form = new URLSearchParams();
    form.append('username', username);
    form.append('password', password);

    // append hidden tokens if present
    Object.keys(hiddenInputs).forEach(k => form.append(k, hiddenInputs[k]));

    // POST login
    const postLogin = await fetchWithCookies(LOGIN_URL, {
      method: 'POST',
      body: form,
      redirect: 'manual',
      timeout: PUPPETEER_TIMEOUT,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // If login succeeded, server often redirects to dashboard
    if (postLogin.status !== 302 && postLogin.status !== 200) {
      console.log('[scrape] direct login response status', postLogin.status);
      throw new Error('Direct login likely failed (unexpected status).');
    }

    // GET attendance page with date params if required (may need query or POST)
    // Try simple GET first; if LMS needs params, you'll need to adapt.
    const attRes = await fetchWithCookies(ATT_URL, { method: 'GET', timeout: PUPPETEER_TIMEOUT });
    const attHtml = await attRes.text();
    // Save raw attendance page HTML for debugging (direct fetch)
    try {
      const pageFile = path.join(OUTPUT_DIR, `${username}-attendance-page.html`);
      atomicWrite(pageFile, attHtml);
      console.log(`[debug] saved attendance HTML -> ${pageFile}`);
    } catch (e) {
      console.error('[debug] failed to save attendance HTML (direct):', e && e.message ? e.message : e);
    }
    const $ = cheerio.load(attHtml);

    // Debugging: print small snippet
    if (attHtml.length < 200) {
      console.log('[scrape] attendance page HTML small length:', attHtml.length);
    }

    // Locate table rows - adjust selector to real LMS markup
    const table = $('.attendance_result table').first();
    if (!table || table.length === 0) {
      console.log('[scrape] attendance table not found in direct attempt');
      console.log('[debug] attendance page snippet:', attHtml.slice(0,500));
      throw new Error('Attendance table not found via direct fetch');
    }

    const rows = [];
    table.find('tbody tr').each((i, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const subject = $(tds[0]).text().trim();
      const percentText = $(tds[1]).text().trim();
      // try to extract present/total from third column like "22 / 29"
      const third = $(tds[2]).text().trim();
      const m = third.match(/(\d+)\s*\/\s*(\d+)/);
      let present = 0, total = 0;
      if (m) { present = parseInt(m[1], 10); total = parseInt(m[2], 10); }
      const percent = isNaN(parseFloat(percentText)) ? computePercent(present, total) : parseFloat(parseFloat(percentText).toFixed(2));
      rows.push({ subject, present, total, absent: total - present, percent });
    });

    if (!rows.length) {
      console.log('[scrape] direct fetch parsed 0 rows');
      console.log('[debug] attendance page snippet:', attHtml.slice(0,500));
      throw new Error('Parsed zero attendance rows via direct fetch');
    }

    console.log(`[scrape] direct fetch succeeded, rows=${rows.length}`);
    return rows;
  } catch (err) {
    console.error('[scrape] direct login error:', err && err.message ? err.message : err);
    throw err;
  }
}

// --- Scraper Fallback: Puppeteer headless ---
// --- Puppeteer scraping using the exact selectors from your original script ---
async function runPuppeteerScrape({ username, password, fromDate, toDate }) {
  console.log('[scrape] runPuppeteerScrape start for', username);
  const LOGIN_URL = 'https://sbmchlms.com/lms/site/userlogin';
  const ATT_URL   = 'https://sbmchlms.com/lms/user/attendence/subjectbyattendance';

  let browser;
  try {
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

    // guard
    if (!fs.existsSync(executablePath)) {
      console.warn('[scrape] PUPPETEER_EXECUTABLE_PATH not found, attempting default launch');
    } else {
      console.log('[scrape] using Chrome at', executablePath);
    }

    browser = await puppeteer.launch({
      headless: true,
      executablePath: fs.existsSync(executablePath) ? executablePath : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1366, height: 900 }
    });

    const page = await browser.newPage();

    // --- Login ---
    console.log('[scrape] goto LOGIN_URL', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: PUPPETEER_TIMEOUT });

    // fill credentials (selectors from your script)
    await page.type('input[name="username"]', username, { delay: 25 });
    await page.type('input[name="password"]', password, { delay: 25 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: PUPPETEER_TIMEOUT }),
      page.click('button[type="submit"], input[type="submit"]')
    ]).catch(e => {
      console.warn('[scrape] login navigation/wait failed (continuing):', e && e.message ? e.message : e);
    });

    // ===== Try to fetch student name from dashboard (optional) =====
    let studentName = username;
    try {
      await page.waitForSelector('h4.mt0', { timeout: 8000 });
      studentName = await page.$eval('h4.mt0', el => el.innerText.replace('Welcome,','').trim());
    } catch (e) {
      console.log('[scrape] student name selector not found, using username');
    }
    console.log('[scrape] Student Name:', studentName);

    // --- Attendance page ---
    console.log('[scrape] goto ATT_URL', ATT_URL);
    await page.goto(ATT_URL, { waitUntil: 'networkidle2', timeout: PUPPETEER_TIMEOUT });
    // Replace deprecated/unsupported Puppeteer waitForTimeout with a simple delay
    await new Promise(res => setTimeout(res, 600));

    // helper to set date into inputs exactly like your script
    async function setDate(sel, value) {
      try {
        await page.click(sel, { clickCount: 3 }).catch(()=>{});
        await page.keyboard.down('Control').catch(()=>{});
        await page.keyboard.press('KeyA').catch(()=>{});
        await page.keyboard.up('Control').catch(()=>{});
        await page.keyboard.press('Backspace').catch(()=>{});
        await page.type(sel, value, { delay: 20 });
        await page.$eval(sel, el => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } catch (e) {
        console.log('[scrape] setDate failed for', sel, e && e.message ? e.message : e);
      }
    }

    // If fromDate/toDate provided use them, else default to what caller passed
    if (!fromDate) fromDate = ''; // or keep default from caller
    if (!toDate)   toDate = '';

    // Try setting the known selectors
    await setDate('#dob', fromDate || '');
    await setDate('#end_dob', toDate || '');

    // Select "All subjects" if dropdown exists (optional)
    try {
      if (await page.$('#subject_id')) {
        await page.select('#subject_id', '');
        await page.$eval('#subject_id', el => el.dispatchEvent(new Event('change', { bubbles: true })));
      }
    } catch (e) {
      console.log('[scrape] subject select failed (non-fatal):', e && e.message ? e.message : e);
    }

    // Click Search button (use same approach: check for "search" text)
    try {
      const searchSelector = 'button, input[type="button"], input[type="submit"]';
      const btns = await page.$$(searchSelector);
      let clicked = false;
      for (const b of btns) {
        const txt = (await page.evaluate(el => (el.innerText || el.value || '').trim().toLowerCase(), b));
        if (txt.includes('search')) { await b.click(); clicked = true; break; }
      }
      if (!clicked) console.log('[scrape] Search button not found — continuing without click');
    } catch (e) {
      console.log('[scrape] clicking search failed (non-fatal):', e && e.message ? e.message : e);
    }

    // Wait for results using the exact selector you used
    await page.waitForFunction(() => {
      const box = document.querySelector('.attendance_result');
      if (!box) return false;
      const table = box.querySelector('table');
      if (!table) return false;
      return table.querySelectorAll('td').length > 0;
    }, { timeout: 20000 }).catch(() => {
      console.warn('[scrape] waitForFunction timed out; proceeding to try to read DOM anyway');
    });

    // get HTML (for debugging + parsing)
    const attHtml = await page.content();

    // --- DEBUG: save HTML snippet & full file ---
    try {
      const pageFile = path.join(OUTPUT_DIR, `${username}-attendance-page.html`);
      fs.writeFileSync(pageFile, attHtml, 'utf8');
      console.log(`[debug] saved attendance HTML -> ${pageFile}`);
    } catch (e) {
      console.error('[debug] failed to save attendance HTML:', e && e.message ? e.message : e);
    }
    try { console.log('[debug] attendance page snippet (first 2000 chars):', attHtml.slice(0,2000)); } catch (e){}

    // --- Scrape the table using the exact DOM mapping from your original script ---
    const rows = await page.evaluate(() => {
      const box = document.querySelector('.attendance_result');
      if (!box) return [];
      const table = box.querySelector('table');
      if (!table) return [];
      const trs = Array.from(table.querySelectorAll('tbody tr')).filter(tr => tr.querySelectorAll('td').length);

      return trs.map(tr => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        if (tds.length < 3) return null;

        const subject = tds[0];
        const attendancePercentRaw = tds[1];
        const attendancePercent = isNaN(parseFloat(attendancePercentRaw))
          ? attendancePercentRaw
          : parseFloat(parseFloat(attendancePercentRaw).toFixed(2));

        const presentText = tds[2];
        const m = presentText.match(/(\d+)\s*\/\s*(\d+)/);
        const present = m ? parseInt(m[1], 10) : 0;
        const total   = m ? parseInt(m[2], 10) : 0;

        return { subject, present, total, absent: total - present, percent: attendancePercent };
      }).filter(Boolean);
    });

    console.log('[scrape] Rows parsed (puppeteer):', rows.length);
    // compute required/margin
    const processed = rows.map(r => {
      const percent = (typeof r.percent === 'number') ? +r.percent.toFixed(2) : (r.total ? +((r.present / r.total) * 100).toFixed(2) : 0);
      const margin = computeCanMiss(r.present, r.total);
      const required = computeRequired(r.present, r.total);
      return {
        subject: r.subject,
        present: r.present,
        absent: r.absent,
        total: r.total,
        percent,
        margin,
        required
      };
    });

    // save to output
    const out = {
      studentName,
      fetchedAt: new Date().toISOString(),
      attendance: processed
    };
    const outPath = path.join(OUTPUT_DIR, `${username}-attendance.json`);
    atomicWrite(outPath, JSON.stringify(out, null, 2));
    // also save latest
    const latestPath = path.join(OUTPUT_DIR, `latest-${username}.json`);
    atomicWrite(latestPath, JSON.stringify(out, null, 2));

    console.log(`[scrape] saved attendance ${processed.length} rows -> ${outPath}`);

    await browser.close();
    return rows;
  } catch (err) {
    console.error('[scrape] puppeteer error:', err && err.message ? err.message : err);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    throw err;
  }
}


// --- Combined scrape function ---
async function scrapeAttendance({ username, password, fromDate, toDate }) {
  console.log('[scrape] scrapeAttendance called for', username);
  // 1) try direct fetch
  try {
    const rows = await attemptDirectLogin({ username, password, fromDate, toDate });
    if (rows && rows.length) return rows;
  } catch (err) {
    console.log('[scrape] direct fetch failed, will fallback to puppeteer');
  }

  // 2) fallback to puppeteer
  const rows = await runPuppeteerScrape({ username, password, fromDate, toDate });
  return rows;
}

// --- Routes ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, fromDate, toDate } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

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
      const job = (async () => {
        scrapingStatus[username] = { running: true, promise: null };
        try {
          console.log(`[job] starting scrape for ${username}`);
          const rows = await scrapeAttendance({ username, password, fromDate: fromDate || '', toDate: toDate || '' });
          // compute extras
          const processed = rows.map(r => {
            const percent = computePercent(r.present, r.total);
            const required = computeRequired(r.present, r.total);
            const margin = computeCanMiss(r.present, r.total);
            return {
              subject: r.subject,
              present: r.present,
              absent: r.total - r.present,
              total: r.total,
              percent,
              margin,
              required
            };
          });

          const out = {
            studentName: username,
            fetchedAt: new Date().toISOString(),
            attendance: processed
          };

          const outPath = path.join(OUTPUT_DIR, `${username}-attendance.json`);
          atomicWrite(outPath, JSON.stringify(out, null, 2));
          // also write latest-<username>
          const latestPath = path.join(OUTPUT_DIR, `latest-${username}.json`);
          atomicWrite(latestPath, JSON.stringify(out, null, 2));
          console.log(`[job] saved attendance for ${username} to ${outPath}`);
        } catch (err) {
          console.error('[job] scrape job error for', username, err && err.message ? err.message : err);
        } finally {
          scrapingStatus[username].running = false;
        }
      })();
      scrapingStatus[username].promise = job;
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
app.get('/health', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Attendance API server running on http://localhost:${PORT}`);
  console.log('Ensure .env SECRET is set. Output dir:', OUTPUT_DIR);
});
