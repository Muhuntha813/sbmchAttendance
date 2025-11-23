import dns from 'dns';
dns.setDefaultResultOrder && dns.setDefaultResultOrder('ipv4first');

import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 5000
});

(async () => {
  try {
    console.log('DATABASE_URL=', process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:(.+)@/, ':***@') : 'MISSING');
    const { rows } = await pool.query('SELECT version(), current_user, inet_server_addr() AS server_ip');
    console.log('OK:', rows[0]);
  } catch (err) {
    console.error('ERR_message:', err?.message);
    console.error('ERR_code:', err?.code);
    console.error('ERR_stack:', err?.stack);
    try { console.error('ERR_full:', JSON.stringify(err, Object.getOwnPropertyNames(err))); } catch(e){}
    process.exitCode = 1;
  } finally {
    await pool.end().catch(()=>{});
  }
})();


