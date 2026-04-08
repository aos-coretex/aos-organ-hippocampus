/**
 * PostgreSQL connection pool for Hippocampus.
 * Encapsulated database — only Hippocampus accesses this.
 */
import pg from 'pg';
import pgvector from 'pgvector/pg';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: 'hippocampus',
      user: process.env.PGUSER || 'graphheight_sys',
      max: 5,
    });
  }
  return pool;
}

export async function initPool() {
  const p = getPool();

  // Register pgvector type handler
  await pgvector.registerTypes(p);

  // Verify connectivity and schema
  const client = await p.connect();
  try {
    const tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('conversations', 'messages')
      ORDER BY table_name
    `);
    const tables = tableCheck.rows.map(r => r.table_name);
    if (!tables.includes('conversations') || !tables.includes('messages')) {
      throw new Error(`Schema incomplete — found tables: [${tables.join(', ')}]. Run: npm run setup-db`);
    }

    // Log stats
    const stats = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM conversations) AS total_conversations,
        (SELECT COUNT(*) FROM conversations WHERE status = 'active') AS active_conversations,
        (SELECT COUNT(*) FROM messages) AS total_messages,
        (SELECT COUNT(*) FROM conversations WHERE summary IS NOT NULL) AS summarized
    `);
    return stats.rows[0];
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
