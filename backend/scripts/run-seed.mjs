// Applies scripts/seed.sql to the database in DATABASE_URL.
//
//   railway run --service Postgres -- node scripts/run-seed.mjs
//
// Prefers DATABASE_PUBLIC_URL when present: Railway's DATABASE_URL points at
// `*.railway.internal`, which only resolves inside their network, so running
// this from a laptop needs the externally-routable form.
//
// pg is used rather than `prisma db execute` because the SQL is one multi
// statement transaction, and this reports the verification row back.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

if (!url) {
  console.error('✗ No DATABASE_URL or DATABASE_PUBLIC_URL in the environment.');
  process.exit(1);
}

// Log the host only — never the credentials.
console.log(`→ connecting to ${new URL(url).host}`);

const client = new pg.Client({
  connectionString: url,
  // Railway's managed Postgres presents a certificate this client doesn't
  // have a local CA for; the connection is still encrypted.
  ssl: url.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();
  const sql = readFileSync(join(here, 'seed.sql'), 'utf8');
  const results = await client.query(sql);

  // The file ends with a SELECT, which lands in the last result set.
  const last = Array.isArray(results) ? results[results.length - 1] : results;
  const row = last?.rows?.[0];
  if (row) {
    console.log('✓ seeded');
    for (const [k, v] of Object.entries(row)) console.log(`   ${k}: ${v}`);
  } else {
    console.log('✓ applied (no verification row returned)');
  }
} catch (e) {
  console.error('✗ failed:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
