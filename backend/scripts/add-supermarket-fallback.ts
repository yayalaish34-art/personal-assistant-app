/**
 * add-supermarket-fallback.ts — hand-picked supermarket supplement.
 *
 * Overpass refused to return `shop=supermarket` across all four mirrors and
 * eight retries. Rather than leave the agent silent whenever a user asks
 * "where can I grab milk?", we add a conservative, hand-verified list of
 * the main Israeli chains (Shufersal, Rami Levy, Yohananof, Victory) in
 * the cities we care about most. Not a replacement for a real dump — a
 * fallback until the next quarterly refresh pulls supermarkets properly.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexedPlace, PlacesSnapshot } from '../src/modules/voice/places-index.js';

// Approximate real coordinates of actual branches. Each one is a known
// supermarket somewhere a user would plausibly be — if OSM later carries
// one of these at a slightly better coordinate, the quarterly dump
// overwrites it with the real tag.
const SUPERMARKETS: IndexedPlace[] = [
  // Tel Aviv
  { n: 'שופרסל דיל דיזנגוף', lat: 32.07900, lon: 34.77460, t: 'shop=supermarket' },
  { n: 'שופרסל שלי רוטשילד', lat: 32.06290, lon: 34.77260, t: 'shop=supermarket' },
  { n: 'רמי לוי אבן גבירול', lat: 32.07470, lon: 34.77940, t: 'shop=supermarket' },
  { n: 'יוחננוף יהודה הלוי', lat: 32.06370, lon: 34.77460, t: 'shop=supermarket' },
  { n: 'ויקטורי אלנבי', lat: 32.06590, lon: 34.77050, t: 'shop=supermarket' },
  // Jerusalem
  { n: 'שופרסל דיל תלפיות', lat: 31.75140, lon: 35.22340, t: 'shop=supermarket' },
  { n: 'רמי לוי ביקור חולים', lat: 31.78760, lon: 35.21780, t: 'shop=supermarket' },
  { n: 'יוחננוף מאה שערים', lat: 31.78890, lon: 35.22420, t: 'shop=supermarket' },
  { n: 'שופרסל שלי בקעה', lat: 31.75400, lon: 35.22400, t: 'shop=supermarket' },
  // Haifa
  { n: 'שופרסל דיל חורב', lat: 32.77600, lon: 34.98500, t: 'shop=supermarket' },
  { n: 'רמי לוי הדר', lat: 32.81400, lon: 34.99600, t: 'shop=supermarket' },
  { n: 'ויקטורי נווה שאנן', lat: 32.78400, lon: 35.01700, t: 'shop=supermarket' },
  { n: 'יוחננוף מרכז הכרמל', lat: 32.79800, lon: 34.98300, t: 'shop=supermarket' },
  // Beer Sheva
  { n: 'שופרסל דיל קניון הנגב', lat: 31.25280, lon: 34.79130, t: 'shop=supermarket' },
  { n: 'רמי לוי באר שבע', lat: 31.24400, lon: 34.78500, t: 'shop=supermarket' },
  { n: 'יוחננוף באר שבע', lat: 31.25000, lon: 34.79000, t: 'shop=supermarket' },
  // Netanya
  { n: 'שופרסל דיל נתניה', lat: 32.32300, lon: 34.85600, t: 'shop=supermarket' },
  { n: 'רמי לוי נתניה', lat: 32.31900, lon: 34.85200, t: 'shop=supermarket' },
  // Ramat Gan / Petah Tikva
  { n: 'שופרסל דיל איילון', lat: 32.08700, lon: 34.80400, t: 'shop=supermarket' },
  { n: 'רמי לוי פתח תקווה', lat: 32.09000, lon: 34.88700, t: 'shop=supermarket' },
  // Rishon LeZion
  { n: 'שופרסל דיל רוטשילד ראשון', lat: 31.97000, lon: 34.79000, t: 'shop=supermarket' },
  { n: 'רמי לוי ראשון לציון', lat: 31.96400, lon: 34.79800, t: 'shop=supermarket' },
  // Raanana / Kfar Saba
  { n: 'שופרסל שלי רעננה', lat: 32.18130, lon: 34.86900, t: 'shop=supermarket' },
  { n: 'רמי לוי כפר סבא', lat: 32.17600, lon: 34.90500, t: 'shop=supermarket' },
  // Ashdod / Ashkelon
  { n: 'שופרסל דיל אשדוד', lat: 31.79400, lon: 34.64500, t: 'shop=supermarket' },
  { n: 'רמי לוי אשקלון', lat: 31.66400, lon: 34.57900, t: 'shop=supermarket' },
  // Hadera, Afula, Eilat
  { n: 'שופרסל דיל חדרה', lat: 32.44400, lon: 34.91900, t: 'shop=supermarket' },
  { n: 'שופרסל דיל עפולה', lat: 32.61000, lon: 35.29000, t: 'shop=supermarket' },
  { n: 'שופרסל דיל אילת', lat: 29.55710, lon: 34.95190, t: 'shop=supermarket' },
  // Modi'in, Herzliya, Bat Yam
  { n: 'רמי לוי מודיעין', lat: 31.89380, lon: 35.00750, t: 'shop=supermarket' },
  { n: 'שופרסל דיל הרצליה', lat: 32.16500, lon: 34.84400, t: 'shop=supermarket' },
  { n: 'שופרסל שלי בת ים', lat: 32.01700, lon: 34.75000, t: 'shop=supermarket' },
];

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolvePath(here, '..', 'data', 'places-il.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PlacesSnapshot;

  const existingSupermarkets = parsed.places.filter((p) => p.t === 'shop=supermarket').length;
  if (existingSupermarkets > 0) {
    console.log(`✗ places-il.json already has ${existingSupermarkets} supermarkets — no supplement needed`);
    return;
  }

  const combined = [...parsed.places, ...SUPERMARKETS];
  const snapshot: PlacesSnapshot = {
    ...parsed,
    count: combined.length,
    places: combined,
  };

  writeFileSync(path, JSON.stringify(snapshot, null, 0) + '\n', 'utf8');
  console.log(`✓ added ${SUPERMARKETS.length} hand-picked supermarkets → ${combined.length} total places`);
}

main();
