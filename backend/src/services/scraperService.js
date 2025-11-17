// Shared scraper service for triggering attendance scraping
// Used by both /api/login and /api/auth/login endpoints

import logger from '../../lib/logger.js'
import { query } from '../db.js'
import { Pool } from 'pg'

// In-memory tracking of scraping status (shared across endpoints)
export const scrapingStatus = {}

/**
 * Process and save scraped attendance data to database
 * This is the core logic that saves data after scraping
 */
export async function saveScrapedDataToDatabase({ username, studentName, processed, upcomingClasses }) {
  try {
    logger.info('[scraperService] Starting database save for scraped data', { 
      username, 
      attendanceCount: processed.length,
      upcomingClassesCount: upcomingClasses?.length || 0,
      hasStudentName: !!studentName
    })
    
    // Validate inputs
    if (!username) {
      throw new Error('Username is required')
    }
    if (!processed || !Array.isArray(processed)) {
      throw new Error('Processed attendance data must be an array')
    }

    // Delete old data for this username (guarantees fresh data on every login)
    logger.info('[scraperService] Deleting old data for user', { username })
    try {
      const deleteAttendanceResult = await query('DELETE FROM attendance WHERE username = $1', [username])
      const deleteClassesResult = await query('DELETE FROM upcoming_classes WHERE username = $1', [username])
      logger.info('[scraperService] Deleted old attendance data for user', { 
        username,
        deletedAttendanceRows: deleteAttendanceResult.rowCount,
        deletedClassesRows: deleteClassesResult.rowCount
      })
    } catch (deleteErr) {
      logger.error('[scraperService] Error deleting old data', { 
        username, 
        error: deleteErr.message, 
        stack: deleteErr.stack,
        code: deleteErr.code 
      })
      throw deleteErr // Re-throw to prevent inserting into stale data
    }

    // Bulk insert attendance records
    if (processed.length > 0) {
      logger.info('[scraperService] Starting bulk insert of attendance records', { 
        username, 
        count: processed.length 
      })
      
      // Create a pool for transactions (will be closed after use)
      const DB_URL = process.env.DATABASE_URL || ''
      if (!DB_URL) {
        logger.error('[scraperService] DATABASE_URL not configured')
        throw new Error('DATABASE_URL not configured')
      }
      
      logger.info('[scraperService] Creating database connection pool', { 
        username,
        hasDbUrl: !!DB_URL,
        isSupabase: DB_URL.includes('supabase')
      })
      
      const pool = new Pool({
        connectionString: DB_URL,
        ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000
      })
      
      logger.info('[scraperService] Connecting to database', { username })
      const client = await pool.connect()
      logger.info('[scraperService] Database connection established', { username })
      try {
        await client.query('BEGIN')
        
        // Insert records one by one in a transaction (safer for large datasets)
        let insertedCount = 0
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
            )
            insertedCount++
          } catch (insertErr) {
            logger.error('[scraperService] Error inserting attendance record', { 
              username, 
              subject: row.subject, 
              error: insertErr.message,
              code: insertErr.code
            })
            throw insertErr // Re-throw to rollback transaction
          }
        }
        
        await client.query('COMMIT')
        logger.info('[scraperService] Transaction committed successfully', { 
          username, 
          count: insertedCount,
          expected: processed.length 
        })
        // Note: latest_snapshot will be updated after this transaction commits
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {}) // Ignore rollback errors
        logger.error('[scraperService] Transaction failed, rolled back', { 
          username, 
          error: err.message, 
          stack: err.stack,
          code: err.code
        })
        throw err
      } finally {
        logger.info('[scraperService] Releasing database connection', { username })
        client.release()
        await pool.end()
        logger.info('[scraperService] Database pool closed', { username })
      }
    } else {
      logger.warn('[scraperService] No attendance records to insert - processed array is empty', { 
        username,
        processedLength: processed.length 
      })
    }

    // Insert upcoming classes
    if (upcomingClasses && upcomingClasses.length > 0) {
      const DB_URL = process.env.DATABASE_URL || ''
      if (!DB_URL) {
        throw new Error('DATABASE_URL not configured')
      }
      const pool = new Pool({
        connectionString: DB_URL,
        ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000
      })
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        
        let insertedClassesCount = 0
        for (const cls of upcomingClasses) {
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
            )
            insertedClassesCount++
          } catch (insertErr) {
            logger.error('Error inserting upcoming class', { 
              username, 
              class: cls.name || cls.class_name, 
              error: insertErr.message 
            })
            throw insertErr
          }
        }
        
        await client.query('COMMIT')
        logger.info('Successfully inserted upcoming classes', { 
          username, 
          count: insertedClassesCount,
          expected: upcomingClasses.length 
        })
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error('Upcoming classes transaction failed, rolled back', { 
          username, 
          error: err.message, 
          stack: err.stack 
        })
        throw err
      } finally {
        client.release()
        await pool.end()
      }
    } else {
      logger.info('No upcoming classes to insert', { username })
    }

    // Update latest_snapshot - get the most recent attendance record for this user
    // This must happen immediately after inserting attendance rows
    const { rows: latestRows } = await query(
      `SELECT id FROM attendance WHERE username = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [username]
    )
    
    if (latestRows.length > 0) {
      await query(
        `INSERT INTO latest_snapshot (username, attendance_id, fetched_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (username) DO UPDATE SET
           attendance_id = EXCLUDED.attendance_id,
           fetched_at = EXCLUDED.fetched_at`,
        [username, latestRows[0].id]
      )
      logger.info('[scraperService] Successfully inserted N attendance rows for <username>, latest id <id>', {
        username,
        count: processed.length,
        latestId: latestRows[0].id
      })
    } else {
      logger.warn('[scraperService] No attendance rows found to create snapshot', { username })
    }

    // Verify data was actually saved
    const { rows: verifyRows } = await query(
      `SELECT COUNT(*) as count FROM attendance WHERE username = $1`,
      [username]
    )
    const savedCount = parseInt(verifyRows[0]?.count || 0)

    logger.info('Attendance scraped and saved to database', {
      username,
      subjects: processed.length,
      savedToDatabase: savedCount,
      upcomingClasses: upcomingClasses?.length || 0,
      verified: savedCount === processed.length
    })

    if (savedCount !== processed.length && processed.length > 0) {
      logger.error('Data verification failed - count mismatch', {
        username,
        expected: processed.length,
        actual: savedCount
      })
    }

    return { success: true, savedCount }
  } catch (err) {
    logger.error('Error saving scraped data to database', {
      username,
      error: err.message,
      stack: err.stack,
      errorCode: err.code,
      errorDetail: err.detail
    })
    throw err
  }
}

