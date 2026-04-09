#!/usr/bin/env node
/**
 * CV Test: hippocampus-phi-session-flow
 * Tests Phi↔Hippocampus session lifecycle integration.
 * Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const HIPPOCAMPUS_URL = process.env.HIPPOCAMPUS_URL || 'http://127.0.0.1:4008';
const TEST_PREFIX = `urn:graphheight:conversation:cv-phi-${Date.now()}`;
const TEST_USER = 'urn:graphheight:user:cv-test-phi';

// Pre-flight
try {
  const h = await fetch(`${HIPPOCAMPUS_URL}/health`);
  if (!h.ok) throw new Error();
} catch {
  console.log(JSON.stringify({ status: 'blocked', reason: 'Hippocampus unreachable' }));
  process.exit(2);
}

const testUrns = [];

async function cleanup() {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      host: 'localhost', port: 5432,
      database: process.env.HIPPOCAMPUS_DB || 'hippocampus',
      user: process.env.PGUSER || 'graphheight_sys', max: 1,
    });
    for (const urn of testUrns) {
      await pool.query('DELETE FROM messages WHERE conversation_urn = $1', [urn]);
      await pool.query('DELETE FROM conversations WHERE urn = $1', [urn]);
    }
    await pool.end();
  } catch { /* best effort */ }
}

describe('hippocampus-phi-session-flow', () => {
  after(cleanup);

  it('1. Session end: create + batch messages + complete stores correctly', async () => {
    const urn = `${TEST_PREFIX}-end`;
    testUrns.push(urn);

    // Create conversation (Phi would do this at session end)
    const createRes = await fetch(`${HIPPOCAMPUS_URL}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn, participants: { user_urn: TEST_USER, agent_session: 'phi-cv-sess' } }),
    });
    assert.equal(createRes.status, 201);

    // Batch-append 10 messages
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Phi session message ${i + 1}`,
    }));
    const batchRes = await fetch(
      `${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(urn)}/messages/batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      },
    );
    assert.equal(batchRes.status, 201);

    // Complete
    const completeRes = await fetch(
      `${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(urn)}/complete`,
      { method: 'POST' },
    );
    assert.equal(completeRes.status, 200);

    // Verify stored state
    const getRes = await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(urn)}`);
    const conv = await getRes.json();
    assert.equal(conv.status, 'completed');
    assert.equal(conv.message_count, 10);
  });

  it('2. Session start: query returns recently completed conversations', async () => {
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${HIPPOCAMPUS_URL}/conversations?participant_urn=${encodeURIComponent(TEST_USER)}&status=completed&since=${since}&limit=5`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.count >= 1, 'Should find the conversation from step 1');
    const found = body.conversations.find(c => c.urn === `${TEST_PREFIX}-end`);
    assert.ok(found, 'The specific conversation should be in results');
  });

  it('3. Freshness threshold: stale conversations excluded', async () => {
    const urn = `${TEST_PREFIX}-stale`;
    testUrns.push(urn);

    // Create and complete a conversation
    await fetch(`${HIPPOCAMPUS_URL}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn, participants: { user_urn: TEST_USER } }),
    });
    await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(urn)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'stale msg' }),
    });
    await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(urn)}/complete`, { method: 'POST' });

    // Backdate updated_at to 24h ago via direct DB
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      host: 'localhost', port: 5432,
      database: process.env.HIPPOCAMPUS_DB || 'hippocampus',
      user: process.env.PGUSER || 'graphheight_sys', max: 1,
    });
    const staleTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await pool.query('UPDATE conversations SET updated_at = $1 WHERE urn = $2', [staleTs, urn]);
    await pool.end();

    // Query with 12h window — stale conversation should NOT appear
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${HIPPOCAMPUS_URL}/conversations?participant_urn=${encodeURIComponent(TEST_USER)}&status=completed&since=${since}&limit=50`,
    );
    const body = await res.json();
    const found = body.conversations.find(c => c.urn === urn);
    assert.equal(found, undefined, 'Stale conversation should be excluded by freshness threshold');
  });
});
