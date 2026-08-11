/**
 * voice.test.ts — the voice assistant: agent rules and both HTTP routes.
 *
 * The voice module is what the app actually talks to, and it was the only
 * module with no tests at all. It is also the one place where a model's
 * mistake reaches the user's real data: the device applies whatever `actions`
 * come back, so the guards in `collectAction` — an id that isn't in the
 * snapshot, a title that isn't the one the user named — are the whole safety
 * story. Those are the assertions that matter here.
 *
 * OpenAI and ElevenLabs are mocked; nothing leaves the process. No database.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

// ─── Mocks (hoisted above the imports they replace) ─────────────────────────

const create = vi.hoisted(() => vi.fn());
const getOpenAI = vi.hoisted(() => vi.fn());

vi.mock('../src/modules/chat/llm.js', () => ({
  getOpenAI,
  CHAT_MODEL: 'gpt-4o-mini',
}));

const synthesize = vi.hoisted(() => vi.fn());
const isSpeechConfigured = vi.hoisted(() => vi.fn());

vi.mock('../src/modules/voice/tts.js', () => ({
  synthesize,
  isSpeechConfigured,
  modelFor: () => 'eleven_v3',
  MAX_SPEECH_CHARS: 900,
}));

const { app } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { resetRateLimits } = await import('../src/middleware/rateLimit.js');
const { runVoiceTurn } = await import('../src/modules/voice/agent.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TASK_ID = 'task-1';
const EVENT_ID = 'event-1';
const DONE_TASK_ID = 'task-done';

const SNAPSHOT = {
  tasks: [
    { id: TASK_ID, title: 'Buy milk', notes: null, dueAt: null, isDone: false },
    { id: DONE_TASK_ID, title: 'Call the bank', notes: null, dueAt: null, isDone: true },
  ],
  events: [
    {
      id: EVENT_ID,
      title: 'Standup',
      note: null,
      startsAt: '2026-03-02T09:00:00.000Z',
      endsAt: '2026-03-02T09:15:00.000Z',
    },
  ],
};

const NOW = new Date('2026-03-01T12:00:00.000Z');

function turnInput(overrides: Record<string, unknown> = {}) {
  return {
    text: 'do the thing',
    language: 'en',
    timezone: 'UTC',
    now: NOW,
    history: [],
    snapshot: SNAPSHOT,
    ...overrides,
  } as Parameters<typeof runVoiceTurn>[0];
}

/** One assistant turn that says something and calls nothing. */
function says(content: string) {
  return { choices: [{ message: { content, tool_calls: [] } }] };
}

/** One assistant turn that calls tools. `args` is passed through verbatim. */
function calls(
  toolCalls: { id?: string; name: string; args: unknown }[],
  content: string | null = null,
) {
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: toolCalls.map((c, i) => ({
            id: c.id ?? `call-${i}`,
            type: 'function',
            function: {
              name: c.name,
              arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args),
            },
          })),
        },
      },
    ],
  };
}

/** The messages array handed to OpenAI on a given round. */
function messagesOnRound(round: number) {
  return create.mock.calls[round]![0].messages as { role: string; content: string }[];
}

const originalKey = config.OPENAI_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  config.OPENAI_API_KEY = 'test-key';
  getOpenAI.mockReturnValue({ chat: { completions: { create } } });
  isSpeechConfigured.mockReturnValue(true);
  synthesize.mockResolvedValue(Buffer.from('fake-mp3-bytes'));
});

afterAll(() => {
  config.OPENAI_API_KEY = originalKey;
});

// ─── The turn: what comes back ───────────────────────────────────────────────

