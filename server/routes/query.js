/**
 * Query route handlers — semantic search across conversation history.
 * Endpoints from hippocampus-organ-definition.md Section 3.
 *
 * Two search levels:
 *   - "messages" (default): cosine similarity across message embeddings
 *   - "conversations": cosine similarity across conversation summary embeddings
 */
import { getPool } from '../db/pool.js';
import { embedText } from '../../lib/vectr-client.js';
import pgvector from 'pgvector/pg';

export function createQueryRoutes(app, config) {

  // POST /query — Semantic search across messages or conversations
  app.post('/query', async (req, res) => {
    const {
      query,
      participant_urn,
      limit = 10,
      threshold = 0.80,
      scope = 'user',
      search_level = 'messages',
    } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'query is required and must be a non-empty string' });
    }

    // User scoping — binding decision from organ definition
    if (scope !== 'all' && !participant_urn) {
      return res.status(400).json({
        error: "participant_urn required for user-scoped queries. Use scope: 'all' for system-level queries.",
      });
    }

    // Embed query text via Vectr
    const queryEmbedding = await embedText(config.vectrUrl, query);
    if (!queryEmbedding) {
      return res.status(503).json({
        error: 'Vectr unavailable — semantic search requires embedding service',
      });
    }

    const pool = getPool();
    const embeddingSql = pgvector.toSql(queryEmbedding);

    try {
      if (search_level === 'conversations') {
        return await handleConversationSearch(pool, res, {
          embeddingSql, participant_urn, threshold, limit,
        });
      }

      // Default: message-level search
      return await handleMessageSearch(pool, res, {
        embeddingSql, participant_urn, threshold, limit,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

async function handleMessageSearch(pool, res, { embeddingSql, participant_urn, threshold, limit }) {
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
            c.summary, c.user_urn, c.status
     FROM messages m
     JOIN conversations c ON c.urn = m.conversation_urn
     WHERE m.embedding IS NOT NULL
       AND 1 - (m.embedding <=> $1::vector) >= $2
       ${participantClause}
     ORDER BY m.embedding <=> $1::vector
     LIMIT $3`,
    params,
  );

  res.json({
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

async function handleConversationSearch(pool, res, { embeddingSql, participant_urn, threshold, limit }) {
  const params = [embeddingSql, threshold, limit];
  let paramIndex = 4;

  let participantClause = '';
  if (participant_urn) {
    participantClause = `AND (c.user_urn = $${paramIndex} OR c.persona_urn = $${paramIndex})`;
    params.push(participant_urn);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT c.urn, c.summary, c.user_urn, c.message_count, c.completed_at,
            1 - (c.summary_embedding <=> $1::vector) AS similarity
     FROM conversations c
     WHERE c.summary_embedding IS NOT NULL
       AND c.status IN ('completed', 'archived')
       AND 1 - (c.summary_embedding <=> $1::vector) >= $2
       ${participantClause}
     ORDER BY c.summary_embedding <=> $1::vector
     LIMIT $3`,
    params,
  );

  res.json({
    results: result.rows.map(r => ({
      conversation_urn: r.urn,
      summary: r.summary,
      message_count: r.message_count,
      completed_at: r.completed_at,
      similarity: parseFloat(parseFloat(r.similarity).toFixed(4)),
    })),
    count: result.rows.length,
  });
}
