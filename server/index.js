import { createOrgan } from '@coretex/organ-boot';
import config from './config.js';
import { initPool, closePool } from './db/pool.js';
import { verifySchema } from './db/schema.js';
import { mountRoutes } from './routes/index.js';

// Initialize database before organ boot
const dbStats = await initPool();
await verifySchema();

const organ = await createOrgan({
  name: config.name,
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  dependencies: ['Spine'],  // Minimal for Relay 2; Relay 5 adds Vectr, Graph, Phi

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
          (SELECT COUNT(*) FROM messages) AS total_messages
      `);
      return result.rows[0];
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
