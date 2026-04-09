/**
 * Phi ↔ Hippocampus integration tests.
 * Tests the Hippocampus API surface that Phi consumes at session boundaries:
 *   - Session start: context loading via GET /conversations
 *   - Session end: transcript storage via POST create → batch → complete
 *   - Context continuity: 12-hour freshness threshold
 *
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

// --- Helpers ---

async function createConversation(baseUrl, urn, userUrn, opts = {}) {
  const res = await fetch(`${baseUrl}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urn,
      participants: { user_urn: userUrn, agent_session: opts.agent_session || 'test-session' },
      metadata: opts.metadata || {},
    }),
  });
  return res;
}

async function addMessages(baseUrl, urn, messages) {
  const res = await fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}/messages/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  return res;
}

async function completeConversation(baseUrl, urn) {
  return fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}/complete`, {
    method: 'POST',
  });
}

async function archiveConversation(baseUrl, urn) {
  return fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}/archive`, {
    method: 'POST',
  });
}

// Set updated_at directly in the database for time-window tests
async function setUpdatedAt(pool, urn, hoursAgo) {
  const ts = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  await pool.query('UPDATE conversations SET updated_at = $1 WHERE urn = $2', [ts, urn]);
}

// --- Test suite ---

describe('Phi Integration — Session Start (Context Loading)', () => {
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

  it('1. Returns recent completed conversations with summaries', async () => {
    const pool = getPool();
    const userUrn = 'urn:graphheight:user:leon';

    // Create 3 completed conversations with summaries
    for (let i = 1; i <= 3; i++) {
      const urn = `urn:graphheight:conversation:ctx-${i}`;
      await createConversation(baseUrl, urn, userUrn);
      await addMessages(baseUrl, urn, [
        { role: 'user', content: `Question ${i}` },
        { role: 'assistant', content: `Answer ${i}` },
      ]);
      await completeConversation(baseUrl, urn);
      // Write summary directly (summarizer agent not available in tests)
      await pool.query(
        'UPDATE conversations SET summary = $1 WHERE urn = $2',
        [`Summary of conversation ${i}`, urn],
      );
    }

    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=${encodeURIComponent(userUrn)}&status=completed&since=${since}&limit=5`,
    );
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.count, 3);
    for (const conv of body.conversations) {
      assert.ok(conv.summary, 'Each conversation should have a summary');
      assert.equal(conv.participants.user_urn, userUrn);
    }
  });

  it('2. Excludes stale conversations (>12h old)', async () => {
    const pool = getPool();
    const userUrn = 'urn:graphheight:user:leon';

    // Create a conversation completed 24 hours ago
    const staleUrn = 'urn:graphheight:conversation:stale-001';
    await createConversation(baseUrl, staleUrn, userUrn);
    await addMessages(baseUrl, staleUrn, [{ role: 'user', content: 'old' }]);
    await completeConversation(baseUrl, staleUrn);
    await setUpdatedAt(pool, staleUrn, 24);

    // Create a recent conversation
    const freshUrn = 'urn:graphheight:conversation:fresh-001';
    await createConversation(baseUrl, freshUrn, userUrn);
    await addMessages(baseUrl, freshUrn, [{ role: 'user', content: 'new' }]);
    await completeConversation(baseUrl, freshUrn);

    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=${encodeURIComponent(userUrn)}&status=completed&since=${since}&limit=5`,
    );
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.conversations[0].urn, freshUrn);
  });

  it('3. Excludes archived conversations from status=completed filter', async () => {
    const userUrn = 'urn:graphheight:user:leon';

    // Create and archive a conversation
    const archivedUrn = 'urn:graphheight:conversation:archived-001';
    await createConversation(baseUrl, archivedUrn, userUrn);
    await addMessages(baseUrl, archivedUrn, [{ role: 'user', content: 'msg' }]);
    await completeConversation(baseUrl, archivedUrn);
    await archiveConversation(baseUrl, archivedUrn);

    // Create a completed (non-archived) conversation
    const completedUrn = 'urn:graphheight:conversation:completed-001';
    await createConversation(baseUrl, completedUrn, userUrn);
    await addMessages(baseUrl, completedUrn, [{ role: 'user', content: 'msg' }]);
    await completeConversation(baseUrl, completedUrn);

    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=${encodeURIComponent(userUrn)}&status=completed&since=${since}&limit=5`,
    );
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.conversations[0].urn, completedUrn);
  });

  it('4. Returns empty result set for user with no conversations', async () => {
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=urn:graphheight:user:nobody&status=completed&since=${since}&limit=5`,
    );
    const body = await res.json();
    assert.equal(body.count, 0);
    assert.deepEqual(body.conversations, []);
  });
});

describe('Phi Integration — Session End (Transcript Storage)', () => {
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

  it('5. Full flow: create → batch messages → complete', async () => {
    const urn = 'urn:graphheight:conversation:fullflow-001';
    const userUrn = 'urn:graphheight:user:leon';

    // Step 1: Create conversation
    const createRes = await createConversation(baseUrl, urn, userUrn, {
      agent_session: 'phi-test-session',
      metadata: { session_id: 'phi-test-session' },
    });
    assert.equal(createRes.status, 201);

    // Step 2: Batch append 10 messages
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i + 1}`,
        participant_urn: userUrn,
      });
    }
    const batchRes = await addMessages(baseUrl, urn, messages);
    assert.equal(batchRes.status, 201);
    const batchBody = await batchRes.json();
    assert.equal(batchBody.messages_stored, 10);
    assert.deepEqual(batchBody.seq_range, { from: 1, to: 10 });

    // Step 3: Complete
    const completeRes = await completeConversation(baseUrl, urn);
    assert.equal(completeRes.status, 200);
    const completeBody = await completeRes.json();
    assert.equal(completeBody.status, 'completed');

    // Verify conversation exists with correct state
    const getRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}`);
    const conv = await getRes.json();
    assert.equal(conv.status, 'completed');
    assert.equal(conv.message_count, 10);
    assert.equal(conv.messages.length, 10);
  });

  it('6. Batch message ordering — sequence numbers are 1..N', async () => {
    const urn = 'urn:graphheight:conversation:ordering-001';
    await createConversation(baseUrl, urn, 'urn:graphheight:user:leon');

    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}`,
    }));

    const batchRes = await addMessages(baseUrl, urn, messages);
    assert.equal(batchRes.status, 201);
    const batchBody = await batchRes.json();
    assert.deepEqual(batchBody.seq_range, { from: 1, to: 20 });

    // Verify order in database
    const getRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}?limit=100`);
    const conv = await getRes.json();
    assert.equal(conv.messages.length, 20);
    for (let i = 0; i < 20; i++) {
      assert.equal(conv.messages[i].seq, i + 1);
      assert.equal(conv.messages[i].content, `Message ${i + 1}`);
    }
  });

  it('7. Batch rejects append to non-active conversation', async () => {
    const urn = 'urn:graphheight:conversation:closed-batch-001';
    await createConversation(baseUrl, urn, 'urn:graphheight:user:leon');
    await addMessages(baseUrl, urn, [{ role: 'user', content: 'msg' }]);
    await completeConversation(baseUrl, urn);

    const batchRes = await addMessages(baseUrl, urn, [{ role: 'user', content: 'too late' }]);
    assert.equal(batchRes.status, 400);
  });

  it('8. Batch rejects empty messages array', async () => {
    const urn = 'urn:graphheight:conversation:empty-batch-001';
    await createConversation(baseUrl, urn, 'urn:graphheight:user:leon');

    const res = await fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}/messages/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('9. Batch rejects messages with invalid roles', async () => {
    const urn = 'urn:graphheight:conversation:badrole-001';
    await createConversation(baseUrl, urn, 'urn:graphheight:user:leon');

    const res = await addMessages(baseUrl, urn, [
      { role: 'user', content: 'ok' },
      { role: 'villain', content: 'bad role' },
    ]);
    assert.equal(res.status, 400);
  });

  it('10. Batch continues sequence after individual messages', async () => {
    const urn = 'urn:graphheight:conversation:mixed-001';
    await createConversation(baseUrl, urn, 'urn:graphheight:user:leon');

    // Append 3 individual messages
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content: `single-${i}` }),
      });
    }

    // Batch append 5 more
    const batchRes = await addMessages(baseUrl, urn, Array.from({ length: 5 }, (_, i) => ({
      role: 'assistant',
      content: `batch-${i}`,
    })));
    assert.equal(batchRes.status, 201);
    const batchBody = await batchRes.json();
    assert.deepEqual(batchBody.seq_range, { from: 4, to: 8 });

    // Verify total
    const getRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(urn)}?limit=100`);
    const conv = await getRes.json();
    assert.equal(conv.message_count, 8);
    assert.equal(conv.messages.length, 8);
  });
});

describe('Phi Integration — Context Continuity (12-Hour Window)', () => {
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

  it('11. since filters on updated_at, not created_at', async () => {
    const pool = getPool();
    const userUrn = 'urn:graphheight:user:leon';

    // Create a conversation 48 hours ago but complete it (update updated_at) 2 hours ago
    const urn = 'urn:graphheight:conversation:old-but-recent-001';
    await createConversation(baseUrl, urn, userUrn);
    await addMessages(baseUrl, urn, [{ role: 'user', content: 'old conv' }]);

    // Backdate created_at to 48h ago
    const createdTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await pool.query('UPDATE conversations SET created_at = $1 WHERE urn = $2', [createdTs, urn]);

    // Complete it — updated_at will be NOW()
    await completeConversation(baseUrl, urn);

    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=${encodeURIComponent(userUrn)}&status=completed&since=${since}&limit=5`,
    );
    const body = await res.json();
    assert.equal(body.count, 1, 'Conversation created 48h ago but completed just now should appear');
    assert.equal(body.conversations[0].urn, urn);
  });

  it('12. Limit parameter caps results', async () => {
    const userUrn = 'urn:graphheight:user:leon';

    // Create 8 completed conversations
    for (let i = 1; i <= 8; i++) {
      const urn = `urn:graphheight:conversation:limit-${i}`;
      await createConversation(baseUrl, urn, userUrn);
      await addMessages(baseUrl, urn, [{ role: 'user', content: `msg ${i}` }]);
      await completeConversation(baseUrl, urn);
    }

    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=${encodeURIComponent(userUrn)}&status=completed&since=${since}&limit=5`,
    );
    const body = await res.json();
    assert.equal(body.count, 5, 'Should return at most 5 conversations');
  });

  it('13. Results ordered by updated_at descending (most recent first)', async () => {
    const pool = getPool();
    const userUrn = 'urn:graphheight:user:leon';

    // Create 3 conversations and stagger their updated_at
    const urns = [];
    for (let i = 1; i <= 3; i++) {
      const urn = `urn:graphheight:conversation:order-${i}`;
      urns.push(urn);
      await createConversation(baseUrl, urn, userUrn);
      await addMessages(baseUrl, urn, [{ role: 'user', content: `msg ${i}` }]);
      await completeConversation(baseUrl, urn);
    }

    // Set updated_at: order-1 = 1h ago, order-2 = 3h ago, order-3 = 2h ago
    await setUpdatedAt(pool, urns[0], 1);
    await setUpdatedAt(pool, urns[1], 3);
    await setUpdatedAt(pool, urns[2], 2);

    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${baseUrl}/conversations?participant_urn=${encodeURIComponent(userUrn)}&status=completed&since=${since}&limit=5`,
    );
    const body = await res.json();
    assert.equal(body.count, 3);
    // Most recent first: order-1 (1h), order-3 (2h), order-2 (3h)
    assert.equal(body.conversations[0].urn, urns[0]);
    assert.equal(body.conversations[1].urn, urns[2]);
    assert.equal(body.conversations[2].urn, urns[1]);
  });
});
