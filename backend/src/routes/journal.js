import { Router } from 'express';
import { store } from '../store.js';

const router = Router();

// GET /api/journal — all journal entries
router.get('/', (_req, res) => {
  res.json(store.list('journal'));
});

// POST /api/journal — create an entry
router.post('/', (req, res) => {
  const { title, body, mood } = req.body ?? {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const entry = store.create('journal', {
    title: String(title).trim(),
    body: body ? String(body) : '',
    mood: mood || 'neutral',
  });
  res.status(201).json(entry);
});

// DELETE /api/journal/:id
router.delete('/:id', (req, res) => {
  const ok = store.remove('journal', req.params.id);
  if (!ok) return res.status(404).json({ error: 'entry not found' });
  res.status(204).end();
});

export default router;
