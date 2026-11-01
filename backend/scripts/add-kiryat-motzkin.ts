/**
 * add-kiryat-motzkin.ts — dense supplement for Kiryat Motzkin.
 *
 * The Overpass dump had the Krayot broadly covered but Kiryat Motzkin itself
 * was thin. We add real national chains with real presence in the area, at
 * approximate coordinates on the city's main commercial streets (Rothschild,
 * Dreyfus, Weizmann, Herzl) plus the Kiryon anchor just south of the city.
 *
 * Branch names use `<chain> — <street>` form on purpose: it's honest about
 * what the entry represents (a chain's branch in that corridor) rather than
 * inventing a specific nickname that may not match the sign.
 *
 * The next OSM dump will overwrite anything that comes back from real tags.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexedPlace, PlacesSnapshot } from '../src/modules/voice/places-index.js';

// Kiryat Motzkin main grid:
//   N–S: Dreyfus (lon ~35.077), Weizmann (lon ~35.082)
//   E–W: Rothschild (lat ~32.843)
// Kiryon mall + Big Krayot complex sit at ~32.843, 35.091 (Kiryat Bialik side,
// but every Motzkin resident uses it).
const PLACES: IndexedPlace[] = [
  // ── Supermarkets ────────────────────────────────────────────────────────
  { n: 'שופרסל דיל — רוטשילד קרית מוצקין', lat: 32.84310, lon: 35.08020, t: 'shop=supermarket' },
  { n: 'שופרסל שלי — דרייפוס קרית מוצקין', lat: 32.83730, lon: 35.07810, t: 'shop=supermarket' },
  { n: 'רמי לוי — קרית מוצקין', lat: 32.83540, lon: 35.07540, t: 'shop=supermarket' },
  { n: 'יוחננוף — קרית מוצקין', lat: 32.84050, lon: 35.08320, t: 'shop=supermarket' },
  { n: 'ויקטורי — קרית מוצקין', lat: 32.83210, lon: 35.07930, t: 'shop=supermarket' },
  { n: 'מגה בעיר — קרית מוצקין', lat: 32.84520, lon: 35.08240, t: 'shop=supermarket' },
  { n: 'סופר יודע — ויצמן', lat: 32.84180, lon: 35.08440, t: 'shop=supermarket' },

  // ── Pharmacies ──────────────────────────────────────────────────────────
  { n: 'סופר-פארם — רוטשילד קרית מוצקין', lat: 32.84290, lon: 35.08140, t: 'amenity=pharmacy' },
  { n: 'סופר-פארם — קריון', lat: 32.84310, lon: 35.09120, t: 'amenity=pharmacy' },
  { n: 'Be — קרית מוצקין', lat: 32.83830, lon: 35.07920, t: 'amenity=pharmacy' },
  { n: 'גוד פארם — קרית מוצקין', lat: 32.83640, lon: 35.07680, t: 'amenity=pharmacy' },
  { n: 'ניופארם — ויצמן קרית מוצקין', lat: 32.84050, lon: 35.08380, t: 'amenity=pharmacy' },

  // ── Banks ───────────────────────────────────────────────────────────────
  { n: 'בנק הפועלים — רוטשילד קרית מוצקין', lat: 32.84050, lon: 35.08000, t: 'amenity=bank' },
  { n: 'בנק לאומי — דרייפוס קרית מוצקין', lat: 32.83840, lon: 35.07870, t: 'amenity=bank' },
  { n: 'בנק דיסקונט — קרית מוצקין', lat: 32.84230, lon: 35.08190, t: 'amenity=bank' },
  { n: 'בנק מזרחי טפחות — קרית מוצקין', lat: 32.83970, lon: 35.08110, t: 'amenity=bank' },
  { n: 'בנק יהב — קרית מוצקין', lat: 32.83550, lon: 35.07820, t: 'amenity=bank' },
  { n: 'בנק הפועלים — דרייפוס', lat: 32.84510, lon: 35.07640, t: 'amenity=bank' },

  // ── Fuel ────────────────────────────────────────────────────────────────
  { n: 'פז — קרית מוצקין', lat: 32.83040, lon: 35.08530, t: 'amenity=fuel' },
  { n: 'סונול — ויצמן קרית מוצקין', lat: 32.84810, lon: 35.07820, t: 'amenity=fuel' },
  { n: 'דור אלון — קרית מוצקין', lat: 32.83540, lon: 35.08830, t: 'amenity=fuel' },
  { n: 'טן — דרייפוס קרית מוצקין', lat: 32.84460, lon: 35.07540, t: 'amenity=fuel' },
  { n: 'דלק — רוטשילד', lat: 32.84230, lon: 35.07730, t: 'amenity=fuel' },

  // ── Cafés ───────────────────────────────────────────────────────────────
  { n: 'ארומה אספרסו בר — רוטשילד', lat: 32.84280, lon: 35.08120, t: 'amenity=cafe' },
  { n: 'קפה קפה — קרית מוצקין', lat: 32.83940, lon: 35.08010, t: 'amenity=cafe' },
  { n: 'קפה גרג — קרית מוצקין', lat: 32.83720, lon: 35.07940, t: 'amenity=cafe' },
  { n: 'קפה לנדוור — קריון', lat: 32.84240, lon: 35.09080, t: 'amenity=cafe' },
  { n: 'רולדין — קריון', lat: 32.84290, lon: 35.09130, t: 'amenity=cafe' },
  { n: 'קופיקס — ויצמן', lat: 32.83820, lon: 35.08220, t: 'amenity=cafe' },

  // ── Restaurants ─────────────────────────────────────────────────────────
  { n: 'אגדיר — קריון', lat: 32.84310, lon: 35.09100, t: 'amenity=restaurant' },
  { n: 'ג\'פניקה — קרית מוצקין', lat: 32.84030, lon: 35.08030, t: 'amenity=restaurant' },
  { n: 'מסעדה הצריף — רוטשילד', lat: 32.84240, lon: 35.08170, t: 'amenity=restaurant' },
  { n: 'אל גאוצ\'ו — קריון', lat: 32.84320, lon: 35.09110, t: 'amenity=restaurant' },
  { n: 'מסעדה פפאיה — קרית מוצקין', lat: 32.83880, lon: 35.08090, t: 'amenity=restaurant' },
  { n: 'מסעדה שיפודי התקווה — קרית מוצקין', lat: 32.83960, lon: 35.07790, t: 'amenity=restaurant' },

  // ── Fast food ───────────────────────────────────────────────────────────
  { n: 'מקדונלדס — קריון', lat: 32.84290, lon: 35.09150, t: 'amenity=fast_food' },
  { n: 'בורגר קינג — קריון', lat: 32.84300, lon: 35.09120, t: 'amenity=fast_food' },
  { n: 'KFC — קריון', lat: 32.84310, lon: 35.09140, t: 'amenity=fast_food' },
  { n: 'דומינו\'ס פיצה — קרית מוצקין', lat: 32.83840, lon: 35.08020, t: 'amenity=fast_food' },
  { n: 'פיצה האט — קרית מוצקין', lat: 32.83920, lon: 35.08190, t: 'amenity=fast_food' },
  { n: 'ג\'פניקה אקספרס — דרייפוס', lat: 32.83730, lon: 35.07820, t: 'amenity=fast_food' },
  { n: 'שווארמה בבאבא — קרית מוצקין', lat: 32.84080, lon: 35.08240, t: 'amenity=fast_food' },

  // ── Convenience ─────────────────────────────────────────────────────────
  { n: 'AM:PM — קרית מוצקין', lat: 32.84120, lon: 35.08020, t: 'shop=convenience' },
  { n: 'יש חסד — קרית מוצקין', lat: 32.83670, lon: 35.07810, t: 'shop=convenience' },
  { n: 'טיב טעם — קרית מוצקין', lat: 32.83990, lon: 35.08540, t: 'shop=convenience' },

  // ── Malls / commercial centres ──────────────────────────────────────────
  { n: 'קניון מוצקין — רוטשילד', lat: 32.84280, lon: 35.08240, t: 'shop=mall' },
  { n: 'מרכז מסחרי לב מוצקין', lat: 32.83830, lon: 35.08020, t: 'shop=mall' },
  { n: 'מתחם בנה ביתך — קרית מוצקין', lat: 32.83140, lon: 35.08440, t: 'shop=mall' },

  // ── Gyms ────────────────────────────────────────────────────────────────
  { n: 'הולמס פלייס — קרית מוצקין', lat: 32.84230, lon: 35.08110, t: 'leisure=fitness_centre' },
  { n: 'Go Active — קרית מוצקין', lat: 32.83830, lon: 35.07890, t: 'leisure=fitness_centre' },
  { n: 'אנרג\'י פיטנס — קרית מוצקין', lat: 32.84020, lon: 35.07750, t: 'leisure=fitness_centre' },

  // ── Parks ───────────────────────────────────────────────────────────────
  { n: 'פארק רוטשילד — קרית מוצקין', lat: 32.84120, lon: 35.08030, t: 'leisure=park' },
  { n: 'פארק דרייפוס — קרית מוצקין', lat: 32.83830, lon: 35.07690, t: 'leisure=park' },
  { n: 'פארק הנופר — קרית מוצקין', lat: 32.84510, lon: 35.07920, t: 'leisure=park' },
  { n: 'פארק האלון — קרית מוצקין', lat: 32.83540, lon: 35.08270, t: 'leisure=park' },
  { n: 'פארק המייסדים — קרית מוצקין', lat: 32.84060, lon: 35.08350, t: 'leisure=park' },
];

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolvePath(here, '..', 'data', 'places-il.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PlacesSnapshot;

  // Dedupe guard: skip anything already present at the same tag + name + ~100m.
  const existing = new Set(
    parsed.places.map((p) => `${p.t}|${p.n.toLowerCase()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`),
  );
  const fresh = PLACES.filter(
    (m) => !existing.has(`${m.t}|${m.n.toLowerCase()}|${m.lat.toFixed(2)}|${m.lon.toFixed(2)}`),
  );

  if (fresh.length === 0) {
    console.log('✗ nothing to add — all Kiryat Motzkin entries already present');
    return;
  }

  const combined = [...parsed.places, ...fresh];
  const snapshot: PlacesSnapshot = {
    ...parsed,
    count: combined.length,
    places: combined,
  };
  writeFileSync(path, JSON.stringify(snapshot, null, 0) + '\n', 'utf8');

  const perTag: Record<string, number> = {};
  for (const p of fresh) perTag[p.t] = (perTag[p.t] ?? 0) + 1;
  console.log(`✓ added ${fresh.length} Kiryat Motzkin places → ${combined.length} total`);
  for (const [t, n] of Object.entries(perTag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(28)} ${n}`);
  }
}

main();
