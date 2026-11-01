/**
 * dump-il-places.ts — one-shot export of every place in Israel the agent might
 * mention, written to `backend/data/places-il.json` for runtime to haversine
 * through.
 *
 * Why this exists: the public Overpass endpoint is at capacity most of the
 * time, so asking it at voice-turn time left the agent silent in ~90% of
 * "find me a mall" moments. A one-shot export has none of that problem — the
 * file sits in the repo and is loaded once at boot. The downside is that the
 * data goes stale; re-run this script every few months (or wire it to a
 * quarterly GitHub Action).
 *
 * Run:
 *   pnpm tsx backend/scripts/dump-il-places.ts
 *
 * Flags:
 *   --out <path>    override the output file
 *   --retries <n>   default 4 per mirror
 *   --quiet         less chatter
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_DUMP_TAGS,
  type IndexedPlace,
  type PlacesSnapshot,
} from '../src/modules/voice/places-index.js';

// Overpass has a handful of public mirrors. The main endpoint is the fastest
// when it is up and the slowest when it is down. We try them in order and
// move on the moment one answers with real JSON.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const PER_REQUEST_TIMEOUT_MS = 90_000; // relations across all of Israel are slow
const BETWEEN_RETRIES_MS = 3_000;

interface OverpassElement {
  type?: 'node' | 'way' | 'relation';
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
}

interface Flags {
  out: string;
  retries: number;
  quiet: boolean;
  /**
   * Only fetch these tags. The script still reads the existing output file
   * and keeps every place whose tag is NOT in this list, so running with
   * `--only-tags shop=supermarket,amenity=pharmacy` improves those two
   * categories without touching the rest.
   */
  onlyTags: Set<string> | null;
}

function parseFlags(argv: string[]): Flags {
  const here = dirname(fileURLToPath(import.meta.url));
  // backend/scripts/dump-il-places.ts → backend/data/places-il.json
  const defaultOut = resolvePath(here, '..', 'data', 'places-il.json');
  const flags: Flags = { out: defaultOut, retries: 4, quiet: false, onlyTags: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) { flags.out = argv[i + 1]!; i += 1; }
    else if (a === '--retries' && argv[i + 1]) { flags.retries = Number(argv[i + 1]); i += 1; }
    else if (a === '--only-tags' && argv[i + 1]) {
      flags.onlyTags = new Set(argv[i + 1]!.split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
    }
    else if (a === '--quiet') flags.quiet = true;
  }
  return flags;
}

/** Read the existing snapshot (if any). Used to preserve work from prior runs. */
function readExisting(path: string): IndexedPlace[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as PlacesSnapshot;
    return Array.isArray(parsed?.places) ? parsed.places : [];
  } catch {
    return [];
  }
}

/** Overpass QL for a single `key=value` tag across all of Israel. */
function queryFor(tag: string): string {
  const [key, value] = tag.split('=');
  const bracket = `["${key}"="${value}"]`;
  // Use the ISO3166-1 area for Israel. Including node + way + relation picks
  // up every representation OSM uses — the big-mall case the live agent
  // used to miss is a relation.
  return `[out:json][timeout:180];
area["ISO3166-1"="IL"][admin_level=2]->.il;
(
  node${bracket}(area.il);
  way${bracket}(area.il);
  relation${bracket}(area.il);
);
out tags center;`;
}

async function fetchFromMirror(mirror: string, query: string): Promise<OverpassElement[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(mirror, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { elements?: OverpassElement[] };
    return body.elements ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTag(tag: string, retries: number, log: (s: string) => void): Promise<OverpassElement[]> {
  const query = queryFor(tag);
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    for (const mirror of MIRRORS) {
      log(`  [${tag}] attempt ${attempt} → ${new URL(mirror).host}`);
      const elements = await fetchFromMirror(mirror, query);
      if (elements) {
        log(`  [${tag}] ✓ ${elements.length} elements`);
        return elements;
      }
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, BETWEEN_RETRIES_MS));
    }
  }
  log(`  [${tag}] ✗ all mirrors failed`);
  return [];
}

function elementToPlace(el: OverpassElement, tag: string): IndexedPlace | null {
  const name = el.tags?.name?.trim();
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  // Round to 5 decimals (~1 m precision). More is noise and bloats the file.
  return {
    n: name,
    lat: Math.round(lat * 100000) / 100000,
    lon: Math.round(lon * 100000) / 100000,
    t: tag,
  };
}

/** Dedupe by name + tag + ~100m grid. Same mall listed as way AND relation. */
function dedupe(places: IndexedPlace[]): IndexedPlace[] {
  const seen = new Set<string>();
  const out: IndexedPlace[] = [];
  for (const p of places) {
    const key = `${p.t}|${p.n.toLowerCase()}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const log = flags.quiet ? () => {} : (s: string) => console.log(s);

  const tagsToFetch = flags.onlyTags
    ? ALL_DUMP_TAGS.filter((t) => flags.onlyTags!.has(t))
    : ALL_DUMP_TAGS;

  log(`→ fetching ${tagsToFetch.length} tag(s)${flags.onlyTags ? ' (only-tags mode)' : ''}`);
  log(`→ writing to ${flags.out}`);

  // Carry over places from any prior successful run. In only-tags mode we
  // keep every place whose tag isn't being refetched; in full mode we also
  // keep tags that fail this run, so monotonic improvement is possible.
  const existing = readExisting(flags.out);
  const carryOver: IndexedPlace[] = [];
  if (existing.length) {
    const skipTags = new Set(tagsToFetch);
    for (const p of existing) if (!skipTags.has(p.t)) carryOver.push(p);
    log(`→ carrying over ${carryOver.length} places from prior run`);
  }
  log('');

  const freshlyFetched: IndexedPlace[] = [];
  const counts: Record<string, number> = {};
  const failedTags: string[] = [];

  for (const tag of tagsToFetch) {
    const elements = await fetchTag(tag, flags.retries, log);
    if (elements.length === 0) failedTags.push(tag);
    const places = elements
      .map((el) => elementToPlace(el, tag))
      .filter((p): p is IndexedPlace => p !== null);
    counts[tag] = places.length;
    freshlyFetched.push(...places);
  }

  // On a failure, bring back the prior run's places for that tag — never
  // regress.
  if (failedTags.length && existing.length) {
    const failedSet = new Set(failedTags);
    for (const p of existing) {
      if (failedSet.has(p.t)) {
        carryOver.push(p);
        counts[p.t] = (counts[p.t] ?? 0) + 1;
      }
    }
    log(`→ ${failedTags.length} tag(s) failed; kept their prior places`);
  }

  const merged = dedupe([...carryOver, ...freshlyFetched]);
  log('');
  log(`→ ${merged.length} unique places (${freshlyFetched.length} fresh + ${carryOver.length} carried over)`);
  log('  per tag this run:');
  for (const [tag, n] of Object.entries(counts)) log(`    ${tag.padEnd(28)} ${n}`);

  const snapshot: PlacesSnapshot = {
    generated: new Date().toISOString().slice(0, 10),
    count: merged.length,
    places: merged,
  };

  writeFileSync(flags.out, JSON.stringify(snapshot, null, 0) + '\n', 'utf8');
  log('');
  log(`✓ wrote ${flags.out}`);
}

main().catch((err) => {
  console.error('dump failed:', err);
  process.exit(1);
});
