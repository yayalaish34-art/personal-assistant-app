import type { AuthProvider, User } from '@prisma/client';
import { prisma } from '../../db.js';
import { issueRefreshToken, signAccessToken } from '../../lib/tokens.js';

export interface VerifiedIdentity {
  provider: AuthProvider;
  providerUserId: string;
  email: string;
  name: string;
}

export interface SignInResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  language: 'he' | 'en';
  timezone: string;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    language: user.language,
    timezone: user.timezone,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Upsert a user from a verified provider identity, then issue tokens.
 * If the user has a pending deletion (deletion_requested_at set) it is cleared
 * — signing back in cancels the deletion, per spec §8.
 */
export async function signInFromIdentity(
  identity: VerifiedIdentity,
  clientTimezone: string,
): Promise<SignInResult> {
  const user = await prisma.user.upsert({
    where: {
      provider_providerUserId: {
        provider: identity.provider,
        providerUserId: identity.providerUserId,
      },
    },
    create: {
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      email: identity.email,
      name: identity.name,
      timezone: clientTimezone,
    },
    update: {
      email: identity.email,
      // Do NOT overwrite `name` on returning sign-ins: Apple only sends the
      // display name on the FIRST sign-in and the provider layer falls back
      // to email — overwriting would clobber a real name saved previously.
      // Frontend can update the name via PATCH /me instead.
      // Do NOT touch `deletedAt` — no code path sets it on users, so writing
      // `null` here would be a bug magnet if that ever changes.
      deletionRequestedAt: null, // undo pending deletion (spec §8)
    },
  });

  const accessToken = signAccessToken(user.id);
  const refreshToken = await issueRefreshToken(user.id);

  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken,
  };
}
