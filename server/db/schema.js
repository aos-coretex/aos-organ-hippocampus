/**
 * Schema verification — run at organ boot to ensure database is ready.
 */
import { getPool } from './pool.js';

export async function verifySchema() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Check pgvector extension
    const ext = await client.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
    );
    if (ext.rows.length === 0) {
      throw new Error('pgvector extension not installed. Run: npm run setup-db');
    }

    // Check indexes
    const indexes = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('conversations', 'messages')
      ORDER BY indexname
    `);
    const indexNames = indexes.rows.map(r => r.indexname);
    const required = [
      'idx_conv_status', 'idx_conv_user', 'idx_conv_updated',
      'idx_msg_conv', 'idx_msg_embedding', 'idx_conv_summary_embedding'
    ];
    const missing = required.filter(i => !indexNames.includes(i));
    if (missing.length > 0) {
      throw new Error(`Missing indexes: ${missing.join(', ')}. Run: npm run setup-db`);
    }

    return { pgvector: true, indexes: indexNames.length, missing: 0 };
  } finally {
    client.release();
  }
}
