import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { Unauthorized } from './errors.js';

// ─── Access tokens (JWT) ───────────────────────────────────────────────────

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AccessTokenPayload {
  sub: string; // user id
  iat: number;
  exp: number;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string') {
      throw new Unauthorized('Invalid token payload');
    }
    return payload as AccessTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Unauthorized('Access token expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Unauthorized('Invalid access token');
    }
    throw err;
  }
}

// ─── Refresh tokens (opaque, hashed in DB) ─────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = randomBytes(48).toString('base64url');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await prisma.refreshToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return raw;
}

/**
 * Rotate a refresh token:
 *   - Look up by hash. Not found or revoked/expired → 401.
 *   - Otherwise revoke it, issue a new one, return the new raw string + userId.
 * All in a single transaction so we can't double-spend.
 */
export async function rotateRefreshToken(
  rawToken: string,
): Promise<{ userId: string; refreshToken: string }> {
  const tokenHash = hashToken(rawToken);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
      throw new Unauthorized('Invalid or expired refresh token');
    }

    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    const raw = randomBytes(48).toString('base64url');
    const newHash = hashToken(raw);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await tx.refreshToken.create({
      data: { userId: existing.userId, tokenHash: newHash, expiresAt },
    });

    return { userId: existing.userId, refreshToken: raw };
  });
}

/**
 * Revoke a single refresh token (used by /auth/logout).
 * Silent no-op if the token is unknown OR belongs to a different user — this
 * lets logout stay idempotent without leaking token ownership.
 * Optional `tx` allows the caller to run inside a transaction.
 */
export async function revokeRefreshToken(
  rawToken: string,
  userId: string,
  tx: Pick<typeof prisma, 'refreshToken'> = prisma,
): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await tx.refreshToken.updateMany({
    where: { tokenHash, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every refresh token for a user (used on account deletion).
 */
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
