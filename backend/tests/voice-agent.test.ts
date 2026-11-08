/**
 * voice-agent.test.ts — the server's half of the ElevenLabs agent.
 *
 * Does NOT open a conversation. Covered here: the tool definitions as
 * ElevenLabs will read them, and the routes the phone forwards each tool call
 * and agenda refresh to. Those run our own code against the snapshot in the
 * request, so they need no provider at all.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { app } from '../src/app.js';
import { ACTION_TOOLS } from '../src/modules/voice/agent.js';
import { clientToolConfigs, toElevenLabsSchema } from '../src/modules/voice/elevenlabs.js';
import { config } from '../src/config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const context = {
  language: 'he',
  timezone: 'Asia/Jerusalem',
  now: '2026-03-10T08:00:00.000Z',
  snapshot: {
    tasks: [{ id: 't1', title: 'לקנות מתנה לרונית', isDone: false, dueAt: null }],
    events: [],
    shopping: [{ id: 's1', name: 'חלב', isBought: false }],
    money: [],
    debts: [],
    budgets: {},
  },
};

/** Every property, at any depth, with the path to it. */
function walk(schema: Record<string, unknown>, path: string, out: [string, Record<string, unknown>][]) {
  out.push([path, schema]);
  for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>)) {
    walk(value, `${path}.${key}`, out);
  }
  if (schema.items) walk(schema.items as Record<string, unknown>, `${path}[]`, out);
  return out;
}

// ─── The tools, as ElevenLabs sees them ──────────────────────────────────────

describe('toElevenLabsSchema', () => {
  it('1. drops the bounds ElevenLabs has no place for', () => {
    const out = toElevenLabsSchema({
      type: 'object',
      properties: { slots: { type: 'array', items: { type: 'string' }, maxItems: 6, minItems: 2 } },
    });
    const slots = (out.properties as Record<string, Record<string, unknown>>).slots!;
    expect(slots).not.toHaveProperty('maxItems');
    expect(slots).not.toHaveProperty('minItems');
    expect(slots.items).toMatchObject({ type: 'string' });
  });

  it('2. gives a property with no description one, since an empty one is rejected', () => {
    const out = toElevenLabsSchema({ type: 'object', properties: { dueAt: { type: 'string' } } });
    const dueAt = (out.properties as Record<string, Record<string, unknown>>).dueAt!;
    expect(dueAt.description).toBe('The due at.');
  });

  it('3. keeps an enum and a nullable type as they were', () => {
    const out = toElevenLabsSchema({
      type: 'object',
      properties: {
        priority: { type: 'string', enum: ['Low', 'High'], description: 'How urgent.' },
        dueAt: { type: ['string', 'null'], description: 'Or null to clear.' },
      },
      required: ['priority'],
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.priority).toEqual({ type: 'string', description: 'How urgent.', enum: ['Low', 'High'] });
    expect(props.dueAt!.type).toEqual(['string', 'null']);
    expect(out.required).toEqual(['priority']);
  });
});

describe('clientToolConfigs', () => {
  it('4. every agent tool becomes a client tool she waits on', () => {
    const tools = clientToolConfigs();
    expect(tools.map((t) => t.name)).toEqual(ACTION_TOOLS.map((t) => t.function.name));
    for (const tool of tools) {
      expect(tool.type).toBe('client');
      expect(tool.expects_response).toBe(true);
    }
  });

  it('5. every property at every depth carries a description', () => {
    for (const tool of clientToolConfigs()) {
      for (const [path, schema] of walk(tool.parameters as Record<string, unknown>, String(tool.name), [])) {
        expect(typeof schema.description === 'string' && schema.description.length > 0, path).toBe(true);
      }
    }
  });
});

// ─── The routes the phone calls ──────────────────────────────────────────────

describe('POST /voice/agent/tool', () => {
  it('6. a change comes back as an action for the phone to apply', async () => {
    const res = await request(app)
      .post('/voice/agent/tool')
      .send({ ...context, name: 'create_task', arguments: { title: 'להתקשר לרופא' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.result)).toMatchObject({ ok: true });
    expect(res.body.actions).toEqual([{ tool: 'create_task', arguments: { title: 'להתקשר לרופא' } }]);
  });

  it('7. an id that is not in the snapshot is refused, and nothing reaches the phone', async () => {
    const res = await request(app)
      .post('/voice/agent/tool')
      .send({ ...context, name: 'delete_task', arguments: { id: 'nope', matchTitle: 'משהו' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.result)).toMatchObject({ ok: false });
    expect(res.body.actions).toEqual([]);
  });

  it('8. a tool she does not have is answered, not a 500', async () => {
    const res = await request(app)
      .post('/voice/agent/tool')
      .send({ ...context, name: 'launch_rocket', arguments: {} });
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual([]);
  });

  it('9. a request with no tool name → 400', async () => {
    const res = await request(app).post('/voice/agent/tool').send({ ...context, arguments: {} });
    expect(res.status).toBe(400);
  });
});

describe('POST /voice/agent/context', () => {
  it('10. returns the agenda in the words of her prompt, ids included', async () => {
    const res = await request(app).post('/voice/agent/context').send(context);
    expect(res.status).toBe(200);
    expect(res.body.agenda).toContain('[t1] לקנות מתנה לרונית');
    expect(res.body.agenda).toContain('[s1] חלב');
  });
});

describe('POST /voice/agent/session', () => {
  // With an agent configured this would open a real conversation on the
  // account, which no test here is allowed to do.
  const agentConfigured = Boolean(config.ELEVENLABS_API_KEY && config.ELEVENLABS_AGENT_ID);

  it.skipIf(agentConfigured)('11. without an agent configured it says so, rather than 500ing', async () => {
    const res = await request(app).post('/voice/agent/session').send({ ...context, history: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not configured/i);
  });
});
