import { createOrgan } from '@coretex/organ-boot';
import config from './config.js';
import { initPool, closePool } from './db/pool.js';
import { verifySchema } from './db/schema.js';
import { mountRoutes } from './routes/index.js';
import { isVectrAvailable } from '../lib/vectr-client.js';

// Initialize database before organ boot
const dbStats = await initPool();
await verifySchema();

const organ = await createOrgan({
  name: config.name,
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  dependencies: ['Spine'],  // Relay 5 adds full dependency checks

  routes: (app) => mountRoutes(app, config),

  onMessage: async (_envelope) => {
    // Stub — Relay 5 implements directed message handlers
    return null;
  },

  subscriptions: [],  // Stub — Relay 5 adds broadcast subscriptions

  healthCheck: async () => {
    const { getPool } = await import('./db/pool.js');
    const pool = getPool();
    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM conversations WHERE status = 'active') AS active,
          (SELECT COUNT(*) FROM conversations WHERE status = 'completed') AS completed,
          (SELECT COUNT(*) FROM messages) AS total_messages,
          (SELECT COUNT(*) FROM messages WHERE embedding IS NOT NULL) AS embedded_messages,
          (SELECT COUNT(*) FROM conversations WHERE summary IS NOT NULL) AS summarized,
          (SELECT COUNT(*) FROM conversations WHERE summary_embedding IS NOT NULL) AS summary_embedded
      `);
      const r = result.rows[0];
      const totalMessages = parseInt(r.total_messages, 10);
      const embeddedMessages = parseInt(r.embedded_messages, 10);
      const completed = parseInt(r.completed, 10);
      const summarized = parseInt(r.summarized, 10);

      const embeddingCoverage = totalMessages > 0
        ? Math.round((embeddedMessages / totalMessages) * 100)
        : 100;
      const summaryCoverage = completed > 0
        ? Math.round((summarized / completed) * 100)
        : 100;

      return {
        ...r,
        embedding_coverage_pct: embeddingCoverage,
        summary_coverage_pct: summaryCoverage,
        vectr_available: await isVectrAvailable(config.vectrUrl),
      };
    } catch {
      return { db: 'unreachable' };
    }
  },

  introspectCheck: async () => ({
    db_stats: dbStats,
    connected_producers: ['Phi', 'Vectr'],
    connected_consumers: ['Thalamus', 'Phi', 'Axon', 'Soul'],
  }),

  onShutdown: async () => {
    await closePool();
  },
});
