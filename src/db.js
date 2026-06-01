import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const APP_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Europe/Lisbon';

const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'restaurante_db',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  options: `-c search_path=public -c timezone=${APP_TIMEZONE}`,
});

pool.on('connect', (client) => {
  client.query(`SET timezone TO '${APP_TIMEZONE.replace(/'/g, "''")}'`).catch(() => {});
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withClient(work) {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public');
    await client.query(`SET timezone TO '${APP_TIMEZONE.replace(/'/g, "''")}'`);
    return await work(client);
  } finally {
    client.release();
  }
}

export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO public');
    await client.query(`SET LOCAL timezone TO '${APP_TIMEZONE.replace(/'/g, "''")}'`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export { pool };
