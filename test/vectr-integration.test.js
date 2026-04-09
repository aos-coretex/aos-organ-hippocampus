/**
 * Vectr ↔ Hippocampus integration tests.
 * Tests the embedding pipeline end-to-end:
 *   - Message embedding on append (single + batch)
 *   - Semantic search via POST /query
 *   - Conversation-level search
 *   - Graceful degradation when Vectr unavailable
 *   - Embedding backfill
 *
 * Uses a mock Vectr HTTP server that returns deterministic 384-dim embeddings.
 * Uses hippocampus_test database.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createConversationRoutes } from '../server/routes/conversations.js';
import { createQueryRoutes } from '../server/routes/query.js';
import { createBackfillRoutes } from '../server/routes/backfill.js';
import { getPool, closePool } from '../server/db/pool.js';

// Point to test database
process.env.HIPPOCAMPUS_DB = 'hippocampus_test';

// --- Mock Vectr server ---

/**
 * Deterministic 384-dim embedding from text.
 * Same text always produces the same vector. L2-normalized.
 */
function mockEmbedding(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash;
  }
  const vec = new Array(384);
  let seed = Math.abs(hash) || 1;
  for (let i = 0; i < 384; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

function createMockVectr() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime_s: 100 }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);

          if (req.url === '/embed') {
            if (!data.text) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "missing 'text' field" }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ embedding: mockEmbedding(data.text), dimensions: 384 }));
            return;
          }

          if (req.url === '/embed-batch') {
            if (!Array.isArray(data.texts)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "missing 'texts' array" }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              embeddings: data.texts.map(t => mockEmbedding(t)),
              dimensions: 384,
            }));
            return;
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return server;
}

// --- Helpers ---