describe('runVoiceTurn — answering', () => {
  it('returns the reply and no actions when she only talks', async () => {
    create.mockResolvedValueOnce(says('You have one thing on today.'));

    const result = await runVoiceTurn(turnInput());

    expect(result.reply).toBe('You have one thing on today.');
    expect(result.actions).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('takes the closing line from the round after she acted', async () => {
    create
      .mockResolvedValueOnce(calls([{ name: 'create_task', args: { title: 'Water plants' } }], 'One sec'))
      .mockResolvedValueOnce(says('Added it to your list.'));

    const result = await runVoiceTurn(turnInput());

    expect(result.reply).toBe('Added it to your list.');
  });

  it('keeps what she said alongside the tool call if the closing round says nothing', async () => {
    create
      .mockResolvedValueOnce(calls([{ name: 'create_task', args: { title: 'Water plants' } }], 'Adding that now'))
      .mockResolvedValueOnce(says(''));

    const result = await runVoiceTurn(turnInput());

    expect(result.reply).toBe('Adding that now');
  });

  it('never lets the model call a tool on the closing round', async () => {
    create
      .mockResolvedValueOnce(calls([{ name: 'create_task', args: { title: 'Water plants' } }]))
      .mockResolvedValueOnce(says('Done.'));

    await runVoiceTurn(turnInput());

    expect(create.mock.calls[0]![0].tool_choice).toBe('auto');
    expect(create.mock.calls[1]![0].tool_choice).toBe('none');
  });

  it('answers every tool_call, so the next request is not rejected', async () => {
    create
      .mockResolvedValueOnce(
        calls([
          { id: 'a', name: 'create_task', args: { title: 'One' } },
          { id: 'b', name: 'create_task', args: { title: 'Two' } },
        ]),
      )
      .mockResolvedValueOnce(says('Both added.'));

    await runVoiceTurn(turnInput());

    const second = messagesOnRound(1) as { role: string; tool_call_id?: string }[];
    const answered = second.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(answered).toEqual(['a', 'b']);
  });
});

// ─── The turn: what she is allowed to change ─────────────────────────────────

describe('runVoiceTurn — collecting actions', () => {
  it('passes a create_task through with its arguments', async () => {
    create
      .mockResolvedValueOnce(
        calls([
          {
            name: 'create_task',
            args: { title: 'Water plants', dueAt: '2026-03-02T08:00:00+00:00', priority: 'High' },
          },
        ]),
      )
      .mockResolvedValueOnce(says('Added.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toHaveLength(1);
    expect(actions[0]!.tool).toBe('create_task');
    expect(actions[0]!.arguments).toMatchObject({
      title: 'Water plants',
      dueAt: '2026-03-02T08:00:00+00:00',
      priority: 'High',
    });
  });

  it('collects several actions from one turn', async () => {
    create
      .mockResolvedValueOnce(
        calls([
          { name: 'create_task', args: { title: 'One' } },
          { name: 'create_task', args: { title: 'Two' } },
        ]),
      )
      .mockResolvedValueOnce(says('Both added.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions.map((a) => a.arguments.title)).toEqual(['One', 'Two']);
  });

  it('accepts an update when the id and the title both match the agenda', async () => {
    create
      .mockResolvedValueOnce(
        calls([
          { name: 'update_task', args: { id: TASK_ID, matchTitle: 'Buy milk', title: 'Buy oat milk' } },
        ]),
      )
      .mockResolvedValueOnce(says('Renamed.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toHaveLength(1);
    expect(actions[0]!.arguments.title).toBe('Buy oat milk');
  });

  it('drops an action whose id is not in the snapshot', async () => {
    create
      .mockResolvedValueOnce(
        calls([{ name: 'delete_task', args: { id: 'invented-id', matchTitle: 'Buy milk' } }]),
      )
      .mockResolvedValueOnce(says('I could not find that.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toEqual([]);
  });

  it('tells the model why the id was refused, so it can ask instead of guessing', async () => {
    create
      .mockResolvedValueOnce(
        calls([{ id: 'z', name: 'delete_task', args: { id: 'invented-id', matchTitle: 'Buy milk' } }]),
      )
      .mockResolvedValueOnce(says('Which one did you mean?'));

    await runVoiceTurn(turnInput());

    const toolMsg = (messagesOnRound(1) as { role: string; content: string }[]).find(
      (m) => m.role === 'tool',
    )!;
    expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: false });
    expect(toolMsg.content).toContain('id');
  });

  it('drops an action whose title is not the one the user named', async () => {
    // The classic failure: asked to delete the bank meeting, it reaches for
    // the nearest row and announces it as the one they asked for.
    create
      .mockResolvedValueOnce(
        calls([{ name: 'delete_event', args: { id: EVENT_ID, matchTitle: 'Bank meeting' } }]),
      )
      .mockResolvedValueOnce(says('Nothing by that name.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toEqual([]);
  });

  it('matches titles the way a person hears them — case and spacing do not count', async () => {
    create
      .mockResolvedValueOnce(
        calls([{ name: 'complete_task', args: { id: TASK_ID, matchTitle: '  buy   MILK ' } }]),
      )
      .mockResolvedValueOnce(says('Ticked off.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toHaveLength(1);
    expect(actions[0]!.tool).toBe('complete_task');
  });

  it('will not take a task id for an event action', async () => {
    create
      .mockResolvedValueOnce(
        calls([{ name: 'delete_event', args: { id: TASK_ID, matchTitle: 'Buy milk' } }]),
      )
      .mockResolvedValueOnce(says('That is a task, not an event.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toEqual([]);
  });

  it('drops a tool it does not have', async () => {
    create
      .mockResolvedValueOnce(calls([{ name: 'send_email', args: { to: 'someone' } }]))
      .mockResolvedValueOnce(says('I cannot do that.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toEqual([]);
  });

  it('drops a tool call whose arguments are not JSON', async () => {
    create
      .mockResolvedValueOnce(calls([{ name: 'create_task', args: '{ not json' }]))
      .mockResolvedValueOnce(says('Say that again?'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toEqual([]);
  });

  it('drops an action that is missing a required argument', async () => {
    // matchTitle is what makes the mismatch check possible; without it the
    // action must not go through at all.
    create
      .mockResolvedValueOnce(calls([{ name: 'delete_task', args: { id: TASK_ID } }]))
      .mockResolvedValueOnce(says('Which one?'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toEqual([]);
  });

  it('drops a create_task with an empty title', async () => {
    create
      .mockResolvedValueOnce(calls([{ name: 'create_task', args: { title: '' } }]))
      .mockResolvedValueOnce(says('What should I call it?'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toEqual([]);
  });

  it('allows update_task to clear a due date with null', async () => {
    create
      .mockResolvedValueOnce(
        calls([{ name: 'update_task', args: { id: TASK_ID, matchTitle: 'Buy milk', dueAt: null } }]),
      )
      .mockResolvedValueOnce(says('Date removed.'));

    const { actions } = await runVoiceTurn(turnInput());

    expect(actions).toHaveLength(1);
    expect(actions[0]!.arguments.dueAt).toBeNull();
  });
});

// ─── The prompt: what she is told ────────────────────────────────────────────

describe('runVoiceTurn — the system prompt', () => {
  async function promptFor(input: Record<string, unknown> = {}): Promise<string> {
    create.mockResolvedValueOnce(says('ok'));
    await runVoiceTurn(turnInput(input));
    return messagesOnRound(0)[0]!.content;
  }

  it('lists the agenda with ids, so she never has to invent one', async () => {
    const prompt = await promptFor();

    expect(prompt).toContain(`[${TASK_ID}] Buy milk`);
    expect(prompt).toContain(`[${EVENT_ID}] Standup`);
  });

  it('marks a finished task as done', async () => {
    const prompt = await promptFor();

    expect(prompt).toContain('Call the bank — due no date (done)');
  });

  it('tells her a finished task means a new one, not a reopened one', async () => {
    const prompt = await promptFor();

    expect(prompt).toContain('create_task for a new one');
  });

  it('says "(none)" rather than nothing when there is no agenda', async () => {
    const prompt = await promptFor({ snapshot: { tasks: [], events: [] } });

    expect(prompt).toContain('TASKS:\n- (none)');
    expect(prompt).toContain('CALENDAR:\n- (none)');
  });

  it('spells out today and tomorrow with their dates', async () => {
    const prompt = await promptFor();

    expect(prompt).toContain('- Today: Sunday 2026-03-01');
    expect(prompt).toContain('- Tomorrow: Monday 2026-03-02');
  });

  it('names the language she has to answer in', async () => {
    const prompt = await promptFor({ language: 'he' });

    expect(prompt).toContain('Always answer in Hebrew');
  });

  it('falls back to English for a language it has no name for', async () => {
    const prompt = await promptFor({ language: 'xx' });

    expect(prompt).toContain('Always answer in English');
  });

  it('uses the name the device sent', async () => {
    const prompt = await promptFor({ userName: 'Dana' });

    expect(prompt).toContain("Dana's personal assistant");
  });

  it('resolves times against the caller timezone, not the server', async () => {
    const prompt = await promptFor({ timezone: 'Asia/Tokyo' });

    // 12:00 UTC on the 1st is already the 1st, 21:00, in Tokyo.
    expect(prompt).toContain('(Asia/Tokyo)');
    expect(prompt).toContain('9:00 PM');
  });

  it('replays earlier turns in order, before what was just said', async () => {
    create.mockResolvedValueOnce(says('ok'));
    await runVoiceTurn(
      turnInput({
        text: 'and the one after that?',
        history: [
          { role: 'user', content: 'what is next?' },
          { role: 'assistant', content: 'Standup at nine.' },
        ],
      }),
    );

    const messages = messagesOnRound(0);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[3]!.content).toBe('and the one after that?');
  });
});

// ─── POST /voice/turn ────────────────────────────────────────────────────────

describe('POST /voice/turn', () => {
  const body = {
    text: 'what is on today?',
    language: 'en',
    timezone: 'UTC',
    now: NOW.toISOString(),
    snapshot: SNAPSHOT,
  };

  it('answers with the reply, the actions and whether she can speak', async () => {
    create.mockResolvedValueOnce(says('Just standup at nine.'));

    const res = await request(app).post('/voice/turn').send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reply: 'Just standup at nine.',
      actions: [],
      canSpeak: true,
    });
  });

  it('reports canSpeak false when no voice is configured', async () => {
    isSpeechConfigured.mockReturnValue(false);
    create.mockResolvedValueOnce(says('Just standup at nine.'));

    const res = await request(app).post('/voice/turn').send(body);

    expect(res.body.canSpeak).toBe(false);
  });

  it('runs without a snapshot — a new device has nothing to send', async () => {
    create.mockResolvedValueOnce(says('Nothing yet.'));

    const res = await request(app).post('/voice/turn').send({ text: 'anything on?' });

    expect(res.status).toBe(200);
  });

  it('rejects an empty text', async () => {
    const res = await request(app).post('/voice/turn').send({ ...body, text: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a text longer than the cap', async () => {
    const res = await request(app)
      .post('/voice/turn')
      .send({ ...body, text: 'a'.repeat(2001) });

    expect(res.status).toBe(400);
  });

  it('rejects a language it does not speak', async () => {
    const res = await request(app).post('/voice/turn').send({ ...body, language: 'de' });

    expect(res.status).toBe(400);
  });

  it('rejects more history than it will carry', async () => {
    const history = Array.from({ length: 21 }, () => ({ role: 'user', content: 'hi' }));

    const res = await request(app).post('/voice/turn').send({ ...body, history });

    expect(res.status).toBe(400);
  });

  it('says the assistant is unconfigured rather than 500ing without a key', async () => {
    config.OPENAI_API_KEY = undefined;

    const res = await request(app).post('/voice/turn').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not configured');
    expect(create).not.toHaveBeenCalled();
  });

  it('rate-limits the route: the 31st call in a minute is refused', async () => {
    create.mockResolvedValue(says('ok'));

    for (let i = 0; i < 30; i++) {
      const ok = await request(app).post('/voice/turn').send(body);
      expect(ok.status).toBe(200);
    }

    const blocked = await request(app).post('/voice/turn').send(body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

// ─── GET /voice/speak ────────────────────────────────────────────────────────

describe('GET /voice/speak', () => {
  it('returns the audio itself, as something a player can stream', async () => {
    const res = await request(app).get('/voice/speak').query({ text: 'Hello there' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['content-length']).toBe('14');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  it('passes the language through to the voice', async () => {
    await request(app).get('/voice/speak').query({ text: 'שלום', language: 'he' });

    expect(synthesize).toHaveBeenCalledWith('שלום', 'he');
  });

  it('defaults to English when no language is given', async () => {
    await request(app).get('/voice/speak').query({ text: 'Hello' });

    expect(synthesize).toHaveBeenCalledWith('Hello', 'en');
  });

  it('rejects a missing text', async () => {
    const res = await request(app).get('/voice/speak');

    expect(res.status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('rejects a line too long to speak', async () => {
    const res = await request(app)
      .get('/voice/speak')
      .query({ text: 'a'.repeat(901) });

    expect(res.status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('rate-limits speech harder than chat: the 11th call in a minute is refused', async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await request(app).get('/voice/speak').query({ text: 'Hello' });
      expect(ok.status).toBe(200);
    }

    const blocked = await request(app).get('/voice/speak').query({ text: 'Hello' });
    expect(blocked.status).toBe(429);
  });
});
