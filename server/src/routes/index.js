import { Router } from 'express';
import { requireAuth } from '../auth.js';

import authRoutes from './auth.routes.js';
import sessionRoutes from './sessions.routes.js';
import chatRoutes from './chats.routes.js';
import messageRoutes from './messages.routes.js';
import ruleRoutes from './rules.routes.js';
import outboxRoutes from './outbox.routes.js';
import webhookRoutes from './webhooks.routes.js';
import templateRoutes from './templates.routes.js';
import bulkRoutes from './bulk.routes.js';
import scheduleRoutes from './schedules.routes.js';
import botRoutes from './bots.routes.js';
import v1Routes from './v1.routes.js';
import cloudRoutes from './cloud.routes.js';

const api = Router();

api.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Login is the only surface without a user token.
api.use('/auth', authRoutes);

// Meta's webhook. It cannot log in, so it is mounted before the JWT guard and
// authenticated by its verify token plus the phone number id it delivers for.
api.use('/cloud', cloudRoutes);

// The machine-facing API for the clinic CMS. It authenticates with an API key
// instead of a user login, so it is mounted before the JWT guard below.
api.use('/v1', v1Routes);

// Everything past this line requires a valid Bearer token.
api.use(requireAuth);
api.use('/sessions', sessionRoutes);
api.use('/chats', chatRoutes);
api.use('/messages', messageRoutes);
api.use('/rules', ruleRoutes);
api.use('/outbox', outboxRoutes);
api.use('/webhooks', webhookRoutes);
api.use('/templates', templateRoutes);
api.use('/bulk', bulkRoutes);
api.use('/schedules', scheduleRoutes);
api.use('/bots', botRoutes);

export default api;
