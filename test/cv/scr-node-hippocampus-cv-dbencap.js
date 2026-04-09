#!/usr/bin/env node
/**
 * CV Test: hippocampus-db-encapsulation
 * Verifies database isolation: only Hippocampus accesses the hippocampus DB.
 * Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB_NAME = process.env.HIPPOCAMPUS_DB || 'hippocampus';
const PG_USER = process.env.PGUSER || 'graphheight_sys';

// Pre-flight: check PostgreSQL reachable
let pool;
try {
  pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'postgres', user: PG_USER, max: 1 });
  await pool.query('SELECT 1');
} catch {
  console.log(JSON.stringify({ status: 'blocked', reason: 'PostgreSQL unreachable' }));
  process.exit(2);
}

describe('hippocampus-db-encapsulation', () => {
  after(async () => { await pool.end(); });
  it('1. hippocampus database exists', async () => {
    const res = await pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME],
    );
    assert.equal(res.rows.length, 1, `Database '${DB_NAME}' should exist`);
  });

  it('2. All connections from expected user', async () => {
    const res = await pool.query(
      `SELECT pid, usename, application_name, client_addr
       FROM pg_stat_activity WHERE datname = $1`,
      [DB_NAME],
    );
    for (const row of res.rows) {
      assert.equal(row.usename, PG_USER,
        `Unexpected user '${row.usename}' connected to ${DB_NAME} (pid: ${row.pid})`);
    }
  });

  it('3. No cross-organ application names', async () => {
    const res = await pool.query(
      `SELECT DISTINCT application_name
       FROM pg_stat_activity WHERE datname = $1 AND application_name != ''`,
      [DB_NAME],
    );
    const forbidden = ['radiant', 'minder', 'spine', 'graph', 'axon', 'lobe', 'vigil', 'glia'];
    for (const row of res.rows) {
      const appLower = row.application_name.toLowerCase();
      for (const name of forbidden) {
        assert.ok(!appLower.includes(name),
          `Organ '${name}' should not connect to ${DB_NAME} (app: ${row.application_name})`);
      }
    }
  });

  it('4. No shared tables with other databases', async () => {
    const hippoPool = new pg.Pool({ host: 'localhost', port: 5432, database: DB_NAME, user: PG_USER, max: 1 });
    try {
      const res = await hippoPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      const tables = res.rows.map(r => r.table_name);
      // Hippocampus should only have its own tables
      const expected = ['conversations', 'messages'];
      for (const t of tables) {
        // Allow pgvector internal tables but flag unexpected ones
        if (t.startsWith('pg_') || expected.includes(t)) continue;
        assert.fail(`Unexpected table '${t}' in ${DB_NAME} — possible cross-contamination`);
      }
      // Verify core tables exist
      assert.ok(tables.includes('conversations'), 'conversations table must exist');
      assert.ok(tables.includes('messages'), 'messages table must exist');
    } finally {
      await hippoPool.end();
    }
  });
});
