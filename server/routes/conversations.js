/**
 * Conversation route handlers — CRUD, lifecycle, summarization.
 * Endpoints from hippocampus-organ-definition.md Section 3.
 */
import { getPool } from '../db/pool.js';
import { summarizeConversation, isSummarizerAvailable } from '../../lib/summarizer.js';
import { embedText, embedBatch } from '../../lib/vectr-client.js';
import pgvector from 'pgvector/pg';

export function createConversationRoutes(app, config) {

  // POST /conversations — Create a new conversation
  app.post('/conversations', async (req, res) => {
    const { urn, participants, metadata } = req.body;

    if (!urn || !participants) {
      return res.status(400).json({ error: 'urn and participants are required' });
    }

    const pool = getPool();
    try {
      // Check for duplicate URN
      const existing = await pool.query(
        'SELECT urn FROM conversations WHERE urn = $1',
        [urn],
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Conversation URN already exists', urn });
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
          JSON.stringify(metadata || {}),
        ],
      );

      const row = result.rows[0];
      res.status(201).json({
        urn: row.urn,
        status: row.status,
        participants: {
          user_urn: row.user_urn,
          persona_urn: row.persona_urn,
          agent_session: row.agent_session,
        },
        created_at: row.created_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /conversations/:urn/messages — Append a message
  app.post('/conversations/:urn/messages', async (req, res) => {
    const { urn } = req.params;
    const { role, content, participant_urn, metadata } = req.body;

    if (!role || !content) {
      return res.status(400).json({ error: 'role and content are required' });
    }

    const validRoles = ['user', 'assistant', 'system'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the conversation row and verify it exists + is active
      const conv = await client.query(
        'SELECT urn, status FROM conversations WHERE urn = $1 FOR UPDATE',
        [urn],
      );
      if (conv.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Conversation not found', urn });
      }
      if (conv.rows[0].status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot append to ${conv.rows[0].status} conversation`,
          urn,
          status: conv.rows[0].status,
        });
      }

      // Get next sequence number
      const seqResult = await client.query(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_urn = $1',
        [urn],
      );
      const seq = seqResult.rows[0].next_seq;

      // Insert message without embedding first (insert-first-embed-second)
      const msgResult = await client.query(
        `INSERT INTO messages (conversation_urn, role, content, participant_urn, seq, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, conversation_urn, role, seq, created_at`,
        [urn, role, content, participant_urn || null, seq, JSON.stringify(metadata || {})],
      );

      // Update conversation counters
      await client.query(
        'UPDATE conversations SET message_count = message_count + 1, updated_at = NOW() WHERE urn = $1',
        [urn],
      );

      await client.query('COMMIT');

      const msg = msgResult.rows[0];

      // Embed after commit — soft-failure, never loses the message
      const embedding = await embedText(config.vectrUrl, content);
      if (embedding) {
        await pool.query(
          'UPDATE messages SET embedding = $1 WHERE id = $2',
          [pgvector.toSql(embedding), msg.id],
        );
      }

      res.status(201).json({
        id: msg.id,
        conversation_urn: msg.conversation_urn,
        role: msg.role,
        seq: msg.seq,
        embedded: embedding !== null,
        created_at: msg.created_at,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // POST /conversations/:urn/messages/batch — Batch append messages
  app.post('/conversations/:urn/messages/batch', async (req, res) => {
    const { urn } = req.params;
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    const validRoles = ['user', 'assistant', 'system'];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.role || !msg.content) {
        return res.status(400).json({ error: `Message at index ${i} missing role or content` });
      }
      if (!validRoles.includes(msg.role)) {
        return res.status(400).json({ error: `Message at index ${i}: role must be one of: ${validRoles.join(', ')}` });
      }
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the conversation row and verify it exists + is active
      const conv = await client.query(
        'SELECT urn, status FROM conversations WHERE urn = $1 FOR UPDATE',
        [urn],
      );
      if (conv.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Conversation not found', urn });
      }
      if (conv.rows[0].status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot append to ${conv.rows[0].status} conversation`,
          urn,
          status: conv.rows[0].status,
        });
      }

      // Get starting sequence number
      const seqResult = await client.query(
        'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_urn = $1',
        [urn],
      );
      const startSeq = seqResult.rows[0].max_seq + 1;

      // Build bulk INSERT values
      const valueClauses = [];
      const params = [];
      let paramIdx = 1;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const seq = startSeq + i;
        valueClauses.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`);
        params.push(urn, msg.role, msg.content, msg.participant_urn || null, seq, JSON.stringify(msg.metadata || {}));
        paramIdx += 6;
      }

      await client.query(
        `INSERT INTO messages (conversation_urn, role, content, participant_urn, seq, metadata)
         VALUES ${valueClauses.join(', ')}`,
        params,
      );

      // Update conversation counters
      await client.query(
        'UPDATE conversations SET message_count = message_count + $1, updated_at = NOW() WHERE urn = $2',
        [messages.length, urn],
      );

      await client.query('COMMIT');

      // Embed all messages in single batch call after commit — soft-failure
      const texts = messages.map(m => m.content);
      const embeddings = await embedBatch(config.vectrUrl, texts);

      const updatePromises = [];
      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i]) {
          updatePromises.push(
            pool.query(
              'UPDATE messages SET embedding = $1 WHERE conversation_urn = $2 AND seq = $3',
              [pgvector.toSql(embeddings[i]), urn, startSeq + i],
            ),
          );
        }
      }
      await Promise.all(updatePromises);

      const embeddedCount = embeddings.filter(e => e !== null).length;
      const endSeq = startSeq + messages.length - 1;
      res.status(201).json({
        conversation_urn: urn,
        messages_stored: messages.length,
        seq_range: { from: startSeq, to: endSeq },
        embedded_count: embeddedCount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // GET /conversations/:urn — Retrieve a conversation
  app.get('/conversations/:urn', async (req, res) => {
    const { urn } = req.params;
    const includeMessages = req.query.include_messages !== 'false';
    const limit = parseInt(req.query.limit || '100', 10);
    const offset = parseInt(req.query.offset || '0', 10);

    const pool = getPool();
    try {
      const conv = await pool.query(
        `SELECT urn, status, user_urn, persona_urn, agent_session,
                summary, message_count, metadata, created_at, updated_at,
                completed_at, archived_at
         FROM conversations WHERE urn = $1`,
        [urn],
      );
      if (conv.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found', urn });
      }

      const row = conv.rows[0];
      const result = {
        urn: row.urn,
        status: row.status,
        participants: {
          user_urn: row.user_urn,
          persona_urn: row.persona_urn,
          agent_session: row.agent_session,
        },
        summary: row.summary,
        message_count: row.message_count,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
        archived_at: row.archived_at,
      };

      if (includeMessages) {
        const msgs = await pool.query(
          `SELECT id, role, content, participant_urn, seq, metadata, created_at
           FROM messages WHERE conversation_urn = $1
           ORDER BY seq ASC LIMIT $2 OFFSET $3`,
          [urn, limit, offset],
        );
        result.messages = msgs.rows;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /conversations — List conversations
  app.get('/conversations', async (req, res) => {
    const { participant_urn, status, since } = req.query;
    const limit = parseInt(req.query.limit || '20', 10);

    const pool = getPool();
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (participant_urn) {
      conditions.push(`(user_urn = $${paramIndex} OR persona_urn = $${paramIndex})`);
      params.push(participant_urn);
      paramIndex++;
    }

    if (status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (since) {
      conditions.push(`updated_at >= $${paramIndex}`);
      params.push(since);
      paramIndex++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);

    try {
      const result = await pool.query(
        `SELECT urn, status, user_urn, persona_urn, agent_session,
                summary, message_count, metadata, created_at, updated_at,
                completed_at, archived_at
         FROM conversations ${where}
         ORDER BY updated_at DESC
         LIMIT $${paramIndex}`,
        params,
      );

      res.json({
        conversations: result.rows.map(row => ({
          urn: row.urn,
          status: row.status,
          participants: {
            user_urn: row.user_urn,
            persona_urn: row.persona_urn,
            agent_session: row.agent_session,
          },
          summary: row.summary,
          message_count: row.message_count,
          metadata: row.metadata,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
        count: result.rows.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /conversations/:urn/complete — Complete a conversation
  app.post('/conversations/:urn/complete', async (req, res) => {
    const { urn } = req.params;

    const pool = getPool();
    try {
      const conv = await pool.query(
        'SELECT urn, status, summary FROM conversations WHERE urn = $1',
        [urn],
      );
      if (conv.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found', urn });
      }
      if (conv.rows[0].status !== 'active') {
        return res.status(400).json({
          error: `Cannot complete a ${conv.rows[0].status} conversation`,
          urn,
          status: conv.rows[0].status,
        });
      }

      const result = await pool.query(
        `UPDATE conversations
         SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE urn = $1
         RETURNING urn, status, summary, completed_at`,
        [urn],
      );

      const row = result.rows[0];

      // Trigger async summarization if no summary exists
      if (!row.summary && isSummarizerAvailable()) {
        triggerAsyncSummarization(pool, urn, config);
      }

      res.json({
        urn: row.urn,
        status: row.status,
        summary: row.summary,
        completed_at: row.completed_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /conversations/:urn/archive — Archive a conversation
  app.post('/conversations/:urn/archive', async (req, res) => {
    const { urn } = req.params;

    const pool = getPool();
    try {
      const conv = await pool.query(
        'SELECT urn, status FROM conversations WHERE urn = $1',
        [urn],
      );
      if (conv.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found', urn });
      }
      if (conv.rows[0].status !== 'completed') {
        return res.status(400).json({
          error: `Cannot archive a ${conv.rows[0].status} conversation — must be completed first`,
          urn,
          status: conv.rows[0].status,
        });
      }

      const result = await pool.query(
        `UPDATE conversations
         SET status = 'archived', archived_at = NOW(), updated_at = NOW()
         WHERE urn = $1
         RETURNING urn, status, archived_at`,
        [urn],
      );

      const row = result.rows[0];
      res.json({
        urn: row.urn,
        status: row.status,
        archived_at: row.archived_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /conversations/:urn/summarize — Generate/regenerate summary
  app.post('/conversations/:urn/summarize', async (req, res) => {
    const { urn } = req.params;
    const force = req.body.force === true;

    const pool = getPool();
    try {
      const conv = await pool.query(
        'SELECT urn, summary FROM conversations WHERE urn = $1',
        [urn],
      );
      if (conv.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found', urn });
      }

      // Return existing summary if not forcing regeneration
      if (conv.rows[0].summary && !force) {
        return res.json({
          urn,
          summary: conv.rows[0].summary,
          token_count: 0,
          generated_at: null,
          cached: true,
        });
      }

      // Fetch all messages
      const msgs = await pool.query(
        'SELECT role, content, seq FROM messages WHERE conversation_urn = $1 ORDER BY seq ASC',
        [urn],
      );
      if (msgs.rows.length === 0) {
        return res.status(400).json({ error: 'Cannot summarize a conversation with no messages', urn });
      }

      // Call summarization agent
      const { summary, token_count } = await summarizeConversation(msgs.rows);
      const generatedAt = new Date().toISOString();

      // Embed the summary — soft-failure
      const summaryEmbedding = await embedText(config.vectrUrl, summary);
      await pool.query(
        'UPDATE conversations SET summary = $1, summary_embedding = $2, updated_at = NOW() WHERE urn = $3',
        [summary, summaryEmbedding ? pgvector.toSql(summaryEmbedding) : null, urn],
      );

      res.json({ urn, summary, token_count, generated_at: generatedAt, summary_embedded: summaryEmbedding !== null });
    } catch (err) {
      // SUMMARY_GENERATION_FAILED — graceful degradation
      if (err.code === 'LLM_UNAVAILABLE' || err.code === 'LLM_CALL_FAILED') {
        return res.status(503).json({
          error: 'Summarization unavailable',
          detail: err.message,
          urn,
        });
      }
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * Fire-and-forget summarization for conversation completion.
 * Errors are logged but do not affect the completion response.
 * Embeds the summary via Vectr (soft-failure).
 */
function triggerAsyncSummarization(pool, urn, config) {
  (async () => {
    try {
      const msgs = await pool.query(
        'SELECT role, content, seq FROM messages WHERE conversation_urn = $1 ORDER BY seq ASC',
        [urn],
      );
      if (msgs.rows.length === 0) return;

      const { summary } = await summarizeConversation(msgs.rows);

      // Embed the summary — soft-failure
      const summaryEmbedding = await embedText(config.vectrUrl, summary);
      await pool.query(
        'UPDATE conversations SET summary = $1, summary_embedding = $2, updated_at = NOW() WHERE urn = $3',
        [summary, summaryEmbedding ? pgvector.toSql(summaryEmbedding) : null, urn],
      );

      process.stdout.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'async_summarization_complete',
        urn,
        summary_embedded: summaryEmbedding !== null,
      }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'async_summarization_failed',
        urn,
        error: err.message,
      }) + '\n');
    }
  })();
}
