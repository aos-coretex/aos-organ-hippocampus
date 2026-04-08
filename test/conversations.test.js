/**
 * Tests for Hippocampus conversation CRUD and lifecycle endpoints.
 * Uses hippocampus_test database, standalone Express server (no Spine, no createOrgan).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConversationRoutes } from '../server/routes/conversations.js';
import { getPool, closePool } from '../server/db/pool.js';

// Point to test database
process.env.HIPPOCAMPUS_DB = 'hippocampus_test';

const testConfig = { vectrUrl: 'http://127.0.0.1:4001', graphUrl: 'http://127.0.0.1:4020' };

describe('Conversation API', () => {
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

  // --- Create conversation ---

  it('1. POST /conversations — creates conversation with 201', async () => {
    const res = await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:test-001',
        participants: { user_urn: 'urn:test:user:leon', agent_session: 'sess-1' },
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.urn, 'urn:graphheight:conversation:test-001');
    assert.equal(body.status, 'active');
    assert.equal(body.participants.user_urn, 'urn:test:user:leon');
    assert.ok(body.created_at);
  });

  it('2. POST /conversations — rejects duplicate URN with 409', async () => {
    const payload = {
      urn: 'urn:graphheight:conversation:dup-001',
      participants: { user_urn: 'urn:test:user:leon' },
    };
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const res = await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 409);
  });

  it('3. POST /conversations — rejects missing fields with 400', async () => {
    const res = await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants: { user_urn: 'urn:test:user:leon' } }),
    });
    assert.equal(res.status, 400);
  });

  // --- Get conversation ---

  it('4. GET /conversations/:urn — retrieves conversation with 200', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:get-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    const res = await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:get-001`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.urn, 'urn:graphheight:conversation:get-001');
    assert.ok(Array.isArray(body.messages));
  });

  it('5. GET /conversations/:urn?include_messages=false — omits messages', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:nomsg-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:nomsg-001?include_messages=false`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.messages, undefined);
  });

  it('6. GET /conversations/:urn — returns 404 for nonexistent', async () => {
    const res = await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:nonexistent`);
    assert.equal(res.status, 404);
  });

  // --- List conversations ---

  it('7. GET /conversations — lists conversations', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:list-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    const res = await fetch(`${baseUrl}/conversations`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.conversations));
    assert.equal(body.count, 1);
  });

  it('8. GET /conversations?participant_urn=X&status=active — filters correctly', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:filter-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:filter-002',
        participants: { user_urn: 'urn:test:user:other' },
      }),
    });

    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=urn:test:user:leon&status=active`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.conversations[0].participants.user_urn, 'urn:test:user:leon');
  });

  // --- Append messages ---

  it('9. POST /conversations/:urn/messages — appends with sequence number', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:msg-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:msg-001/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content: 'Hello' }),
      },
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.seq, 1);
    assert.equal(body.embedded, false);
    assert.equal(body.role, 'user');
  });

  it('10. POST /conversations/:urn/messages — rejects append to completed', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:closed-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });
    await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:closed-001/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'msg' }),
    });
    await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:closed-001/complete`, {
      method: 'POST',
    });

    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:closed-001/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content: 'too late' }),
      },
    );
    assert.equal(res.status, 400);
  });

  it('11. Multiple appends — sequence numbers are monotonically increasing', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:seq-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    const seqs = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(
        `${baseUrl}/conversations/urn:graphheight:conversation:seq-001/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` }),
        },
      );
      const body = await res.json();
      seqs.push(body.seq);
    }

    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  });

  // --- Complete conversation ---

  it('12. POST /conversations/:urn/complete — changes status to completed', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:comp-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });
    await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:comp-001/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'hello' }),
    });

    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:comp-001/complete`,
      { method: 'POST' },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.ok(body.completed_at);
  });

  it('13. POST /conversations/:urn/complete — rejects already completed', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:recomp-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });
    await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:recomp-001/complete`, {
      method: 'POST',
    });

    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:recomp-001/complete`,
      { method: 'POST' },
    );
    assert.equal(res.status, 400);
  });

  // --- Archive conversation ---

  it('14. POST /conversations/:urn/archive — changes status to archived', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:arch-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });
    await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:arch-001/complete`, {
      method: 'POST',
    });

    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:arch-001/archive`,
      { method: 'POST' },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'archived');
    assert.ok(body.archived_at);
  });

  it('15. POST /conversations/:urn/archive — rejects archiving active (not completed)', async () => {
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:badarch-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    const res = await fetch(
      `${baseUrl}/conversations/urn:graphheight:conversation:badarch-001/archive`,
      { method: 'POST' },
    );
    assert.equal(res.status, 400);
  });

  it('16. GET /conversations?status=active — excludes archived', async () => {
    // Create and archive one conversation
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:excl-001',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });
    await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:excl-001/complete`, {
      method: 'POST',
    });
    await fetch(`${baseUrl}/conversations/urn:graphheight:conversation:excl-001/archive`, {
      method: 'POST',
    });

    // Create one active conversation
    await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn: 'urn:graphheight:conversation:excl-002',
        participants: { user_urn: 'urn:test:user:leon' },
      }),
    });

    const res = await fetch(`${baseUrl}/conversations?status=active`);
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.conversations[0].urn, 'urn:graphheight:conversation:excl-002');
  });
});
