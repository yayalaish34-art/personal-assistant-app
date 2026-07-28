import { Router } from 'express';
import { asyncHandler } from '../../lib/http.js';
import { NotFound } from '../../lib/errors.js';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { signAccessToken, issueRefreshToken } from '../../lib/tokens.js';

export const devAuthRouter = Router();

const DEV_PROVIDER_USER_ID = 'local-dev-user';

/**
 * POST /auth/dev — sign in as the local dev user without an OAuth round trip.
 *
 * Google/Apple sign-in needs a real provider id token, which means an OAuth
 * client id and a device flow. Until that is configured this endpoint lets the
 * app authenticate against the seeded dev account.
 *
 * Mounted ONLY when NODE_ENV !== 'production' (see app.ts) so it cannot become
 * an authentication bypass in a deployed environment.
 *
 * Create the account first:  npx tsx --env-file=.env scripts/dev-user.mjs
 */
devAuthRouter.post(
  '/dev',
  asyncHandler(async (_req, res) => {
    if (config.NODE_ENV === 'production') {
      throw new NotFound('Not found');
    }

    const user = await prisma.user.findFirst({
      where: {
        provider: 'google',
        providerUserId: DEV_PROVIDER_USER_ID,
        deletedAt: null,
      },
      select: { id: true, email: true, name: true, language: true, timezone: true },
    });

    if (!user) {
      throw new NotFound(
        'Dev user not found — run: npx tsx --env-file=.env scripts/dev-user.mjs',
      );
    }

    const [accessToken, refreshToken] = await Promise.all([
      Promise.resolve(signAccessToken(user.id)),
      issueRefreshToken(user.id),
    ]);

    res.json({ user, accessToken, refreshToken });
  }),
);
