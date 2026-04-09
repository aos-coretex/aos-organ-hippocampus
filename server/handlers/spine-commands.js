/**
 * Spine directed OTM message handlers for Hippocampus.
 *
 * Protocol adapter: Spine envelope → domain operation → Spine response.
 * Reuses the same database access layer (getPool) as HTTP route handlers.
 * Does NOT duplicate SQL — both protocols share the same data model.
 *
 * Three directed message types (organ definition Section 4):
 *   - create_conversation (from Phi)
 *   - append_message (from Phi or agent)
 *   - query_conversations (from Thalamus, Soul, Axon)
 */
import { getPool } from '../db/pool.js';
import { embedText } from '../../lib/vectr-client.js';
import pgvector from 'pgvector/pg';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function makeResponse(envelope, payload) {
  return {
    type: 'OTM',
    source_organ: 'Hippocampus',
    target_organ: envelope.source_organ,
    payload: {
      ...payload,
      request_message_id: envelope.message_id,
    },
  };
}

function makeError(envelope, error) {
  return makeResponse(envelope, {
    event_type: 'error',
    error,
  });
}

/**
 * Directed message handler — dispatches by event_type.
 * Called by createOrgan's onMessage callback.
 *
 * @param {object} envelope - Spine OTM envelope
 * @param {object} services - { config } injected by server/index.js
 * @returns {Promise<object|null>} - OTM response envelope
 */
export async function handleDirectedMessage(envelope, services) {
  const { payload } = envelope;

  try {
    switch (payload?.event_type) {
      case 'create_conversation':
        return await handleCreateConversation(envelope, services);
      case 'append_message':
        return await handleAppendMessage(envelope, services);
      case 'query_conversations':
        return await handleQueryConversations(envelope, services);
      default:
        log('spine_unknown_event', { event_type: payload?.event_type, source: envelope.source_organ });
        return makeError(envelope, `Unknown event_type: ${payload?.event_type}`);
    }
  } catch (err) {
    log('spine_handler_error', { event_type: payload?.event_type, error: err.message });
    return makeError(envelope, err.message);
  }
}

// --- create_conversation ---

async function handleCreateConversation(envelope, _services) {
  const { urn, participants } = envelope.payload;

  if (!urn || !participants) {
    return makeError(envelope, 'urn and participants are required');
  }

  const pool = getPool();
  const existing = await pool.query('SELECT urn FROM conversations WHERE urn = $1', [urn]);
  if (existing.rows.length > 0) {
    return makeError(envelope, `Conversation URN already exists: ${urn}`);
  }

  const result = await pool.query(
    `INSERT INTO conversations (urn, user_urn, persona_urn, agent_session, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING urn, status, user_urn, persona_urn, agent_session, created_at`,
    [
      urn,
      participants.user_urn || null,
      participants.persona_urn || null,
      participants.agent_session || null,
      JSON.stringify(envelope.payload.metadata || {}),
    ],
  );

  const row = result.rows[0];
  return makeResponse(envelope, {
    event_type: 'create_conversation_result',
    urn: row.urn,
    status: row.status,
    created_at: row.created_at,
  });
}

// --- append_message ---

async function handleAppendMessage(envelope, services) {
  const { conversation_urn, role, content, participant_urn } = envelope.payload;

  if (!conversation_urn || !role || !content) {
    return makeError(envelope, 'conversation_urn, role, and content are required');
  }

  const validRoles = ['user', 'assistant', 'system'];
  if (!validRoles.includes(role)) {
    return makeError(envelope, `role must be one of: ${validRoles.join(', ')}`);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const conv = await client.query(
      'SELECT urn, status FROM conversations WHERE urn = $1 FOR UPDATE',
      [conversation_urn],
    );
    if (conv.rows.length === 0) {
      await client.query('ROLLBACK');
      return makeError(envelope, `Conversation not found: ${conversation_urn}`);
    }
    if (conv.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return makeError(envelope, `Cannot append to ${conv.rows[0].status} conversation`);
    }

    const seqResult = await client.query(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_urn = $1',
      [conversation_urn],
    );
    const seq = seqResult.rows[0].next_seq;

    const msgResult = await client.query(
      `INSERT INTO messages (conversation_urn, role, content, participant_urn, seq, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, conversation_urn, role, seq, created_at`,
      [conversation_urn, role, content, participant_urn || null, seq, '{}'],
    );

    await client.query(
      'UPDATE conversations SET message_count = message_count + 1, updated_at = NOW() WHERE urn = $1',
      [conversation_urn],
    );

    await client.query('COMMIT');

    const msg = msgResult.rows[0];

    // Embed after commit — soft-failure
    const embedding = await embedText(services.config.vectrUrl, content);
    if (embedding) {
      await pool.query(
        'UPDATE messages SET embedding = $1 WHERE id = $2',
        [pgvector.toSql(embedding), msg.id],
      );
    }

    return makeResponse(envelope, {
      event_type: 'append_message_result',
      id: msg.id,
      conversation_urn: msg.conversation_urn,
      role: msg.role,
      seq: msg.seq,
      embedded: embedding !== null,
      created_at: msg.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- query_conversations ---

async function handleQueryConversations(envelope, services) {
  const { query, participant_urn, limit = 10, threshold = 0.80 } = envelope.payload;

  if (!query) {
    return makeError(envelope, 'query is required');
  }

  const queryEmbedding = await embedText(services.config.vectrUrl, query);
  if (!queryEmbedding) {
    return makeError(envelope, 'Vectr unavailable — cannot embed query');
  }

  const pool = getPool();
  const embeddingSql = pgvector.toSql(queryEmbedding);
  const params = [embeddingSql, threshold, limit];
  let paramIndex = 4;

  let participantClause = '';
  if (participant_urn) {
    participantClause = `AND (c.user_urn = $${paramIndex} OR c.persona_urn = $${paramIndex})`;
    params.push(participant_urn);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT m.id, m.conversation_urn, m.content, m.role, m.seq,
            1 - (m.embedding <=> $1::vector) AS similarity,
            c.summary
     FROM messages m
     JOIN conversations c ON c.urn = m.conversation_urn
     WHERE m.embedding IS NOT NULL
       AND 1 - (m.embedding <=> $1::vector) >= $2
       ${participantClause}
     ORDER BY m.embedding <=> $1::vector
     LIMIT $3`,
    params,
  );

  return makeResponse(envelope, {
    event_type: 'query_response',
    results: result.rows.map(r => ({
      conversation_urn: r.conversation_urn,
      message_id: r.id,
      content: r.content,
      role: r.role,
      similarity: parseFloat(parseFloat(r.similarity).toFixed(4)),
      conversation_summary: r.summary,
    })),
    count: result.rows.length,
  });
}
