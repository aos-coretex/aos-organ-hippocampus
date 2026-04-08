import { createConversationRoutes } from './conversations.js';
import { createQueryRoutes } from './query.js';

export function mountRoutes(app, config) {
  createConversationRoutes(app, config);
  createQueryRoutes(app, config);
}
