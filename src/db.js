// src/db.js (ESM)
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'restaurante_db',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PGPOOL_MAX ?? 10),
});

export const query = (text, params) => pool.query(text, params);
export { pool }; 
