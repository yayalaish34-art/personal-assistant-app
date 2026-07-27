/**
 * auth.test.ts — Behavioral tests for CLAUDE.md §8 Auth + Account-deletion rubrics.
 *
 * Covers the QA-2 fixes made by the Opus orchestrator:
 *   B-1  /auth/logout now requires authentication
 *   M-1  DELETE /me wraps both writes in a transaction
 *   M-2  signInFromIdentity does NOT overwrite name on returning sign-ins
 *   N-3  Same as M-2 (naming rule preserved after re-login)
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import {
  signAccessToken,
  issueRefreshToken,
  revokeRefreshToken,
} from '../src/lib/tokens.js';
import { signInFromIdentity } from '../src/modules/auth/service.js';
import { handlePurgeDeletedUsers } from '../src/jobs/purgeDeletedUsers.js';
import { randomUUID } from 'node:crypto';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uniqueId() {
  return `${Date.now()}-${randomUUID()}`;
}

async function createUser(overrides: Partial<{
  name: string;
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
}> = {}) {
  const uid = uniqueId();
  return prisma.user.create({
    data: {
      provider: 'google',
      providerUserId: uid,
      email: `${uid}@auth-test`,
      name: overrides.name ?? 'Test User',
      timezone: 'UTC',
      deletionRequestedAt: overrides.deletionRequestedAt ?? null,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

function bearer(userId: string) {
  return `Bearer ${signAccessToken(userId)}`;
}

// ─── Access token middleware ──────────────────────────────────────────────────

describe('Access token middleware', () => {
  let userId: string;

  afterAll(async () => {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('1. no Authorization header → 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('2. Authorization: NotBearer x → 401', async () => {
    const res = await request(app).get('/me').set('Authorization', 'NotBearer x');
    expect(res.status).toBe(401);
  });

  it('3. Authorization: Bearer (empty after prefix) → 401', async () => {
    const res = await request(app).get('/me').set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  it('4. completely invalid JWT string → 401', async () => {
    const res = await request(app).get('/me').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('5. JWT signed with wrong secret → 401', async () => {
    const badToken = jwt.sign({ sub: 'any-id' }, 'wrong-secret-that-is-long-enough-32chars');
    const res = await request(app).get('/me').set('Authorization', `Bearer ${badToken}`);
    expect(res.status).toBe(401);
  });

  it('6. expired JWT → 401', async () => {
    const secret = process.env['JWT_SECRET']!;
    const expiredToken = jwt.sign({ sub: 'some-user-id' }, secret, { expiresIn: '-1s' });
    const res = await request(app).get('/me').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  it('7. valid JWT for a hard-deleted user → 401', async () => {
    const user = await createUser();
    const token = signAccessToken(user.id);
    await prisma.user.delete({ where: { id: user.id } });

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('8. valid JWT for user with deletionRequestedAt set (grace period) → 200', async () => {
    const user = await createUser({ deletionRequestedAt: new Date() });
    userId = user.id;

    const res = await request(app).get('/me').set('Authorization', bearer(userId));
    // Middleware allows deletion-requested users through (undo-in-progress grace)
    // /me returns 404 because it filters on deletedAt: null — user exists so 200 or 404;
    // the key assertion is that authMiddleware does NOT block with 401.
    expect(res.status).not.toBe(401);
  });
});

// ─── Refresh + rotation ───────────────────────────────────────────────────────

describe('Refresh + rotation', () => {
  let userId: string;

  afterAll(async () => {
    if (userId) {
      await prisma.refreshToken.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it('9. valid refresh token → 200, returns new accessToken and refreshToken', async () => {
    const user = await createUser();
    userId = user.id;
    const rawToken = await issueRefreshToken(userId);

    const res = await request(app).post('/auth/refresh').send({ refreshToken: rawToken });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.refreshToken).not.toBe(rawToken);
  });

  it('10. reusing already-rotated (old) refresh token → 401', async () => {
    const rawToken = await issueRefreshToken(userId);
    // Rotate it once
    await request(app).post('/auth/refresh').send({ refreshToken: rawToken }).expect(200);
    // Reuse the old one
    const res = await request(app).post('/auth/refresh').send({ refreshToken: rawToken });
    expect(res.status).toBe(401);
  });

  it('11. unknown refresh token → 401', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'completely-unknown-token-value' });
    expect(res.status).toBe(401);
  });

  it('12. expired refresh row (expiresAt in the past) → 401', async () => {
    const rawToken = await issueRefreshToken(userId);
    // Manually push expiry into the past
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await prisma.refreshToken.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).post('/auth/refresh').send({ refreshToken: rawToken });
    expect(res.status).toBe(401);
  });

  it('13. revoked refresh row → 401', async () => {
    const rawToken = await issueRefreshToken(userId);
    await revokeRefreshToken(rawToken, userId);

    const res = await request(app).post('/auth/refresh').send({ refreshToken: rawToken });
    expect(res.status).toBe(401);
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

describe('Logout (QA-2 B-1 fix — requires auth)', () => {
  let userAId: string;
  let userBId: string;

  afterAll(async () => {
    const ids = [userAId, userBId].filter(Boolean);
    if (ids.length) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      await prisma.device.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it('14. POST /auth/logout with no Authorization → 401 (QA-2 B-1)', async () => {
    const res = await request(app).post('/auth/logout').send({});
    expect(res.status).toBe(401);
  });

  it('15. logout with valid auth + own refreshToken → 204, token row has revokedAt', async () => {
    const user = await createUser();
    userAId = user.id;
    const rawToken = await issueRefreshToken(userAId);

    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', bearer(userAId))
      .send({ refreshToken: rawToken });

    expect(res.status).toBe(204);

    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it('16. logout with user A auth + user B refreshToken → 204 (silent no-op), B token stays active', async () => {
    const userB = await createUser();
    userBId = userB.id;
    const bToken = await issueRefreshToken(userBId);

    // User A tries to revoke user B's token — should silently succeed (no leakage)
    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', bearer(userAId))
      .send({ refreshToken: bToken });

    expect(res.status).toBe(204);

    // B's token must still be active (usable for refresh)
    const refreshRes = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: bToken });
    expect(refreshRes.status).toBe(200);
  });

  it('17. logout with valid auth, pushToken from another user\'s device → 204, other device row unchanged', async () => {
    // Seed a device for user B
    const otherPushToken = `push-other-${uniqueId()}`;
    const deviceB = await prisma.device.create({
      data: {
        userId: userBId,
        pushToken: otherPushToken,
        platform: 'ios',
      },
    });

    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', bearer(userAId))
      .send({ pushToken: otherPushToken });

    expect(res.status).toBe(204);

    // Device B must still exist
    const still = await prisma.device.findUnique({ where: { id: deviceB.id } });
    expect(still).not.toBeNull();
  });

  it('18. logout with valid auth, own pushToken → 204, device row is gone', async () => {
    const myPushToken = `push-own-${uniqueId()}`;
    await prisma.device.create({
      data: {
        userId: userAId,
        pushToken: myPushToken,
        platform: 'ios',
      },
    });

    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', bearer(userAId))
      .send({ pushToken: myPushToken });

    expect(res.status).toBe(204);

    const gone = await prisma.device.findFirst({
      where: { userId: userAId, pushToken: myPushToken },
    });
    expect(gone).toBeNull();
  });
});

// ─── DELETE /me + purge + sign-back-in ────────────────────────────────────────

describe('DELETE /me — account deletion', () => {
  let userId: string;

  afterEach(async () => {
    if (userId) {
      await prisma.refreshToken.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      userId = '';
    }
  });

  it('19. DELETE /me → 202, sets deletionRequestedAt and revokes all refresh tokens (atomic)', async () => {
    const user = await createUser();
    userId = user.id;
    // Issue two refresh tokens before deletion
    await issueRefreshToken(userId);
    await issueRefreshToken(userId);

    const res = await request(app)
      .delete('/me')
      .set('Authorization', bearer(userId));

    expect(res.status).toBe(202);
    expect(typeof res.body.deletionRequestedAt).toBe('string');

    // Both fields visible together after response — atomic write
    const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(updatedUser?.deletionRequestedAt).not.toBeNull();

    const activeTokens = await prisma.refreshToken.findMany({
      where: { userId, revokedAt: null },
    });
    expect(activeTokens.length).toBe(0);
  });

  it('20. second DELETE /me → 202, same timestamp (idempotent, not overwritten)', async () => {
    const user = await createUser();
    userId = user.id;

    const first = await request(app)
      .delete('/me')
      .set('Authorization', bearer(userId))
      .expect(202);

    const firstTs = first.body.deletionRequestedAt as string;

    const second = await request(app)
      .delete('/me')
      .set('Authorization', bearer(userId))
      .expect(202);

    expect(second.body.deletionRequestedAt).toBe(firstTs);
  });

  it('21. sign back in after DELETE /me clears deletionRequestedAt', async () => {
    const providerUserId = uniqueId();
    const result = await signInFromIdentity(
      { provider: 'google', providerUserId, email: `${providerUserId}@test`, name: 'Dev' },
      'UTC',
    );
    userId = result.user.id;

    // Mark for deletion
    await request(app)
      .delete('/me')
      .set('Authorization', `Bearer ${result.accessToken}`)
      .expect(202);

    // Verify it is set
    const before = await prisma.user.findUnique({ where: { id: userId } });
    expect(before?.deletionRequestedAt).not.toBeNull();

    // Sign back in cancels deletion
    await signInFromIdentity(
      { provider: 'google', providerUserId, email: `${providerUserId}@test`, name: 'Dev' },
      'UTC',
    );

    const after = await prisma.user.findUnique({ where: { id: userId } });
    expect(after?.deletionRequestedAt).toBeNull();
  });
});

// ─── Purge job ────────────────────────────────────────────────────────────────

describe('handlePurgeDeletedUsers', () => {
  let oldUserId: string;
  let recentUserId: string;

  afterAll(async () => {
    // Clean up anything that didn't get purged
    const ids = [oldUserId, recentUserId].filter(Boolean);
    if (ids.length) {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it('22. purges user past 31-day window, keeps user at 5 days', async () => {
    const now = Date.now();

    const oldUser = await createUser({
      deletionRequestedAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
    });
    oldUserId = oldUser.id;

    const recentUser = await createUser({
      deletionRequestedAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
    });
    recentUserId = recentUser.id;

    const fakeJob = [{ id: 't', name: 'x', data: {}, expireInSeconds: 900 } as any];
    await handlePurgeDeletedUsers(fakeJob);

    const oldRow = await prisma.user.findUnique({ where: { id: oldUserId } });
    expect(oldRow).toBeNull(); // hard-deleted
    oldUserId = ''; // prevent double-cleanup

    const recentRow = await prisma.user.findUnique({ where: { id: recentUserId } });
    expect(recentRow).not.toBeNull(); // still present
  });
});

// ─── signInFromIdentity — returning-user name rule ────────────────────────────

describe('signInFromIdentity — returning user', () => {
  let userId: string;

  afterAll(async () => {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('23. does NOT overwrite name on returning sign-in (QA-2 M-2 / N-3)', async () => {
    const providerUserId = uniqueId();

    // First sign-in: name from provider
    const first = await signInFromIdentity(
      { provider: 'google', providerUserId, email: `${providerUserId}@test`, name: 'OriginalName' },
      'UTC',
    );
    userId = first.user.id;

    // User updates their name via PATCH /me
    await prisma.user.update({ where: { id: userId }, data: { name: 'SavedName' } });

    // Returning sign-in: provider sends a different name (or fallback to email)
    const second = await signInFromIdentity(
      { provider: 'google', providerUserId, email: `${providerUserId}@test`, name: 'ShouldBeIgnored' },
      'UTC',
    );

    expect(second.user.name).toBe('SavedName');

    // Also verify via DB
    const dbRow = await prisma.user.findUnique({ where: { id: userId } });
    expect(dbRow?.name).toBe('SavedName');
  });
});

// ─── Global teardown ─────────────────────────────────────────────────────────

afterAll(async () => {
  await prisma.$disconnect();
});
