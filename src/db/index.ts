import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

/**
 * Neon serverless HTTP client.
 * DATABASE_URL is validated at runtime; the `!` assertion is safe because
 * the calling code (Inngest function) validates the env before any DB call.
 */
const sql = neon(process.env.DATABASE_URL!);

/**
 * Drizzle ORM client for Neon Postgres (HTTP transport — works in Edge and Node).
 * The `schema` option enables relational query helpers (db.query.*).
 */
export const db = drizzle(sql, { schema });

export type Db = typeof db;
