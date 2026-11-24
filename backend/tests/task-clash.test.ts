/**
 * Two tasks at one time — or a task in the middle of a meeting — are asked
 * about, not added. The model is told what is already there; it adds the task
 * only after the user says to keep the time (`confirmedClash`).
 */
import { describe, it, expect } from 'vitest';
import {
  executeToolCall,
  type Snapshot,
  type VoiceAction,
  type VoiceTurnInput,
} from '../src/modules/voice/agent.js';

const ZONE = 'Asia/Jerusalem';
// Wed 2026-07-29 14:00 in Jerusalem (UTC+3 in summer).
const NOW = new Date('2026-07-29T11:00:00Z');

function snapshot(): Snapshot {
  return {
    tasks: [
      { id: 't1', title: 'להתקשר לרופא', dueAt: '2026-07-30T10:00:00+03:00', isDone: false },
      { id: 't2', title: 'לשלם חשמל', dueAt: '2026-07-30T12:00:00+03:00', isDone: true },
      { id: 't3', title: 'לקנות מתנה', dueAt: '2026-07-31T00:00:00+03:00', isDone: false },
    ],
    events: [
      {
        id: 'e1',
        title: 'ישיבת צוות',
        startsAt: '2026-07-30T15:00:00+03:00',
        endsAt: '2026-07-30T16:00:00+03:00',
      },
    ],
    shopping: [],
    money: [],
    debts: [],
    budgets: {},
    currency: 'ILS',
  } as Snapshot;
}

const input = (): VoiceTurnInput => ({
  text: '',
  language: 'he',
  timezone: ZONE,
  now: NOW,
  history: [],
  snapshot: snapshot(),
});

async function call(name: string, args: Record<string, unknown>) {
  const actions: VoiceAction[] = [];
  const { content } = await executeToolCall(name, JSON.stringify(args), input(), actions);
  return { result: JSON.parse(content), actions };
}

describe('a task on a time that is already taken', () => {
  it('is not added when another open task is at the same time', async () => {
    const { result, actions } = await call('create_task', {
      title: 'לאסוף חבילה',
      dueAt: '2026-07-30T10:00:00+03:00',
    });
    expect(actions).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.error).toContain('להתקשר לרופא');
    expect(result.instruction).toContain('confirmedClash');
  });

  it('counts a task within half an hour as the same time', async () => {
    const { actions } = await call('create_task', { title: 'X', dueAt: '2026-07-30T10:20:00+03:00' });
    expect(actions).toHaveLength(0);
  });

  it('is added when it is half an hour or more away', async () => {
    const { actions } = await call('create_task', { title: 'X', dueAt: '2026-07-30T10:30:00+03:00' });
    expect(actions.map((a) => a.tool)).toEqual(['create_task']);
  });

  it('is not added in the middle of a meeting', async () => {
    const { result, actions } = await call('create_task', {
      title: 'לשלוח מייל',
      dueAt: '2026-07-30T15:30:00+03:00',
    });
    expect(actions).toHaveLength(0);
    expect(result.error).toContain('ישיבת צוות');
  });

  it('is added once the user said to keep the time', async () => {
    const { actions } = await call('create_task', {
      title: 'לאסוף חבילה',
      dueAt: '2026-07-30T10:00:00+03:00',
      confirmedClash: true,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.arguments.confirmedClash).toBe(true);
  });

  it('ignores a task that is already done', async () => {
    const { actions } = await call('create_task', { title: 'X', dueAt: '2026-07-30T12:00:00+03:00' });
    expect(actions).toHaveLength(1);
  });

  it('does not treat a date with no hour as a time', async () => {
    const { actions } = await call('create_task', { title: 'X', dueAt: '2026-07-31T00:00:00+03:00' });
    expect(actions).toHaveLength(1);
  });

  it('lets a task with no date through', async () => {
    const { actions } = await call('create_task', { title: 'X' });
    expect(actions).toHaveLength(1);
  });

  it('does not clash a moved task with itself', async () => {
    const { actions } = await call('update_task', {
      id: 't1',
      matchTitle: 'להתקשר לרופא',
      dueAt: '2026-07-30T10:15:00+03:00',
    });
    expect(actions.map((a) => a.tool)).toEqual(['update_task']);
  });

  it('stops a task moved onto another one', async () => {
    const { actions, result } = await call('update_task', {
      id: 't1',
      matchTitle: 'להתקשר לרופא',
      dueAt: '2026-07-30T15:00:00+03:00',
    });
    expect(actions).toHaveLength(0);
    expect(result.error).toContain('ישיבת צוות');
  });
});
