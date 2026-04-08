/**
 * Query route handlers — semantic search across conversation history.
 * Endpoints from hippocampus-organ-definition.md Section 3.
 */
import { getPool } from '../db/pool.js';

export function createQueryRoutes(app, config) {

  // POST /query — Semantic search across messages
  app.post('/query', async (req, res) => {
    const { query, participant_urn, limit = 10, threshold = 0.80, scope = 'user' } = req.body;

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
    const vectrUrl = config.vectrUrl;
    let embedding;
    try {
      const vectrRes = await fetch(`${vectrUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: query }),
      });

      if (!vectrRes.ok) {
        throw new Error(`Vectr returned ${vectrRes.status}`);
      }

      const vectrData = await vectrRes.json();
      embedding = vectrData.embedding;
    } catch (_err) {
      return res.status(503).json({
        error: 'Vectr unavailable — semantic search requires embedding service',
      });
    }

    const pool = getPool();
    try {
      // Build parameterized query
      const params = [JSON.stringify(embedding), threshold];
      let participantFilter = '';
      if (participant_urn) {
        participantFilter = `AND (c.user_urn = $3 OR c.persona_urn = $3)`;
        params.push(participant_urn);
      }
      params.push(limit);
      const limitParam = `$${params.length}`;

      const result = await pool.query(
        `SELECT m.id, m.conversation_urn, m.content, m.role, m.seq,
                1 - (m.embedding <=> $1::vector) AS similarity,
                c.summary
         FROM messages m
         JOIN conversations c ON c.urn = m.conversation_urn
         WHERE m.embedding IS NOT NULL
           AND 1 - (m.embedding <=> $1::vector) >= $2
           ${participantFilter}
         ORDER BY m.embedding <=> $1::vector
         LIMIT ${limitParam}`,
        params,
      );

      res.json({
        results: result.rows.map(row => ({
          conversation_urn: row.conversation_urn,
          message_id: row.id,
          content: row.content,
          role: row.role,
          similarity: parseFloat(row.similarity),
          conversation_summary: row.summary,
        })),
        count: result.rows.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
