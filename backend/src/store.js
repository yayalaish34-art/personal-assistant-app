// Tiny in-memory data store with optional JSON-file persistence.
// Good enough for a running skeleton; swap for a real DB later.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'db.json');

const seed = {
  journal: [
    {
      id: 'seed-1',
      title: 'ברוך הבא ליומן',
      body: 'זו רשומת דוגמה. אפשר למחוק אותה וליצור רשומות משלך.',
      mood: 'good',
      createdAt: new Date().toISOString(),
    },
  ],
  events: [
    {
      id: 'evt-1',
      title: 'פגישת דוגמה',
      date: new Date().toISOString().slice(0, 10),
      time: '10:00',
      notes: 'אירוע לדוגמה ביומן',
    },
  ],
};

function load() {
  try {
    if (existsSync(DATA_FILE)) {
      return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Could not read db.json, starting from seed:', e.message);
  }
  return structuredClone(seed);
}

let db = load();

function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Could not persist db.json:', e.message);
  }
}

function id() {
  return `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

export const store = {
  list(collection) {
    return db[collection] ?? [];
  },
  create(collection, item) {
    const record = { id: id(), createdAt: new Date().toISOString(), ...item };
    db[collection] = [record, ...(db[collection] ?? [])];
    persist();
    return record;
  },
  remove(collection, recordId) {
    const before = (db[collection] ?? []).length;
    db[collection] = (db[collection] ?? []).filter((r) => r.id !== recordId);
    persist();
    return (db[collection] ?? []).length < before;
  },
};
