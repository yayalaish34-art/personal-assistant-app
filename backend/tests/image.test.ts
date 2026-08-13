/**
 * image.test.ts — Request validation for POST /image.
 *
 * Nothing here reaches OpenAI: every case is rejected by the schema, which is
 * the point. Generating an image costs real money and takes ten to twenty
 * seconds, so the thing worth testing automatically is that a malformed
 * request never gets that far.
 *
 * The route is stateless and unauthenticated, like /voice and /parse, so there
 * are no tokens or fixtures to set up.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { app } from '../src/app.js';

describe('POST /image — validation', () => {
  it('1. no prompt → 400', async () => {
    const res = await request(app).post('/image').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('2. empty prompt → 400', async () => {
    const res = await request(app).post('/image').send({ prompt: '' });
    expect(res.status).toBe(400);
  });

  it('3. a prompt past the cap → 400', async () => {
    const res = await request(app)
      .post('/image')
      .send({ prompt: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
  });

  it('4. a shape that is not offered → 400', async () => {
    const res = await request(app)
      .post('/image')
      .send({ prompt: 'a cat', shape: 'panoramic' });
    expect(res.status).toBe(400);
  });

  it('5. a prompt is not confused for a task and routed elsewhere', async () => {
    // /image is mounted at the root alongside every other router; a 404 here
    // would mean the mount order swallowed it.
    const res = await request(app).post('/image').send({});
    expect(res.status).not.toBe(404);
  });
});
