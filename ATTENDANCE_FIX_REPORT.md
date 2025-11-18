# Attendance Data Fix Report

## Root Cause Analysis

### Issue Identified
New users don't get attendance data on deployed backend while seeded users do.

### Root Causes Found

1. **Database Pool Initialization Issue**
   - `scraperService.js` was creating Pool at module load time with potentially empty `DATABASE_URL`
   - If `DATABASE_URL` was missing or empty, pool would be created with invalid connection string
   - Database operations would fail silently

2. **Missing Error Logging**
   - Scraper errors were caught but not logged with sufficient detail
   - LMS connection failures (ENOTFOUND, ECONNREFUSED) were not specifically caught
   - No logging to confirm scraper was actually being triggered

3. **Empty Snapshot Handling**
   - If scraping completed but returned 0 attendance rows, no snapshot was created
   - Frontend would keep getting 202 (Pending) responses indefinitely
   - No way to distinguish between "scraping in progress" and "scraping completed with no data"

4. **Insufficient Logging**
   - No logs to confirm scraper trigger
   - No logs for LMS login success/failure
   - No logs for database operations

---

## Fixes Applied

### 1. Lazy Database Pool Initialization (`backend/src/services/scraperService.js`)

**Before:**
```javascript
const DB_URL = process.env.DATABASE_URL || ''
const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false
})
```

**After:**
```javascript
// Lazy pool initialization - only create when first needed
let pool = null

function getPool() {
  if (!pool) {
    const DB_URL = process.env.DATABASE_URL || ''
    if (!DB_URL) {
      throw new Error('DATABASE_URL not configured in scraperService')
    }
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000
    })
    logger.info('[scraperService] Database pool initialized')
  }
  return pool
}
```

**Impact**: Pool is only created when needed, and throws error immediately if `DATABASE_URL` is missing.

---

### 2. Enhanced Error Handling and Logging

**Added:**
- Validation of `DATABASE_URL` before starting scraper
- Specific error handling for LMS connection failures (ENOTFOUND, EAI_AGAIN, ECONNREFUSED)
- Logging at each step: LMS login start, success, dashboard fetch, attendance fetch
- More detailed error logging with error codes and names

**Key Logs Added:**
- `[auth/login] Triggering attendance scrape` - Confirms scraper is called
- `[scraperService] Starting LMS login` - Confirms LMS connection attempt
- `[scraperService] LMS login successful` - Confirms credentials worked
- `[scraperService] Fetching student dashboard` - Confirms dashboard fetch
- `[scraperService] Fetching attendance table` - Confirms attendance fetch
- `[scrape_error]` - All errors logged with full stack traces

---

### 3. Empty Snapshot Creation

**Before:**
```javascript
if (latestRows.length > 0) {
  // Create snapshot
} else {
  logger.warn('No attendance records found to create snapshot')
  // No snapshot created - frontend gets 202 forever
}
```

**After:**
```javascript
if (latestRows.length > 0) {
  // Create snapshot with attendance_id
} else {
  // Create snapshot with NULL attendance_id to indicate scraping completed
  await dbPool.query(
    `INSERT INTO latest_snapshot (username, attendance_id, fetched_at)
     VALUES ($1, NULL, now())
     ON CONFLICT (username) DO UPDATE SET
       fetched_at = EXCLUDED.fetched_at`,
    [username]
  )
  logger.warn('[scraperService] No attendance records found - created empty snapshot', { 
    username,
    note: 'Scraping completed but returned 0 attendance rows...'
  })
}
```

**Impact**: Frontend will get 200 response even if scraping returns no data, preventing infinite 202 responses.

---

### 4. Attendance Endpoint Empty Data Handling (`backend/server.js`)

**Before:**
```javascript
if (attendanceRows.length === 0) {
  return res.status(202).json({ status: 'pending', ... })
}
```

**After:**
```javascript
if (attendanceRows.length === 0) {
  if (snapshot.attendance_id === null) {
    // Scraping completed with no data - return 200 with empty array
    return res.json({
      studentName: username,
      fetchedAt: snapshot.fetched_at?.toISOString(),
      attendance: [],
      upcomingClasses: []
    })
  } else {
    // Still scraping - return 202
    return res.status(202).json({ status: 'pending', ... })
  }
}
```

**Impact**: Frontend gets 200 response when scraping completes, even with empty data.

---

## Files Changed

1. `backend/src/services/scraperService.js`
   - Lazy pool initialization
   - Enhanced error handling
   - Better logging throughout
   - Empty snapshot creation

2. `backend/routes/auth.js`
   - Added logging before scraper trigger
   - Enhanced error logging with error codes

3. `backend/server.js`
   - Handle empty attendance data with 200 response

---

## Testing Instructions

### 1. Test with Valid Credentials

```bash
# Login with a real student ID and password
curl -X POST https://sbmchattendance.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"student_id":"std1626","password":"valid_password"}'

# Extract token and poll attendance
TOKEN="..."
curl -X GET https://sbmchattendance.onrender.com/api/attendance \
  -H "Authorization: Bearer $TOKEN"
```

### 2. Check Render Logs

Look for these log patterns:
- `[auth/login] Triggering attendance scrape` - Should appear after login
- `[auth] Scrape job started` - Confirms scraper started
- `[scraperService] Starting LMS login` - Confirms LMS connection attempt
- `[scraperService] LMS login successful` - Confirms credentials worked
- `[scraperService] Successfully inserted attendance records` - Confirms data saved
- `[scrape_error]` - Any errors will be logged here

### 3. Database Verification

```sql
-- Check user
SELECT * FROM users WHERE student_id = 'test_student_id';

-- Check attendance
SELECT COUNT(*) FROM attendance WHERE username = 'test_student_id';

-- Check snapshot
SELECT * FROM latest_snapshot WHERE username = 'test_student_id';
```

---

## Expected Behavior After Fix

1. **Login**: User created/authenticated, scraper triggered in background
2. **Scraping**: 
   - LMS login attempted (logged)
   - Attendance data fetched (logged)
   - Data saved to database (logged)
   - Snapshot created/updated (logged)
3. **Attendance Endpoint**:
   - Returns 202 while scraping
   - Returns 200 with data once scraping completes
   - Returns 200 with empty array if scraping completed with no data

---

## Next Steps

1. **Deploy fixes** to production
2. **Monitor logs** for scraping errors
3. **Test with real credentials** to verify end-to-end flow
4. **Check database** to confirm data is being written

---

## Potential Remaining Issues

1. **Invalid LMS Credentials**: If user provides wrong password, scraper will fail. This is expected behavior, but errors should now be visible in logs.

2. **LMS Blocking**: If LMS blocks requests from Render IP, scraping will fail. Check logs for ENOTFOUND/ECONNREFUSED errors.

3. **Network Timeouts**: If LMS is slow, scraping might timeout. Consider increasing timeout values if needed.

---

**Commit**: Fixes committed to `main` branch  
**Status**: Ready for deployment and testing

