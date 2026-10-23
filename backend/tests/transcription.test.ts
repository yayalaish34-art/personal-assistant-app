import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config, configSchema } from '../src/config.js';
import { transcribeAudio } from '../src/modules/speech/transcribe.js';
import { runVoiceTurn, profileSchema, snapshotSchema } from '../src/modules/voice/agent.js';
import { speechRequest } from '../src/modules/voice/tts.js';

const mocks = vi.hoisted(() => ({ transcribe: vi.fn(), complete: vi.fn() }));
vi.mock('../src/modules/chat/llm.js', () => ({
  CHAT_MODEL: 'test',
  getOpenAI: () => ({ audio: { transcriptions: { create: mocks.transcribe } }, chat: { completions: { create: mocks.complete } } }),
}));
beforeEach(() => { vi.clearAllMocks(); });
const audio = () => ({ buffer: Buffer.from('mock audio'), originalname: 'speech.webm', mimetype: 'audio/webm' });

describe('cost-controlled transcription', () => {
  it('defaults to the mini transcriber and supports an explicit quality upgrade', () => {
    const base = { JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) };
    expect(configSchema.parse(base).OPENAI_TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    expect(configSchema.parse({ ...base, OPENAI_TRANSCRIBE_MODEL: 'gpt-4o-transcribe' }).OPENAI_TRANSCRIBE_MODEL).toBe('gpt-4o-transcribe');
  });
  it('passes the language and Hebrew context, preserving correct multiword item names', async () => {
    mocks.transcribe.mockResolvedValueOnce({ text: ' תוסיפי מיץ ענבים לרשימת הקניות ' });
    const recording = audio();
    expect(await transcribeAudio(recording, 'he')).toBe('תוסיפי מיץ ענבים לרשימת הקניות');
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      model: config.OPENAI_TRANSCRIBE_MODEL, language: 'he', response_format: 'json',
      temperature: 0, prompt: expect.stringContaining('עברית'),
    }), { timeout: 25000, maxRetries: 0 });
    expect(recording.buffer.length).toBe(0);
  });
  it('does not suppress a genuine goodbye and leaves uncertain audio empty', async () => {
    mocks.transcribe.mockResolvedValueOnce({ text: 'תודה רבה ביי' });
    expect(await transcribeAudio(audio(), 'he')).toBe('תודה רבה ביי');
    mocks.transcribe.mockResolvedValueOnce({ text: '  ' });
    expect(await transcribeAudio(audio(), 'he')).toBe('');
  });
  it('releases recordings on provider failure without a paid fallback call', async () => {
    const recording = audio();
    mocks.transcribe.mockRejectedValueOnce(new Error('timeout'));
    await expect(transcribeAudio(recording, 'he')).rejects.toThrow('timeout');
    expect(recording.buffer.length).toBe(0);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
  });
  it('does not send empty recordings to the provider', async () => {
    expect(await transcribeAudio({ ...audio(), buffer: Buffer.alloc(0) }, 'he')).toBe('');
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

describe('Hebrew assistant integration', () => {
  it('passes personalization and history through the tool loop without inventing a price', async () => {
    mocks.complete.mockResolvedValueOnce({ choices: [{ message: {
      role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'call1', function: {
        name: 'add_shopping_item', arguments: JSON.stringify({ name: 'מיץ ענבים', price: 15 }),
      } }],
    } }] }).mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'הוספתי מיץ ענבים לרשימת הקניות.' } }] });
    const result = await runVoiceTurn({
      text: 'תוסיפי מיץ ענבים', language: 'he', timezone: 'Asia/Jerusalem', now: new Date('2026-10-19T10:00:00Z'),
      snapshot: snapshotSchema.parse({}), history: [{ role: 'user', content: 'אני מתכנן קניות' }],
      profile: profileSchema.parse({ workDays: [0, 2, 4], focusPeriod: 'morning', primaryGoal: 'lessStress', sleepQuality: 'tired', assistanceStyle: 'guided' }),
    });
    expect(result.actions).toEqual([{ tool: 'add_shopping_item', arguments: { name: 'מיץ ענבים' } }]);
    const messages = mocks.complete.mock.calls[0][0].messages;
    expect(messages[0].content).toContain('Hebrew');
    expect(messages[0].content).toContain('Sunday, Tuesday, Thursday');
    expect(messages[0].content).toContain('Best focus period: morning');
    expect(messages[0].content).toContain('lessStress');
    expect(messages[0].content).toContain('guided');
    expect(messages[1]).toEqual({ role: 'user', content: 'אני מתכנן קניות' });
    expect(result.reply).toBe('הוספתי מיץ ענבים לרשימת הקניות.');
  });
  it('rejects invalid new profile answers while accepting older clients', () => {
    expect(profileSchema.safeParse({}).success).toBe(true);
    expect(profileSchema.safeParse({ workDays: [7] }).success).toBe(false);
    expect(profileSchema.safeParse({ sleepQuality: 'diagnosis' }).success).toBe(false);
  });
  it('enforces Hebrew pronunciation for Hebrew speech on both TTS paths', () => {
    expect(speechRequest('הוספתי מיץ ענבים')).toEqual({ text: 'הוספתי מיץ ענבים', model_id: config.ELEVENLABS_MODEL_ID, language_code: 'he' });
    expect(speechRequest('Added grape juice')).not.toHaveProperty('language_code');
  });
});
