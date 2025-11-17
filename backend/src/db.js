import { Pool } from 'pg'

// Read DATABASE_URL dynamically to avoid module load order issues
function getDbUrl() {
  return process.env.DATABASE_URL || ''
}

// Lazy pool initialization - only create when first needed
let pool = null

function getPool() {
  if (!pool) {
    const DB_URL = getDbUrl()
    if (!DB_URL) {
      throw new Error('DATABASE_URL not configured')
    }
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
      // Connection timeout
      connectionTimeoutMillis: 10000
    })
  }
  return pool
}

export function query(text, params) {
  const DB_URL = getDbUrl()
  if (!DB_URL) {
    return Promise.reject(new Error('DATABASE_URL not configured'))
  }
  
  const poolInstance = getPool()
  return poolInstance.query(text, params).catch(err => {
    // Log database errors for debugging
    console.error('[db] Query error:', err.message, err.code)
    // Re-throw with more context
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      throw new Error(`Database connection failed: ${err.message}`)
    }
    throw err
  })
}

export default { query }