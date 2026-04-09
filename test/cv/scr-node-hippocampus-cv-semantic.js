#!/usr/bin/env node
/**
 * CV Test: hippocampus-semantic-search
 * Tests vector embedding and cosine similarity search via Vectr.
 * Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const HIPPOCAMPUS_URL = process.env.HIPPOCAMPUS_URL || 'http://127.0.0.1:4008';
const VECTR_URL = process.env.VECTR_URL || 'http://127.0.0.1:4001';
const TEST_URN = `urn:graphheight:conversation:cv-semantic-${Date.now()}`;
const TEST_USER = 'urn:graphheight:user:cv-test-semantic';

// Pre-flight
for (const [name, url] of [['Hippocampus', HIPPOCAMPUS_URL], ['Vectr', VECTR_URL]]) {
  try {
    const h = await fetch(`${url}/health`);
    if (!h.ok) throw new Error(`${h.status}`);
  } catch {
    console.log(JSON.stringify({ status: 'blocked', reason: `${name} unreachable at ${url}` }));
    process.exit(2);
  }
}

async function cleanup() {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      host: 'localhost', port: 5432,
      database: process.env.HIPPOCAMPUS_DB || 'hippocampus',
      user: process.env.PGUSER || 'graphheight_sys', max: 1,
    });
    await pool.query('DELETE FROM messages WHERE conversation_urn = $1', [TEST_URN]);
    await pool.query('DELETE FROM conversations WHERE urn = $1', [TEST_URN]);
    await pool.end();
  } catch { /* best effort */ }
}

describe('hippocampus-semantic-search', () => {
  after(cleanup);

  const messages = [
    'PostgreSQL performance tuning with index optimization',
    'React component lifecycle hooks and state management',
    'Erlang OTP supervision tree restart strategies',
    'Database connection pooling best practices',
    'CSS grid layout for responsive dashboards',
  ];

  it('1. Create conversation and append 5 topically distinct messages', async () => {
    await fetch(`${HIPPOCAMPUS_URL}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn: TEST_URN, participants: { user_urn: TEST_USER } }),
    });

    const batchRes = await fetch(
      `${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(TEST_URN)}/messages/batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.map(content => ({ role: 'user', content })),
        }),
      },
    );
    assert.equal(batchRes.status, 201);
    const body = await batchRes.json();
    assert.equal(body.messages_stored, 5);
    assert.ok(body.embedded_count > 0, 'At least some messages should be embedded');
  });

  it('2. Search for "database indexing performance" returns relevant results', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'database indexing performance',
        participant_urn: TEST_USER,
        threshold: 0.30,
        limit: 5,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.count >= 1, 'Should find at least one database-related message');
    // Top result should be one of the database-related messages
    const topContents = body.results.map(r => r.content);
    const hasDbRelated = topContents.some(c =>
      c.includes('PostgreSQL') || c.includes('Database connection'),
    );
    assert.ok(hasDbRelated, 'Top results should include database-related messages');
  });

  it('3. Search for "frontend layout" returns CSS message', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'frontend layout',
        participant_urn: TEST_USER,
        threshold: 0.30,
        limit: 5,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.count >= 1, 'Should find frontend-related message');
    const hasCSS = body.results.some(r => r.content.includes('CSS'));
    assert.ok(hasCSS, 'Results should include CSS grid message');
  });

  it('4. High threshold filters irrelevant results', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'quantum chromodynamics particle physics',
        participant_urn: TEST_USER,
        threshold: 0.90,
        limit: 5,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 0, 'Unrelated topic should return no results at high threshold');
  });
});
