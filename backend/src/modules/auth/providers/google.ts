import { OAuth2Client } from 'google-auth-library';
import { config } from '../../../config.js';
import { Unauthorized, ValidationError } from '../../../lib/errors.js';
import type { VerifiedIdentity } from '../service.js';

const client = new OAuth2Client();

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedIdentity> {
  if (!config.GOOGLE_CLIENT_ID) {
    throw new ValidationError('Google sign-in is not configured on this server');
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: config.GOOGLE_CLIENT_ID,
    });
  } catch {
    throw new Unauthorized('Invalid Google ID token');
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new Unauthorized('Google ID token missing required claims');
  }

  return {
    provider: 'google',
    providerUserId: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
  };
}
