import { createConversationRoutes } from './conversations.js';
import { createQueryRoutes } from './query.js';
import { createBackfillRoutes } from './backfill.js';

/**
 * @param {object} app - Express app
 * @param {object} config - Organ config
 * @param {function} [getSpine] - Returns spine client ref (null before onStartup)
 */
export function mountRoutes(app, config, getSpine) {
  createConversationRoutes(app, config, getSpine);
  createQueryRoutes(app, config);
  createBackfillRoutes(app, config);
}
