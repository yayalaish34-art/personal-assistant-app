/**
 * gift-detour.test.ts — the exact scenario the user described:
 *   "She notices I have an hour between two meetings, and I'm 5 min
 *    from Kenyon HaZahav. She asks if I want to stop and buy a gift
 *    for a friend."
 *
 * We simulate that end-to-end: real local index, real
 * answerSuggestOpportunity, snapshot with a 1h window and a gift errand,
 * and inspect the fit the agent actually returns.
 */

import { describe, it, expect } from 'vitest';
import {
  answerSuggestOpportunity,
  computeOpportunityNudge,
  type VoiceTurnInput,
} from '../src/modules/voice/agent.js';

// A real point in the dataset — Allenby/Rothschild area in Tel Aviv.
// Dizengoff Center sits ~1.5–2 km north. Five minutes of driving.
const USER_HERE = { latitude: 32.0640, longitude: 34.7725 };

function baseInput(overrides: Partial<VoiceTurnInput> = {}): VoiceTurnInput {
  // 13:05 Jerusalem time on a Wednesday.
  const now = new Date('2026-07-29T10:05:00Z');
  return {
    text: 'יש לי שעה פנויה',
    language: 'he',
    timezone: 'Asia/Jerusalem',
    now,
    history: [],
    snapshot: {
      tasks: [],
      events: [
        // Just-finished meeting (ended 13:00 local).
        { id: 'past', title: 'Standup', startsAt: '2026-07-29T09:30:00Z', endsAt: '2026-07-29T10:00:00Z' },
        // Next meeting at 14:00 local — a 55-min free window right now.
        { id: 'next', title: 'Eliran', startsAt: '2026-07-29T11:00:00Z', endsAt: '2026-07-29T12:00:00Z' },
      ],
      shopping: [],
      money: [],
      debts: [],
      budgets: {},
      currency: 'ILS',
    },
    location: { latitude: USER_HERE.latitude, longitude: USER_HERE.longitude, city: 'Tel Aviv' },
    ...overrides,
  };
}

describe("the agent's 'buy a gift between meetings' moment", () => {
  it('an ad-hoc gift errand as a TASK (not in the grocery list) — now triggers errand_detour', async () => {
    // She says "לקנות מתנה לרונית" — a task on her list, not a grocery item.
    // Before: handler returned quiet_window (no concrete offer).
    // After: errand classifier maps "מתנה" → mall → nearby mall suggested.
    const input = baseInput({
      snapshot: {
        tasks: [
          { id: 't1', title: 'לקנות מתנה לרונית', isDone: false },
        ],
        events: [
          { id: 'past', title: 'Standup', startsAt: '2026-07-29T09:30:00Z', endsAt: '2026-07-29T10:00:00Z' },
          { id: 'next', title: 'Eliran', startsAt: '2026-07-29T11:00:00Z', endsAt: '2026-07-29T12:00:00Z' },
        ],
        shopping: [],
        money: [],
        debts: [],
        budgets: {},
        currency: 'ILS',
      },
    });
    const actions: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await answerSuggestOpportunity({ minWindowMinutes: 20 }, input, actions as any);
    const result = JSON.parse(raw);
    console.log('\n[gift as TASK] →', JSON.stringify(result, null, 2));
    expect(result.fit?.kind).toBe('errand_detour');
    expect(result.fit.task.title).toBe('לקנות מתנה לרונית');
    expect(result.fit.errandType).toBe('gift');
    expect(result.fit.place.name).toBeTruthy();
  });

  it('WORKAROUND: gift written as a shopping-list item', async () => {
    // Same window, same location — but she wrote "מתנה לחברה" into the list.
    const input = baseInput({
      snapshot: {
        tasks: [],
        events: [
          { id: 'past', title: 'Standup', startsAt: '2026-07-29T09:30:00Z', endsAt: '2026-07-29T10:00:00Z' },
          { id: 'next', title: 'Eliran', startsAt: '2026-07-29T11:00:00Z', endsAt: '2026-07-29T12:00:00Z' },
        ],
        shopping: [{ id: 's1', name: 'מתנה לחברה', isBought: false }],
        money: [],
        debts: [],
        budgets: {},
        currency: 'ILS',
      },
    });
    const actions: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await answerSuggestOpportunity({ minWindowMinutes: 20 }, input, actions as any);
    const result = JSON.parse(raw);
    console.log('\n[gift AS shopping-list item] →', JSON.stringify(result, null, 2));
    if (result.fit?.kind === 'shopping_detour') {
      console.log('  → place:', result.fit.place);
      console.log('  → items:', result.fit.items);
      console.log('  → window:', result.fit.windowMinutes, 'min');
      console.log('  → estimated:', result.fit.estimatedMinutes, 'min');
    }
    // This should fire: she has a window, a nearby place, and an unbought item.
    expect(result.ok).toBe(true);
  });

  it('proactive nudge: computeOpportunityNudge produces the same offer for a background job', async () => {
    // The device's background job hands the same inputs to this function to
    // get a push body it can display without the model being in the loop.
    const input = baseInput({
      snapshot: {
        tasks: [{ id: 't1', title: 'לקנות מתנה לרונית', isDone: false }],
        events: [
          { id: 'past', title: 'Standup', startsAt: '2026-07-29T09:30:00Z', endsAt: '2026-07-29T10:00:00Z' },
          { id: 'next', title: 'Eliran', startsAt: '2026-07-29T11:00:00Z', endsAt: '2026-07-29T12:00:00Z' },
        ],
        shopping: [],
        money: [],
        debts: [],
        budgets: {},
        currency: 'ILS',
      },
    });
    const nudge = await computeOpportunityNudge(input);
    console.log('\n[nudge] →', JSON.stringify(nudge, null, 2));
    expect(nudge.shouldNudge).toBe(true);
    expect(nudge.taskId).toBe('t1');
    expect(nudge.errandType).toBe('gift');
    expect(nudge.body).toContain('מתנה');
    expect(nudge.body).toContain(nudge.placeName!);
  });

  it("proactive nudge: stays silent when there's no concrete fit", async () => {
    // No errand tasks, no shopping items — just a quiet window. The device
    // then shows its plain "N min free" message rather than fabricating one.
    const nudge = await computeOpportunityNudge(baseInput());
    expect(nudge.shouldNudge).toBe(false);
  });
});
