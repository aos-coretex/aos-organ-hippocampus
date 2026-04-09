/**
 * Spine message handler tests for Hippocampus.
 * Tests the directed OTM handler layer:
 *   - create_conversation: Spine envelope → conversation created
 *   - append_message: Spine envelope → message appended with sequence
 *   - query_conversations: Spine envelope → semantic search results
 *   - unknown event_type → error response (not crash)
 *   - Broadcast production on conversation completion (via HTTP route)
 *
 * Uses hippocampus_test database, mock Vectr server.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { handleDirectedMessage } from '../server/handlers/spine-commands.js';
import { createConversationRoutes } from '../server/routes/conversations.js';
import { getPool, closePool } from '../server/db/pool.js';

// Point to test database
process.env.HIPPOCAMPUS_DB = 'hippocampus_test';

// --- Mock Vectr ---

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
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const data = JSON.parse(body);
        if (req.url === '/embed') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ embedding: mockEmbedding(data.text), dimensions: 384 }));
        } else if (req.url === '/embed-batch') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ embeddings: data.texts.map(t => mockEmbedding(t)), dimensions: 384 }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// --- Test helpers ---

function makeEnvelope(eventType, payload, source = 'Phi') {
  return {
    type: 'OTM',
    source_organ: source,
    target_organ: 'Hippocampus',
    message_id: `urn:llm-ops:otm:test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    payload: { event_type: eventType, ...payload },
  };
}

// --- Test suites ---

describe('Spine Directed Message Handlers', () => {
  let vectrServer, vectrUrl, services;

  before(async () => {
    vectrServer = createMockVectr();
    await new Promise(resolve => {
      vectrServer.listen(0, '127.0.0.1', () => {
        vectrUrl = `http://127.0.0.1:${vectrServer.address().port}`;
        resolve();
      });
    });
    services = { config: { vectrUrl } };
  });

  after(async () => {
    await new Promise(resolve => vectrServer.close(resolve));
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM conversations');
  });

  it('1. create_conversation — creates conversation from Spine OTM', async () => {
    const envelope = makeEnvelope('create_conversation', {
      urn: 'urn:graphheight:conversation:spine-001',
      participants: { user_urn: 'urn:test:user:leon', agent_session: 'sess-1' },
    });

    const response = await handleDirectedMessage(envelope, services);
    assert.equal(response.type, 'OTM');
    assert.equal(response.source_organ, 'Hippocampus');
    assert.equal(response.target_organ, 'Phi');
    assert.equal(response.payload.event_type, 'create_conversation_result');
    assert.equal(response.payload.urn, 'urn:graphheight:conversation:spine-001');
    assert.equal(response.payload.status, 'active');
    assert.equal(response.payload.request_message_id, envelope.message_id);
  });

  it('2. create_conversation — rejects duplicate URN', async () => {
    const payload = {
      urn: 'urn:graphheight:conversation:spine-dup',
      participants: { user_urn: 'urn:test:user:leon' },
    };

    await handleDirectedMessage(makeEnvelope('create_conversation', payload), services);
    const response = await handleDirectedMessage(makeEnvelope('create_conversation', payload), services);
    assert.equal(response.payload.event_type, 'error');
    assert.ok(response.payload.error.includes('already exists'));
  });

  it('3. append_message — appends message with sequence number', async () => {
    // Create conversation first
    await handleDirectedMessage(makeEnvelope('create_conversation', {
      urn: 'urn:graphheight:conversation:spine-msg-001',
      participants: { user_urn: 'urn:test:user:leon' },
    }), services);

    const response = await handleDirectedMessage(makeEnvelope('append_message', {
      conversation_urn: 'urn:graphheight:conversation:spine-msg-001',
      role: 'user',
      content: 'Hello from Spine',
      participant_urn: 'urn:test:user:leon',
    }), services);

    assert.equal(response.payload.event_type, 'append_message_result');
    assert.equal(response.payload.seq, 1);
    assert.equal(response.payload.embedded, true);
    assert.ok(response.payload.id);
  });

  it('4. append_message — rejects bad role', async () => {
    await handleDirectedMessage(makeEnvelope('create_conversation', {
      urn: 'urn:graphheight:conversation:spine-badrole',
      participants: { user_urn: 'urn:test:user:leon' },
    }), services);

    const response = await handleDirectedMessage(makeEnvelope('append_message', {
      conversation_urn: 'urn:graphheight:conversation:spine-badrole',
      role: 'villain',
      content: 'bad',
    }), services);
    assert.equal(response.payload.event_type, 'error');
    assert.ok(response.payload.error.includes('role must be'));
  });

  it('5. query_conversations — returns search results', async () => {
    // Create conversation with embedded message
    await handleDirectedMessage(makeEnvelope('create_conversation', {
      urn: 'urn:graphheight:conversation:spine-query-001',
      participants: { user_urn: 'urn:test:user:leon' },
    }), services);

    await handleDirectedMessage(makeEnvelope('append_message', {
      conversation_urn: 'urn:graphheight:conversation:spine-query-001',
      role: 'user',
      content: 'Erlang supervision trees',
    }), services);

    const response = await handleDirectedMessage(makeEnvelope('query_conversations', {
      query: 'Erlang supervision trees',
      participant_urn: 'urn:test:user:leon',
      limit: 5,
      threshold: 0.99,
    }, 'Thalamus'), services);

    assert.equal(response.payload.event_type, 'query_response');
    assert.ok(response.payload.count >= 1);
    assert.equal(response.payload.results[0].content, 'Erlang supervision trees');
  });

  it('6. unknown event_type — returns error (no crash)', async () => {
    const response = await handleDirectedMessage(makeEnvelope('delete_universe', {}), services);
    assert.equal(response.payload.event_type, 'error');
    assert.ok(response.payload.error.includes('Unknown event_type'));
    assert.equal(response.target_organ, 'Phi');
  });

  it('7. response targets the source_organ of the request', async () => {
    const envelope = makeEnvelope('query_conversations', {
      query: 'test',
    }, 'Axon');

    const response = await handleDirectedMessage(envelope, services);
    // Axon sent the request, but query requires participant_urn, so error response
    assert.equal(response.target_organ, 'Axon');
  });
});

describe('Spine Broadcast Production — conversation_completed', () => {
  let hippoServer, hippoUrl, vectrServer, vectrUrl;
  let capturedEvents;

  before(async () => {
    capturedEvents = [];

    // Mock Vectr
    vectrServer = createMockVectr();
    await new Promise(resolve => {
      vectrServer.listen(0, '127.0.0.1', () => {
        vectrUrl = `http://127.0.0.1:${vectrServer.address().port}`;
        resolve();
      });
    });

    // Mock Spine (just captures POST /events)
    const spineServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/events') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          capturedEvents.push(JSON.parse(body));
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ urn: 'urn:test:event:1', processed: false }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => {
      spineServer.listen(0, '127.0.0.1', () => {
        const spineUrl = `http://127.0.0.1:${spineServer.address().port}`;

        // Start Hippocampus with mock Spine URL
        const app = express();
        app.use(express.json());
        const testConfig = { vectrUrl, graphUrl: 'http://127.0.0.1:4020', spineUrl };
        createConversationRoutes(app, testConfig, () => null);

        hippoServer = app.listen(0, '127.0.0.1', () => {
          hippoUrl = `http://127.0.0.1:${hippoServer.address().port}`;
          resolve();
        });

        // Store spineServer ref for cleanup
        hippoServer._spineServer = spineServer;
      });
    });
  });

  after(async () => {
    await new Promise(resolve => hippoServer.close(resolve));
    await new Promise(resolve => hippoServer._spineServer.close(resolve));
    await new Promise(resolve => vectrServer.close(resolve));
    await closePool();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM conversations');
    capturedEvents.length = 0;
  });

  it('8. Completing a conversation emits conversation_completed to Spine', async () => {
    const urn = 'urn:graphheight:conversation:broadcast-001';

    // Create conversation
    await fetch(`${hippoUrl}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn,
        participants: { user_urn: 'urn:test:user:leon', agent_session: 'sess-1' },
      }),
    });

    // Add a message
    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'test' }),
    });

    // Complete
    await fetch(`${hippoUrl}/conversations/${encodeURIComponent(urn)}/complete`, {
      method: 'POST',
    });

    // Wait briefly for async emit
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(capturedEvents.length, 1);
    const event = capturedEvents[0];
    assert.equal(event.event_type, 'conversation_completed');
    assert.equal(event.source, 'Hippocampus');
    assert.equal(event.payload.conversation_urn, urn);
    assert.equal(event.payload.message_count, 1);
    assert.equal(event.payload.participants.user_urn, 'urn:test:user:leon');
    assert.equal(event.payload.participants.agent_session, 'sess-1');
  });
});
