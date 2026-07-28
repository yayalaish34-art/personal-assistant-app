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
import { speechRouter } from './modules/speech/router.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());

  // CORS: in production require CORS_ORIGINS (comma-separated allowlist). In
  // dev, an empty list permits any origin so the RN client on localhost/LAN
  // works out of the box.
  if (config.CORS_ORIGINS.length > 0) {
    app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));
  } else if (config.NODE_ENV === 'production') {
    throw new Error('CORS_ORIGINS must be set in production');
  } else {
    app.use(cors());
  }

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
  app.use('/', speechRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
