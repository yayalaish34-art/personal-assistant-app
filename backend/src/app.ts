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

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());

  // CORS origins will be tightened in T6.3 (security review). For Phase 0 dev,
  // allow any origin so the RN client on localhost/LAN works out of the box.
  app.use(cors());

  app.use(express.json({ limit: '1mb' }));
  app.use(httpLogger);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: pkg.version });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
