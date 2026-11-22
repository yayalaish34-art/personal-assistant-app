/**
 * voice-live.test.ts — the server's half of the Gemini Live agent.
 *
 * Opens no conversation and spends nothing: every call to Google is a mocked
 * fetch. Covered here: the setup the token locks in (model, voice, prompt,
 * tools, interruptions, transcription), what the phone is handed for it, and
 * that the API key never leaves this server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { app } from '../src/app.js';
import { ACTION_TOOLS } from '../src/modules/voice/agent.js';
import {
  LIVE_RULES,
  LIVE_SOCKET_URL,
  liveFunctionDeclarations,
  liveSetup,
} from '../src/modules/voice/gemini-live.js';
import { config } from '../src/config.js';

const context = {
  language: 'he',
  timezone: 'Asia/Jerusalem',
  now: '2026-03-10T08:00:00.000Z',
  snapshot: {
    tasks: [{ id: 't1', title: 'לקנות מתנה לרונית', isDone: false, dueAt: null }],
    events: [],
    shopping: [],
    money: [],
    debts: [],
    budgets: {},
  },
};

type Setup = {
  model: string;
  generationConfig: Record<string, unknown>;
  systemInstruction: { parts: { text: string }[] };
  tools: { functionDeclarations: { name: string }[] }[];
  realtimeInputConfig: Record<string, unknown>;
  inputAudioTranscription: { languageCodes: string[] };
  sessionResumption: { handle?: string };
};

// ─── The setup ───────────────────────────────────────────────────────────────

describe('liveSetup', () => {
  it('1. speaks, in the configured voice, with every agent tool', () => {
    const setup = liveSetup({ prompt: 'hello', language: 'he' }) as unknown as Setup;
    expect(setup.model).toBe(`models/${config.GEMINI_LIVE_MODEL}`);
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(JSON.stringify(setup.generationConfig)).toContain(config.GEMINI_LIVE_VOICE);
    expect(setup.systemInstruction.parts[0]!.text).toBe('hello');
    expect(setup.tools[0]!.functionDeclarations.map((d) => d.name)).toEqual(
      ACTION_TOOLS.map((t) => t.function.name),
    );
  });

  it('2. the user talking cuts her off, and their words are written down in the app language', () => {
    const setup = liveSetup({ prompt: '', language: 'he' }) as unknown as Setup;
    expect(setup.realtimeInputConfig.activityHandling).toBe('START_OF_ACTIVITY_INTERRUPTS');
    expect(setup.inputAudioTranscription.languageCodes).toEqual(['he']);
  });

  it('3. a resumed connection carries its handle; a new one asks for handles', () => {
    expect((liveSetup({ prompt: '', language: 'he' }) as unknown as Setup).sessionResumption).toEqual({});
    expect(
      (liveSetup({ prompt: '', language: 'he', resumeHandle: 'h-1' }) as unknown as Setup).sessionResumption,
    ).toEqual({ handle: 'h-1' });
  });

  it('4. sends no thinking level unless one is configured (3.8 refuses the field)', () => {
    const setup = liveSetup({ prompt: '', language: 'he' }) as unknown as Setup;
    if (!config.GEMINI_LIVE_THINKING) expect(setup.generationConfig).not.toHaveProperty('thinkingConfig');
  });
});

describe('liveFunctionDeclarations', () => {
  it('5. hands every tool its JSON Schema as is', () => {
    const decls = liveFunctionDeclarations();
    expect(decls).toHaveLength(ACTION_TOOLS.length);
    for (const [i, decl] of decls.entries()) {
      expect(decl.parametersJsonSchema).toBe(ACTION_TOOLS[i]!.function.parameters);
      expect(typeof decl.description === 'string' && decl.description.length > 0).toBe(true);
    }
  });
});

describe('LIVE_RULES', () => {
  it('6. tell her to stop, not repeat herself, and answer what was just said', () => {
    const rules = LIVE_RULES.join(' ');
    expect(rules).toMatch(/you stop/i);
    expect(rules).toMatch(/do NOT repeat/);
    expect(rules).toMatch(/Answer what they just said/);
    expect(rules).toContain('[APP]');
  });
});

// ─── POST /voice/live/session ────────────────────────────────────────────────

describe('POST /voice/live/session', () => {
  const realKey = config.GEMINI_API_KEY;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (config as { GEMINI_API_KEY?: string }).GEMINI_API_KEY = 'test-key-not-real';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    (config as { GEMINI_API_KEY?: string }).GEMINI_API_KEY = realKey;
    fetchSpy.mockRestore();
  });

  function tokenRequest() {
    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/auth_tokens'));
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
  }

  it('7. hands the phone a single-use token and the socket, never the key', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 }));
    const res = await request(app)
      .post('/voice/live/session')
      .send({ ...context, history: [{ role: 'user', content: 'תזכירי לי לקנות חלב' }] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: LIVE_SOCKET_URL,
      token: 'auth_tokens/abc',
      model: `models/${config.GEMINI_LIVE_MODEL}`,
      inputRate: 16000,
      outputRate: 24000,
    });
    expect(JSON.stringify(res.body)).not.toContain('test-key-not-real');

    const { url, headers, body } = tokenRequest();
    expect(headers['x-goog-api-key']).toBe('test-key-not-real');
    expect(url).not.toContain('test-key-not-real');
    expect(body.uses).toBe(1);
    const prompt: string = body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
    expect(prompt).toContain('LIVE CONVERSATION — BEING INTERRUPTED');
    expect(prompt).toContain('[t1] לקנות מתנה לרונית');
    // The thread so far, so a fresh session knows what was said.
    expect(prompt).toContain('User: תזכירי לי לקנות חלב');
  });

  it('8. a resume handle goes into the locked setup', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ name: 'auth_tokens/def' }), { status: 200 }));
    const res = await request(app).post('/voice/live/session').send({ ...context, history: [], resumeHandle: 'h-42' });
    expect(res.status).toBe(200);
    expect(tokenRequest().body.bidiGenerateContentSetup.sessionResumption).toEqual({ handle: 'h-42' });
  });

  it('9. Google out of quota → 429 that says "quota", so the phone stops retrying', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'You exceeded your current quota' } }), { status: 429 }),
    );
    const res = await request(app).post('/voice/live/session').send({ ...context, history: [] });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/quota/i);
  });

  it('10. a rejected key → 400 that names the key', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }),
    );
    const res = await request(app).post('/voice/live/session').send({ ...context, history: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/api key/i);
  });

  it('11. without a key it says "not configured", rather than 500ing', async () => {
    (config as { GEMINI_API_KEY?: string }).GEMINI_API_KEY = undefined;
    const res = await request(app).post('/voice/live/session').send({ ...context, history: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
