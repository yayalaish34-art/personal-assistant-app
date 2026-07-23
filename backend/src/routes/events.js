import { Router } from 'express';
import { store } from '../store.js';

const router = Router();

// GET /api/events — all calendar events (optionally filtered by ?date=YYYY-MM-DD)
router.get('/', (req, res) => {
  const { date } = req.query;
  let events = store.list('events');
  if (date) events = events.filter((e) => e.date === date);
  res.json(events);
});

// POST /api/events — create an event
router.post('/', (req, res) => {
  const { title, date, time, notes } = req.body ?? {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!date) {
    return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
  }
  const event = store.create('events', {
    title: String(title).trim(),
    date: String(date),
    time: time ? String(time) : '',
    notes: notes ? String(notes) : '',
  });
  res.status(201).json(event);
});

// DELETE /api/events/:id
router.delete('/:id', (req, res) => {
  const ok = store.remove('events', req.params.id);
  if (!ok) return res.status(404).json({ error: 'event not found' });
  res.status(204).end();
});

export default router;
