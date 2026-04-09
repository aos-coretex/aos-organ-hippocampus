#!/usr/bin/env node
/**
 * CV Test: hippocampus-conversation-roundtrip
 * Tests core conversation lifecycle: create → append → retrieve → complete → archive.
 * Exit 0 = PASS, 1 = FAIL, 2 = BLOCKED
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const HIPPOCAMPUS_URL = process.env.HIPPOCAMPUS_URL || 'http://127.0.0.1:4008';
const TEST_URN = `urn:graphheight:conversation:cv-roundtrip-${Date.now()}`;
const TEST_USER = 'urn:graphheight:user:cv-test';

// Pre-flight
try {
  const h = await fetch(`${HIPPOCAMPUS_URL}/health`);
  if (!h.ok) {
    console.log(JSON.stringify({ status: 'blocked', reason: 'Hippocampus unreachable' }));
    process.exit(2);
  }
} catch {
  console.log(JSON.stringify({ status: 'blocked', reason: 'Hippocampus unreachable' }));
  process.exit(2);
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

describe('hippocampus-conversation-roundtrip', () => {
  after(cleanup);

  it('1. Create conversation', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn: TEST_URN, participants: { user_urn: TEST_USER, agent_session: 'cv-sess' } }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.urn, TEST_URN);
    assert.equal(body.status, 'active');
  });

  it('2. Append 3 messages with correct sequence', async () => {
    const roles = ['user', 'assistant', 'user'];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(TEST_URN)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: roles[i], content: `CV test message ${i + 1}` }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.seq, i + 1);
    }
  });

  it('3. Retrieve conversation with messages', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(TEST_URN)}?include_messages=true`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message_count, 3);
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].seq, 1);
    assert.equal(body.messages[2].seq, 3);
  });

  it('4. Complete conversation', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(TEST_URN)}/complete`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'completed');
  });

  it('5. Verify completed state', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(TEST_URN)}`);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.ok(body.completed_at);
  });

  it('6. Archive conversation', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(TEST_URN)}/archive`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'archived');
  });

  it('7. Archived conversation excluded from active listing', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations?status=active&participant_urn=${encodeURIComponent(TEST_USER)}`);
    const body = await res.json();
    const found = body.conversations.find(c => c.urn === TEST_URN);
    assert.equal(found, undefined);
  });

  it('8. Archived conversation still retrievable by URN', async () => {
    const res = await fetch(`${HIPPOCAMPUS_URL}/conversations/${encodeURIComponent(TEST_URN)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'archived');
  });
});