async function createConversation(baseUrl, urn, userUrn) {
  return fetch(`${baseUrl}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urn,
      participants: { user_urn: userUrn, agent_session: 'test-session' },
    }),
  });
}

// --- Test suites ---

describe('Vectr Integration — Message Embedding', () => {
  let hippoServer, hippoUrl, vectrServer, vectrUrl;

  before(async () => {
    // Start mock Vectr
    vectrServer = createMockVectr();
    await new Promise(resolve => {
      vectrServer.listen(0, '127.0.0.1', () => {
        vectrUrl = `http://127.0.0.1:${vectrServer.address().port}`;
        resolve();
      });
    });

    // Start Hippocampus test server with Vectr URL
    const app = express();
    app.use(express.json());
    const testConfig = { vectrUrl, graphUrl: 'http://127.0.0.1:4020' };
    createConversationRoutes(app, testConfig);
    createQueryRoutes(app, testConfig);
    createBackfillRoutes(app, testConfig);

    await new Promise(resolve => {
      hippoServer = app.listen(0, '127.0.0.1', () => {
        hippoUrl = `http://127.0.0.1:${hippoServer.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise(resolve => hippoServer.close(resolve));
    await new Promise(resolve => vectrServer.close(resolve));
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM conversations');
  });

  it('1. Single message append gets embedding', async () => {
    const urn = 'urn:graphheight:conversation:embed-single-001';
    await createConversation(hippoUrl, urn, 'urn:test:user:leon');

    const res = await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'PostgreSQL indexing strategies' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.embedded, true);

    // Verify in database
    const pool = getPool();
    const dbCheck = await pool.query(
      'SELECT embedding IS NOT NULL AS has_embedding FROM messages WHERE id = $1',
      [body.id],
    );
    assert.equal(dbCheck.rows[0].has_embedding, true);
  });

  it('2. Batch messages get embeddings', async () => {
    const urn = 'urn:graphheight:conversation:embed-batch-001';
    await createConversation(hippoUrl, urn, 'urn:test:user:leon');

    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message about topic ${i}`,
    }));

    const res = await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.embedded_count, 5);

    // Verify all messages have embeddings in database
    const pool = getPool();
    const dbCheck = await pool.query(
      'SELECT COUNT(*) AS embedded FROM messages WHERE conversation_urn = $1 AND embedding IS NOT NULL',
      [urn],
    );
    assert.equal(parseInt(dbCheck.rows[0].embedded, 10), 5);
  });

  it('3. Semantic search finds embedded messages', async () => {
    const urn = 'urn:graphheight:conversation:search-001';
    const userUrn = 'urn:test:user:leon';
    await createConversation(hippoUrl, urn, userUrn);

    // Append messages with distinct content
    const messages = [
      { role: 'user', content: 'PostgreSQL database indexing strategies' },
      { role: 'assistant', content: 'B-tree indexes are the default index type' },
      { role: 'user', content: 'What about cooking recipes for pasta' },
    ];

    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });

    // Search with exact text of first message — cosine similarity should be 1.0
    const searchRes = await fetch(`${hippoUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'PostgreSQL database indexing strategies',
        participant_urn: userUrn,
        threshold: 0.99,
      }),
    });
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    assert.ok(searchBody.count >= 1, 'Should find at least the exact matching message');
    assert.equal(searchBody.results[0].content, 'PostgreSQL database indexing strategies');
    assert.ok(searchBody.results[0].similarity >= 0.99, 'Exact match should have near-perfect similarity');
  });

  it('4. Participant scoping in search', async () => {
    const userAUrn = 'urn:test:user:alice';
    const userBUrn = 'urn:test:user:bob';
    const sharedContent = 'Shared topic about distributed systems';

    // Create conversations for two users with same content
    const urnA = 'urn:graphheight:conversation:scope-a';
    await createConversation(hippoUrl, urnA, userAUrn);
    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urnA)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: sharedContent }),
    });

    const urnB = 'urn:graphheight:conversation:scope-b';
    await createConversation(hippoUrl, urnB, userBUrn);
    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urnB)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: sharedContent }),
    });

    // Search scoped to user A
    const res = await fetch(`${hippoUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: sharedContent,
        participant_urn: userAUrn,
        threshold: 0.50,
      }),
    });
    const body = await res.json();
    // Should only return user A's conversation
    for (const result of body.results) {
      assert.equal(result.conversation_urn, urnA);
    }
  });

  it('5. Search requires participant_urn for user-scoped queries', async () => {
    const res = await fetch(`${hippoUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    assert.equal(res.status, 400);
  });

  it('6. Threshold filtering — high threshold reduces results', async () => {
    const urn = 'urn:graphheight:conversation:threshold-001';
    const userUrn = 'urn:test:user:leon';
    await createConversation(hippoUrl, urn, userUrn);

    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'exact match text' },
          { role: 'assistant', content: 'completely different unrelated topic about bananas' },
        ],
      }),
    });

    // Search with very high threshold — should only match exact text
    const res = await fetch(`${hippoUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'exact match text',
        participant_urn: userUrn,
        threshold: 0.99,
      }),
    });
    const body = await res.json();
    // Only the exact match should pass threshold 0.99
    assert.equal(body.count, 1);
    assert.equal(body.results[0].content, 'exact match text');
  });

  it('7. Backfill fills embedding gaps', async () => {
    const pool = getPool();
    const urn = 'urn:graphheight:conversation:backfill-001';

    // Insert messages directly without embeddings (simulating Vectr downtime)
    await pool.query(
      `INSERT INTO conversations (urn, user_urn, status, message_count)
       VALUES ($1, $2, 'active', 5)`,
      [urn, 'urn:test:user:leon'],
    );
    for (let i = 1; i <= 5; i++) {
      await pool.query(
        `INSERT INTO messages (conversation_urn, role, content, seq)
         VALUES ($1, 'user', $2, $3)`,
        [urn, `Backfill message ${i}`, i],
      );
    }

    // Verify no embeddings
    const before = await pool.query(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_urn = $1 AND embedding IS NOT NULL',
      [urn],
    );
    assert.equal(parseInt(before.rows[0].count, 10), 0);

    // Run backfill
    const res = await fetch(`${hippoUrl}/backfill/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 100, conversation_urn: urn }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.messages_backfilled, 5);

    // Verify embeddings exist
    const afterCheck = await pool.query(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_urn = $1 AND embedding IS NOT NULL',
      [urn],
    );
    assert.equal(parseInt(afterCheck.rows[0].count, 10), 5);
  });

  it('8. Conversation-level search with summary embeddings', async () => {
    const pool = getPool();
    const userUrn = 'urn:test:user:leon';
    const summaryText = 'Discussion about Erlang OTP patterns and supervision trees';

    // Create a completed conversation with summary + summary embedding
    const urn = 'urn:graphheight:conversation:convsearch-001';
    await createConversation(hippoUrl, urn, userUrn);
    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'test' }),
    });
    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/complete`, {
      method: 'POST',
    });

    // Write summary + embedding directly (summarizer not available in tests)
    const summaryEmb = mockEmbedding(summaryText);
    await pool.query(
      'UPDATE conversations SET summary = $1, summary_embedding = $2 WHERE urn = $3',
      [summaryText, `[${summaryEmb.join(',')}]`, urn],
    );

    // Search at conversation level with exact summary text
    const res = await fetch(`${hippoUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: summaryText,
        participant_urn: userUrn,
        search_level: 'conversations',
        threshold: 0.99,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.count >= 1);
    assert.equal(body.results[0].conversation_urn, urn);
    assert.ok(body.results[0].similarity >= 0.99);
  });
});

describe('Vectr Integration — Graceful Degradation (No Vectr)', () => {
  let hippoServer, hippoUrl;

  before(async () => {
    // Start Hippocampus WITHOUT a Vectr server (bad URL)
    const app = express();
    app.use(express.json());
    const testConfig = { vectrUrl: 'http://127.0.0.1:1', graphUrl: 'http://127.0.0.1:4020' };
    createConversationRoutes(app, testConfig);
    createQueryRoutes(app, testConfig);

    await new Promise(resolve => {
      hippoServer = app.listen(0, '127.0.0.1', () => {
        hippoUrl = `http://127.0.0.1:${hippoServer.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise(resolve => hippoServer.close(resolve));
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM conversations');
  });

  it('9. Single append stores message without embedding when Vectr down', async () => {
    const urn = 'urn:graphheight:conversation:novectr-001';
    await createConversation(hippoUrl, urn, 'urn:test:user:leon');

    const res = await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'Message without Vectr' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.embedded, false);
    assert.ok(body.id, 'Message should still be stored');
  });

  it('10. Batch append stores all messages without embeddings when Vectr down', async () => {
    const urn = 'urn:graphheight:conversation:novectr-batch-001';
    await createConversation(hippoUrl, urn, 'urn:test:user:leon');

    const res = await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'msg 1' },
          { role: 'assistant', content: 'msg 2' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.messages_stored, 2);
    assert.equal(body.embedded_count, 0);
  });

  it('11. Search returns 503 when Vectr unavailable', async () => {
    const res = await fetch(`${hippoUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'test query',
        participant_urn: 'urn:test:user:leon',
      }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error.includes('Vectr unavailable'));
  });
});
