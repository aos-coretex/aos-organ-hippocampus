import { createConversationRoutes } from './conversations.js';
import { createQueryRoutes } from './query.js';
import { createBackfillRoutes } from './backfill.js';

export function mountRoutes(app, config) {
  createConversationRoutes(app, config);
  createQueryRoutes(app, config);
  createBackfillRoutes(app, config);
}
