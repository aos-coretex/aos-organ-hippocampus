/**
 * Backfill route — fill embedding gaps after Vectr downtime.
 * Processes messages and summaries in batches of 50.
 */
import { getPool } from '../db/pool.js';
import { embedBatch, embedText } from '../../lib/vectr-client.js';
import pgvector from 'pgvector/pg';

const BATCH_SIZE = 50;

export function createBackfillRoutes(app, config) {

  // POST /backfill/embeddings — Backfill message + summary embedding gaps
  app.post('/backfill/embeddings', async (req, res) => {
    const limit = parseInt(req.body?.limit || '100', 10);
    const conversationUrn = req.body?.conversation_urn || null;

    const pool = getPool();

    try {
      // 1. Backfill message embeddings
      let msgCondition = 'embedding IS NULL';
      const msgParams = [];
      let paramIdx = 1;

      if (conversationUrn) {
        msgCondition += ` AND conversation_urn = $${paramIdx}`;
        msgParams.push(conversationUrn);
        paramIdx++;
      }
      msgParams.push(limit);

      const unembeddedMsgs = await pool.query(
        `SELECT id, content, conversation_urn, seq
         FROM messages
         WHERE ${msgCondition}
         ORDER BY created_at ASC
         LIMIT $${paramIdx}`,
        msgParams,
      );

      let messagesBackfilled = 0;

      // Process in batches of BATCH_SIZE
      for (let offset = 0; offset < unembeddedMsgs.rows.length; offset += BATCH_SIZE) {
        const batch = unembeddedMsgs.rows.slice(offset, offset + BATCH_SIZE);
        const texts = batch.map(r => r.content);
        const embeddings = await embedBatch(config.vectrUrl, texts);

        const updates = [];
        for (let i = 0; i < embeddings.length; i++) {
          if (embeddings[i]) {
            updates.push(
              pool.query(
                'UPDATE messages SET embedding = $1 WHERE id = $2',
                [pgvector.toSql(embeddings[i]), batch[i].id],
              ),
            );
            messagesBackfilled++;
          }
        }
        await Promise.all(updates);
      }

      // 2. Backfill summary embeddings
      const unembeddedSummaries = await pool.query(
        `SELECT urn, summary FROM conversations
         WHERE summary IS NOT NULL AND summary_embedding IS NULL
         ORDER BY updated_at ASC
         LIMIT $1`,
        [limit],
      );

      let summariesBackfilled = 0;

      for (const row of unembeddedSummaries.rows) {
        const embedding = await embedText(config.vectrUrl, row.summary);
        if (embedding) {
          await pool.query(
            'UPDATE conversations SET summary_embedding = $1 WHERE urn = $2',
            [pgvector.toSql(embedding), row.urn],
          );
          summariesBackfilled++;
        }
      }

      // 3. Count remaining gaps
      const remaining = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM messages WHERE embedding IS NULL) AS messages_remaining,
           (SELECT COUNT(*) FROM conversations WHERE summary IS NOT NULL AND summary_embedding IS NULL) AS summaries_remaining`,
      );
      const r = remaining.rows[0];

      res.json({
        messages_backfilled: messagesBackfilled,
        summaries_backfilled: summariesBackfilled,
        remaining: {
          messages: parseInt(r.messages_remaining, 10),
          summaries: parseInt(r.summaries_remaining, 10),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
