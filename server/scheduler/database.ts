import { config } from 'dotenv';
import pg from 'pg';

config({ quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in .env.');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});
pool.on('error', () => console.error('scheduler_idle_database_connection_lost'));
