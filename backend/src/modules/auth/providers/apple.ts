import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../../../config.js';
import { Unauthorized, ValidationError } from '../../../lib/errors.js';
import type { VerifiedIdentity } from '../service.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

const jwks = createRemoteJWKSet(APPLE_JWKS_URL);

export async function verifyAppleIdToken(idToken: string): Promise<VerifiedIdentity> {
  if (!config.APPLE_CLIENT_ID) {
    throw new ValidationError('Apple sign-in is not configured on this server');
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: APPLE_ISSUER,
      audience: config.APPLE_CLIENT_ID,
    }));
  } catch {
    throw new Unauthorized('Invalid Apple ID token');
  }

  const sub = payload.sub;
  const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : undefined;

  if (!sub || !email) {
    throw new Unauthorized('Apple ID token missing required claims');
  }

  return {
    provider: 'apple',
    providerUserId: sub,
    email,
    // Apple only returns the user's name on the first sign-in via the client
    // sending a `user` payload alongside. For MVP we fall back to email as name.
    name: email,
  };
}
