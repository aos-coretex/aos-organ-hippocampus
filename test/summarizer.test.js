/**
 * Tests for Hippocampus summarization endpoint and summarizer module.
 * LLM is not available in test context — tests verify skip-existing,
 * force-regenerate logic, and graceful degradation.
 *
 * The actual LLM call is tested indirectly through the /summarize endpoint:
 * without ANTHROPIC_API_KEY set, the LLM client reports unavailable,
 * and we verify the endpoint handles this gracefully.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConversationRoutes } from '../server/routes/conversations.js';
import { getPool, closePool } from '../server/db/pool.js';

// Point to test database
process.env.HIPPOCAMPUS_DB = 'hippocampus_test';

// Ensure LLM API key is NOT set (tests graceful degradation)
delete process.env.ANTHROPIC_API_KEY;

const testConfig = { vectrUrl: 'http://127.0.0.1:19999', graphUrl: 'http://127.0.0.1:19999' };

describe('Summarizer API', () => {
  let server, baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());
    createConversationRoutes(app, testConfig);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM conversations');
  });

  async function createConversationWithMessages(urn) {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn,
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    // Add some messages
    for (const msg of [
      { role: 'user', content: 'How does Graphheight handle distributed consensus?' },
      { role: 'assistant', content: 'Graphheight uses an OTP supervision tree with Mnesia for consensus.' },
      { role: 'user', content: 'What about network partitions?' },
    ]) {
      await fetch(`${baseUrl}/conversations/${urn}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
    }
  }

  it('1. POST /conversations/:urn/summarize — returns 404 for nonexistent', async () => {
    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:missing/summarize`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    assert.equal(res.status, 404);
  });

  it('2. POST /conversations/:urn/summarize — returns 503 when LLM unavailable', async () => {
    const urn = 'urn:graphheight:conversation:sum-unavail-001';
    await createConversationWithMessages(urn);

    const res = await fetch(`${baseUrl}/conversations/${urn}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error.includes('unavailable'));
  });

  it('3. POST /conversations/:urn/summarize — returns cached summary when force=false', async () => {
    const urn = 'urn:graphheight:conversation:sum-cached-001';
    await createConversationWithMessages(urn);

    // Pre-populate summary directly in DB
    const pool = getPool();
    await pool.query(
      "UPDATE conversations SET summary = 'Pre-existing summary about Graphheight.' WHERE urn = $1",
      [urn],
    );

    const res = await fetch(`${baseUrl}/conversations/${urn}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.summary, 'Pre-existing summary about Graphheight.');
    assert.equal(body.cached, true);
  });

  it('4. POST /conversations/:urn/summarize — rejects conversation with no messages', async () => {
    const urn = 'urn:graphheight:conversation:sum-empty-001';
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn, participants: { user_urn: 'urn:test:user:leon' } }),
    });

    const res = await fetch(`${baseUrl}/conversations/${urn}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(res.status, 400);
  });
});
