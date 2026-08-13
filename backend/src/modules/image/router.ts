import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, parseBody } from '../../lib/http.js';
import { imageLimiter } from '../../middleware/rateLimit.js';
import { ValidationError } from '../../lib/errors.js';
import { config } from '../../config.js';
import { getOpenAI } from '../chat/llm.js';

/**
 * Image generation (stateless).
 *
 * Unauthenticated like /parse and /voice, and for the same reason: it owns no
 * data. The device asks for a picture, gets the bytes, and keeps them. What
 * cannot ship to a device is the OpenAI key, and that is all this holds.
 *
 * It is deliberately a route of its own rather than a step inside
 * /voice/turn. Generating takes ten to twenty seconds, and folding that into
 * the conversational turn would leave the assistant silent for the whole of
 * it. She says she is drawing, the device asks here, and the picture arrives
 * when it arrives.
 */
export const imageRouter = Router();

/** What the API accepts, named the way a person would think about it. */
const SIZES = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
} as const;

const imageBody = z.object({
  prompt: z.string().min(1).max(1000),
  shape: z.enum(['square', 'portrait', 'landscape']).default('square'),
});

const IMAGE_MODEL = 'gpt-image-1';

imageRouter.post(
  '/image',
  imageLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(imageBody, req);

    if (!config.OPENAI_API_KEY) {
      throw new ValidationError('Image generation is not configured on this server');
    }

    const client = getOpenAI();
    const result = await client.images.generate({
      model: IMAGE_MODEL,
      prompt: body.prompt,
      size: SIZES[body.shape],
      n: 1,
    });

    // The model returns base64 rather than a URL, which suits a device that
    // wants to keep the picture: there is nothing to expire.
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) {
      throw new ValidationError('The image could not be generated');
    }

    res.json({ image: b64, mimeType: 'image/png' });
  }),
);
