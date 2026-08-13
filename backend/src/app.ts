import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createRequire } from 'node:module';

import { config } from './config.js';
import {
  errorHandler,
  httpLogger,
  notFoundHandler,
} from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/router.js';
import { devAuthRouter } from './modules/auth/devRouter.js';
import { authLimiter } from './middleware/rateLimit.js';
import { usersRouter } from './modules/users/router.js';
import { tasksRouter } from './modules/tasks/router.js';
import { eventsRouter } from './modules/events/router.js';
import { agendaRouter } from './modules/agenda/router.js';
import { devicesRouter } from './modules/devices/router.js';
import { chatHistoryRouter } from './modules/chat/historyRouter.js';
import { chatRouter } from './modules/chat/router.js';
import { parseRouter } from './modules/chat/parseRouter.js';
import { speechRouter } from './modules/speech/router.js';
import { voiceRouter } from './modules/voice/router.js';
import { imageRouter } from './modules/image/router.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());

  // CORS: allow all origins (temporary — permissive for now).
  app.use(cors());

  app.use(express.json({ limit: '1mb' }));
  app.use(httpLogger);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: pkg.version });
  });

  // Dev-only sign-in shortcut; never mounted in production so it cannot
  // become an auth bypass.
  if (config.NODE_ENV !== 'production') {
    app.use('/auth', authLimiter, devAuthRouter);
  }
  app.use('/auth', authLimiter, authRouter);
  // The following routers register their full paths internally (/tasks, /events,
  // /agenda, /me), so they mount at root.
  app.use('/', usersRouter);
  app.use('/', tasksRouter);
  app.use('/', eventsRouter);
  app.use('/', agendaRouter);
  app.use('/', devicesRouter);
  app.use('/', chatHistoryRouter);
  app.use('/', chatRouter);
  // Stateless language parsing for the local-first client; no auth, since it
  // reads and writes nothing.
  app.use('/', parseRouter);
  app.use('/', speechRouter);
  // Voice assistant: stateless like /parse — the device keeps the data, the
  // server keeps the keys.
  app.use('/', voiceRouter);
  // Also stateless: the device keeps the picture, the server keeps the key.
  app.use('/', imageRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
