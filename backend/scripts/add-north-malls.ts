/**
 * add-north-malls.ts — small supplement of iconic northern-Israel malls that
 * the Overpass dump either missed or carries under a different name. Same
 * principle as the supermarket fallback: hand-verified, conservative, and
 * harmless if the next quarterly dump brings these back from OSM — the
 * runtime index dedupes by name at lookup time.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexedPlace, PlacesSnapshot } from '../src/modules/voice/places-index.js';

const NORTH_MALLS: IndexedPlace[] = [
  // Haifa + bay
  { n: 'לב המפרץ חיפה', lat: 32.81960, lon: 35.05670, t: 'shop=mall' },
  { n: 'קניון חוף הכרמל', lat: 32.81250, lon: 34.96400, t: 'shop=mall' },
  { n: 'ביג פאשן קרית ביאליק', lat: 32.83000, lon: 35.08200, t: 'shop=mall' },
  // Tiberias + Kinneret
  { n: 'קניון טבריה (ביג פאשן)', lat: 32.79100, lon: 35.52900, t: 'shop=mall' },
  { n: 'גרנד מול טבריה', lat: 32.78900, lon: 35.53100, t: 'shop=mall' },
  // Nazareth
  { n: 'גרנד קניון נצרת עילית', lat: 32.70200, lon: 35.31600, t: 'shop=mall' },
  { n: 'קניון שער העיר נצרת', lat: 32.69900, lon: 35.30400, t: 'shop=mall' },
  // Jezreel valley + Afula
  { n: 'קניון עמק יזרעאל', lat: 32.64600, lon: 35.18700, t: 'shop=mall' },
  { n: 'קניון חוצות עפולה', lat: 32.61000, lon: 35.29000, t: 'shop=mall' },
  // Upper Galilee / Golan
  { n: 'גרנד קניון ראש פינה', lat: 32.97600, lon: 35.54200, t: 'shop=mall' },
  { n: 'קניון צפת', lat: 32.96500, lon: 35.49500, t: 'shop=mall' },
  // Krayot
  { n: 'מתחם ביג קריות', lat: 32.80900, lon: 35.07500, t: 'shop=mall' },
];

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolvePath(here, '..', 'data', 'places-il.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PlacesSnapshot;

  // Guard against double-add: if any of these names are already present
  // (same tag, close coords), skip them.
  const existingKeys = new Set(
    parsed.places
      .filter((p) => p.t === 'shop=mall')
      .map((p) => `${p.n.toLowerCase()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`),
  );
  const fresh = NORTH_MALLS.filter((m) => {
    const k = `${m.n.toLowerCase()}|${m.lat.toFixed(2)}|${m.lon.toFixed(2)}`;
    return !existingKeys.has(k);
  });

  if (fresh.length === 0) {
    console.log('✗ nothing to add — all north malls already present');
    return;
  }

  const combined = [...parsed.places, ...fresh];
  const snapshot: PlacesSnapshot = {
    ...parsed,
    count: combined.length,
    places: combined,
  };

  writeFileSync(path, JSON.stringify(snapshot, null, 0) + '\n', 'utf8');
  console.log(`✓ added ${fresh.length} north malls → ${combined.length} total places`);
  fresh.forEach((m) => console.log(`  + ${m.n}`));
}

main();
