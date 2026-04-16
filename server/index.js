import { createOrgan } from '@coretex/organ-boot';
import { createLoader } from '@coretex/organ-boot/llm-settings-loader';
import { initializeUsageAttribution } from '@coretex/organ-boot/usage-attribution';
import config from './config.js';
import { initPool, closePool } from './db/pool.js';
import { verifySchema } from './db/schema.js';
import { mountRoutes } from './routes/index.js';
import { isVectrAvailable } from '../lib/vectr-client.js';
import { setLLMClient as setSummarizerLLM } from '../lib/summarizer.js';
import { handleDirectedMessage } from './handlers/spine-commands.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// Initialize database before organ boot
const dbStats = await initPool();
await verifySchema();

// --- LLM settings loader (MP-CONFIG-1 R6 migration — l9m-6) ---

const llmLoader = createLoader({
  organNumber: 80,
  organName: 'hippocampus',
  settingsRoot: config.settingsRoot,
});

// MP-CONFIG-1 R9 — register the process-default usage writer.
initializeUsageAttribution({ organName: 'Hippocampus' });

function buildLlmClient(agentName) {
  const { config: resolved, chat } = llmLoader.resolveWithCascade(agentName);
  const apiKeyEnv = resolved.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
  return {
    chat,
    isAvailable: () => Boolean(process.env[apiKeyEnv]),
    getUsage: () => ({ agent: resolved.agentName, model: resolved.defaultModel, provider: resolved.defaultProvider }),
  };
}

setSummarizerLLM(buildLlmClient('session-summarizer'));

// Spine reference — set during onStartup, passed to route handlers for broadcast production
let spineRef = null;

const services = { config };

const organ = await createOrgan({
  name: config.name,
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  dependencies: ['Spine', 'Vectr', 'Graph', 'Phi'],

  routes: (app) => mountRoutes(app, config, () => spineRef),

  // Directed OTM handlers — create_conversation, append_message, query_conversations
  onMessage: async (envelope) => handleDirectedMessage(envelope, services),

  // Broadcast handlers — session lifecycle events from Phi
  onBroadcast: async (envelope) => {
    const { payload } = envelope;

    switch (payload?.event_type) {
      case 'session_start':
        log('session_start_received', {
          session_id: payload.session_id,
          user_urn: payload.user_urn,
        });
        break;

      case 'session_end':
        log('session_end_received', {
          session_id: payload.session_id,
          user_urn: payload.user_urn,
        });
        break;

      default:
        // Unknown broadcast — ignore silently
        break;
    }
  },

  // Subscribe to Phi session lifecycle events
  subscriptions: [
    { event_type: 'session_start', source: 'Phi' },
    { event_type: 'session_end', source: 'Phi' },
  ],

  onStartup: async ({ spine }) => {
    spineRef = spine;
  },

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

  introspectCheck: async () => {
    const vectrStatus = await isVectrAvailable(config.vectrUrl);
    return {
      connected_producers: {
        Phi: 'subscribed',
        Vectr: vectrStatus ? 'available' : 'unavailable',
      },
      connected_consumers: ['Thalamus', 'Phi', 'Axon', 'Soul'],
      db_stats: dbStats,
      // MP-CONFIG-1 R6 — flat per bug #9; consumed by Axon aggregator R8.
      llm: llmLoader.introspect(),
    };
  },

  onShutdown: async () => {
    await closePool();
  },
});
