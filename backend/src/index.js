import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import journalRouter from './routes/journal.js';
import eventsRouter from './routes/events.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'personal-assistant-backend', time: new Date().toISOString() });
});

app.use('/api/journal', journalRouter);
app.use('/api/events', eventsRouter);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
});
