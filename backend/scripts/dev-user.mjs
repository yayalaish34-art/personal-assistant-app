// Creates (or reuses) a permanent local dev user and prints a session for it.
//
//   npx tsx --env-file=.env scripts/dev-user.mjs
//
// Idempotent: the user is keyed on a fixed providerUserId, so running this
// repeatedly returns the same account instead of piling up duplicates.
//
// Why two tokens: access tokens are deliberately short-lived (15 min) and that
// is not configurable per-request. Refresh tokens last 30 days, and the app's
// API client automatically exchanges one for a new access token whenever it
// hits a 401 — so seeding both means you sign in once and stay signed in.

import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();

const DEV_PROVIDER_USER_ID = 'local-dev-user';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const { JWT_SECRET } = process.env;
if (!JWT_SECRET) {
  console.error('✗ JWT_SECRET missing — run with: npx tsx --env-file=.env scripts/dev-user.mjs');
  process.exit(1);
}

// Reuse the account if it already exists; clear a pending deletion so an
// earlier `DELETE /me` can't leave the dev user unusable.
const user = await prisma.user.upsert({
  where: { provider_providerUserId: { provider: 'google', providerUserId: DEV_PROVIDER_USER_ID } },
  update: { deletedAt: null, deletionRequestedAt: null },
  create: {
    provider: 'google',
    providerUserId: DEV_PROVIDER_USER_ID,
    email: 'dev@local',
    name: 'Dev User',
    timezone: 'Asia/Jerusalem',
    language: 'en',
  },
});

const accessToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });

const rawRefresh = randomBytes(48).toString('base64url');
await prisma.refreshToken.create({
  data: {
    userId: user.id,
    tokenHash: createHash('sha256').update(rawRefresh).digest('hex'),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  },
});

const [{ count: events }] = await prisma.$queryRaw`
  SELECT count(*)::int AS count FROM events WHERE user_id = ${user.id}::uuid AND deleted_at IS NULL`;
const [{ count: tasks }] = await prisma.$queryRaw`
  SELECT count(*)::int AS count FROM tasks WHERE user_id = ${user.id}::uuid AND deleted_at IS NULL`;

console.log(JSON.stringify(
  {
    userId: user.id,
    name: user.name,
    timezone: user.timezone,
    accessToken,
    refreshToken: rawRefresh,
    data: { events, tasks },
  },
  null,
  2,
));

await prisma.$disconnect();
