/**
 * voiceAgentTools.test.ts — Unit tests for the voice agent's new synthesis
 * tools: the handlers that compute something from the snapshot and feed the
 * result back to the model.
 *
 * Pure where possible. Tools that reach the network (`check_weather`,
 * `suggest_opportunity` when a GPS fix is present) are only exercised on their
 * no-network branches — the external services are tested where they live, not
 * here.
 */

import { describe, it, expect } from 'vitest';
import {
  answerSpendingTrends,
  answerUpcomingDebits,
  answerBudgetAlert,
  answerWeeklySummary,
  answerClusterErrands,
  answerEndOfDay,
  answerSuggestOpportunity,
  answerCheckWeather,
  answerPlanRecurringGoal,
  answerReplanRemainder,
  type Snapshot,
  type VoiceTurnInput,
} from '../src/modules/voice/agent.js';

const ZONE = 'Asia/Jerusalem';
// Pin now to a known mid-week moment: Wed 2026-07-29 14:00 local Jerusalem
// (= 11:00 UTC in DST). Deterministic across machines.
const NOW = new Date('2026-07-29T11:00:00Z');

/** Minimum valid snapshot, add fields in each test as needed. */
function baseSnapshot(): Snapshot {
  return {
    tasks: [],
    events: [],
    shopping: [],
    money: [],
    debts: [],
    budgets: {},
    currency: 'ILS',
  };
}

function baseInput(overrides: Partial<VoiceTurnInput> = {}): VoiceTurnInput {
  return {
    text: '',
    language: 'he',
    timezone: ZONE,
    now: NOW,
    history: [],
    snapshot: baseSnapshot(),
    ...overrides,
  };
}

// ─── spending_trends ────────────────────────────────────────────────────────

describe('answerSpendingTrends', () => {
  it('flags a food category that climbed by more than 15% AND ≥ 50 ILS', () => {
    const snap = baseSnapshot();
    // Last month: ₪200 on food.
    snap.money.push(
      { id: 'a', kind: 'expense', description: 'burger', amount: 100, date: '2026-06-10', category: 'food' },
      { id: 'b', kind: 'expense', description: 'pizza', amount: 100, date: '2026-06-20', category: 'food' },
    );
    // This month: ₪300 on food — +50%, +100 ILS. Should flag.
    snap.money.push(
      { id: 'c', kind: 'expense', description: 'sushi', amount: 150, date: '2026-07-05', category: 'food' },
      { id: 'd', kind: 'expense', description: 'burger', amount: 150, date: '2026-07-25', category: 'food' },
    );
    const result = JSON.parse(answerSpendingTrends({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.climbing.length).toBeGreaterThanOrEqual(1);
    const food = result.climbing.find((f: { category: string }) => f.category === 'food');
    expect(food).toBeTruthy();
    expect(food.change).toContain('%');
  });

  it('ignores a jump below the 50-ILS absolute floor', () => {
    const snap = baseSnapshot();
    snap.money.push(
      { id: 'a', kind: 'expense', description: 'coffee', amount: 10, date: '2026-06-10', category: 'fun' },
      { id: 'b', kind: 'expense', description: 'coffee', amount: 40, date: '2026-07-10', category: 'fun' },
    );
    const result = JSON.parse(answerSpendingTrends({}, baseInput({ snapshot: snap })));
    expect(result.climbing).toHaveLength(0);
  });

  it('surfaces an improvement when a category dropped meaningfully', () => {
    const snap = baseSnapshot();
    snap.money.push(
      { id: 'a', kind: 'expense', description: 'uber', amount: 300, date: '2026-06-05', category: 'transport' },
      { id: 'b', kind: 'expense', description: 'uber', amount: 100, date: '2026-07-05', category: 'transport' },
    );
    const result = JSON.parse(answerSpendingTrends({}, baseInput({ snapshot: snap })));
    expect(result.improving.length).toBeGreaterThanOrEqual(1);
    expect(result.improving[0].category).toBe('transport');
  });

  it('says there is nothing to analyse when neither month has data', () => {
    const result = JSON.parse(answerSpendingTrends({}, baseInput()));
    expect(result.ok).toBe(true);
    // The no-data branch returns a short-circuit shape with findings[] and a note.
    expect(result.findings).toEqual([]);
    expect(result.note).toMatch(/no spending/i);
  });
});

// ─── upcoming_debits ────────────────────────────────────────────────────────

describe('answerUpcomingDebits', () => {
  it('detects a recurring Spotify charge from two months of history', () => {
    const snap = baseSnapshot();
    snap.money.push(
      { id: '1', kind: 'expense', description: 'Spotify', amount: 20, date: '2026-05-05', category: 'bills' },
      { id: '2', kind: 'expense', description: 'Spotify', amount: 20, date: '2026-06-05', category: 'bills' },
      { id: '3', kind: 'expense', description: 'Spotify', amount: 20, date: '2026-07-05', category: 'bills' },
    );
    const result = JSON.parse(answerUpcomingDebits({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.upcoming.length).toBeGreaterThanOrEqual(1);
    const spot = result.upcoming.find((u: { description: string }) => u.description === 'Spotify');
    expect(spot).toBeTruthy();
    expect(spot.expectedDate).toMatch(/^2026-08-05$/); // next month, same day
  });

  it('skips one-off charges that only appear once', () => {
    const snap = baseSnapshot();
    snap.money.push(
      { id: '1', kind: 'expense', description: 'Dentist', amount: 400, date: '2026-07-20', category: 'health' },
    );
    const result = JSON.parse(answerUpcomingDebits({}, baseInput({ snapshot: snap })));
    expect(result.upcoming).toEqual([]);
  });

  it('reports no recurring charges when nothing qualifies', () => {
    const snap = baseSnapshot();
    snap.money.push(
      { id: '1', kind: 'expense', description: 'coffee', amount: 15, date: '2026-07-01' },
    );
    const result = JSON.parse(answerUpcomingDebits({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.upcoming).toEqual([]);
  });
});

// ─── budget_alert ───────────────────────────────────────────────────────────

describe('answerBudgetAlert', () => {
  it('flags a category already over its limit', () => {
    const snap = baseSnapshot();
    snap.budgets = { food: 500 };
    snap.money.push(
      { id: '1', kind: 'expense', description: 'market', amount: 600, date: '2026-07-20', category: 'food' },
    );
    const result = JSON.parse(answerBudgetAlert({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].category).toBe('food');
    expect(result.findings[0].severity).toBe('overrun');
  });

  it('flags a projected overrun at mid-month pace', () => {
    // NOW is 2026-07-29 — day 29 of 31. We're almost through the month.
    // Spent 450 on a 500 budget → 90% through, projected 481 → within the 10%
    // safety band so it should NOT flag as risk; but 450 is still ≥ 90% so
    // the "near-limit" branch kicks in.
    const snap = baseSnapshot();
    snap.budgets = { food: 500 };
    snap.money.push(
      { id: '1', kind: 'expense', description: 'market', amount: 450, date: '2026-07-15', category: 'food' },
    );
    const result = JSON.parse(answerBudgetAlert({}, baseInput({ snapshot: snap })));
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].severity).toBe('risk');
  });

  it('stays quiet when there are no budgets set at all', () => {
    const result = JSON.parse(answerBudgetAlert({}, baseInput()));
    expect(result.findings).toEqual([]);
  });

  it('stays quiet when every budget is on track', () => {
    const snap = baseSnapshot();
    snap.budgets = { food: 500 };
    snap.money.push(
      { id: '1', kind: 'expense', description: 'market', amount: 100, date: '2026-07-10', category: 'food' },
    );
    const result = JSON.parse(answerBudgetAlert({}, baseInput({ snapshot: snap })));
    expect(result.findings).toEqual([]);
  });
});

// ─── weekly_summary ─────────────────────────────────────────────────────────

describe('answerWeeklySummary', () => {
  it('sums the week\'s money and names the biggest category', () => {
    const snap = baseSnapshot();
    // Week containing 2026-07-29 (Wed): Sunday 2026-07-26 → Saturday 2026-08-01.
    snap.money.push(
      { id: '1', kind: 'income', description: 'salary', amount: 10000, date: '2026-07-27', category: 'salary' },
      { id: '2', kind: 'expense', description: 'rent', amount: 4000, date: '2026-07-28', category: 'housing' },
      { id: '3', kind: 'expense', description: 'market', amount: 200, date: '2026-07-29', category: 'food' },
    );
    const result = JSON.parse(answerWeeklySummary({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.weekStart).toBe('2026-07-26');
    expect(result.weekEnd).toBe('2026-08-01');
    expect(result.money.income).toContain('10000');
    expect(result.money.spent).toContain('4200');
    expect(result.money.biggestCategory.name).toBe('housing');
  });

  it('counts finished tasks dated this week', () => {
    const snap = baseSnapshot();
    snap.tasks.push(
      { id: '1', title: 'Call dentist', dueAt: '2026-07-27T10:00:00+03:00', isDone: true },
      { id: '2', title: 'Email Dad', dueAt: '2026-07-28T10:00:00+03:00', isDone: false },
    );
    const result = JSON.parse(answerWeeklySummary({}, baseInput({ snapshot: snap })));
    expect(result.tasks.finished).toBe(1);
    expect(result.tasks.stillOpen).toBe(1);
  });
});

// ─── cluster_errands ────────────────────────────────────────────────────────

describe('answerClusterErrands', () => {
  it('clusters two events in the same city on different days', () => {
    const snap = baseSnapshot();
    snap.events.push(
      {
        id: 'e1',
        title: 'Client A',
        startsAt: '2026-07-31T10:00:00+03:00',
        location: 'Beer Sheva, Industrial Zone',
      },
      {
        id: 'e2',
        title: 'Client B',
        startsAt: '2026-08-02T14:00:00+03:00',
        location: 'Beer Sheva, HaNassi 7',
      },
    );
    const result = JSON.parse(answerClusterErrands({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].city).toBe('beer sheva');
    expect(result.clusters[0].spansDays).toBe(true);
    expect(result.clusters[0].events.length).toBe(2);
  });

  it('ignores events without a location set', () => {
    const snap = baseSnapshot();
    snap.events.push(
      { id: 'e1', title: 'Meeting', startsAt: '2026-07-31T10:00:00+03:00' },
      { id: 'e2', title: 'Another', startsAt: '2026-08-01T10:00:00+03:00' },
    );
    const result = JSON.parse(answerClusterErrands({}, baseInput({ snapshot: snap })));
    expect(result.clusters).toEqual([]);
  });

  it('does not cluster a single event even if it has a location', () => {
    const snap = baseSnapshot();
    snap.events.push({
      id: 'e1',
      title: 'Lone meeting',
      startsAt: '2026-07-31T10:00:00+03:00',
      location: 'Tel Aviv',
    });
    const result = JSON.parse(answerClusterErrands({}, baseInput({ snapshot: snap })));
    expect(result.clusters).toEqual([]);
  });
});

// ─── end_of_day ─────────────────────────────────────────────────────────────

describe('answerEndOfDay', () => {
  it('separates today\'s done from today\'s open tasks', () => {
    const snap = baseSnapshot();
    // dueAt in Asia/Jerusalem on 2026-07-29.
    snap.tasks.push(
      { id: '1', title: 'Reply to Noa', dueAt: '2026-07-29T09:00:00+03:00', isDone: true },
      { id: '2', title: 'Draft deck', dueAt: '2026-07-29T15:00:00+03:00', isDone: true },
      { id: '3', title: 'Call plumber', dueAt: '2026-07-29T17:00:00+03:00', isDone: false },
    );
    const result = JSON.parse(answerEndOfDay({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.today.tasksDone).toBe(2);
    expect(result.today.tasksOpen).toBe(1);
    expect(result.today.openTitles[0].title).toBe('Call plumber');
  });

  it('names tomorrow\'s first event', () => {
    const snap = baseSnapshot();
    snap.events.push(
      {
        id: 'e1',
        title: 'Dentist',
        startsAt: '2026-07-30T09:00:00+03:00',
      },
      {
        id: 'e2',
        title: 'Lunch with Dani',
        startsAt: '2026-07-30T13:00:00+03:00',
      },
    );
    const result = JSON.parse(answerEndOfDay({}, baseInput({ snapshot: snap })));
    expect(result.tomorrow.first.title).toBe('Dentist');
    expect(result.tomorrow.eventCount).toBe(2);
  });

  it('reports a quiet day plainly', () => {
    const result = JSON.parse(answerEndOfDay({}, baseInput()));
    expect(result.ok).toBe(true);
    expect(result.today.tasksDone).toBe(0);
    expect(result.today.tasksOpen).toBe(0);
    expect(result.instruction).toMatch(/quiet/i);
  });
});

// ─── suggest_opportunity (no-location branch) ───────────────────────────────

describe('answerSuggestOpportunity', () => {
  it('returns a null fit with an explanatory note when GPS is missing', async () => {
    const result = JSON.parse(await answerSuggestOpportunity({}, baseInput()));
    expect(result.ok).toBe(true);
    expect(result.fit).toBeNull();
    expect(result.note).toMatch(/GPS|location/i);
  });
});

// ─── check_weather (no-location branch) ─────────────────────────────────────

describe('answerCheckWeather', () => {
  it('errors cleanly without a GPS fix', async () => {
    const result = JSON.parse(await answerCheckWeather({}, baseInput()));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/location/i);
  });
});

// ─── plan_recurring_goal (no-events case) ───────────────────────────────────

describe('answerPlanRecurringGoal', () => {
  it('finds slots on an empty calendar and spreads them across days', async () => {
    const result = JSON.parse(
      await answerPlanRecurringGoal(
        { title: 'workout', timesPerWeek: 3, durationMinutes: 45 },
        baseInput(),
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.goalTitle).toBe('workout');
    expect(result.proposed.length).toBeGreaterThanOrEqual(1);
    // Each proposed slot should be on a distinct day until the count forces a
    // double-up — with an empty calendar, 3 distinct days is the expectation.
    const days = new Set(result.proposed.map((p: { date: string }) => p.date));
    expect(days.size).toBe(result.proposed.length);
  });

  it('rejects a request with an empty title', async () => {
    const result = JSON.parse(
      await answerPlanRecurringGoal({ title: '', timesPerWeek: 2 }, baseInput()),
    );
    expect(result.ok).toBe(false);
  });
});

// ─── replan_remainder ───────────────────────────────────────────────────────

describe('answerReplanRemainder', () => {
  it('says nothing is stranded when every task is done or future-dated', async () => {
    const snap = baseSnapshot();
    snap.tasks.push(
      { id: '1', title: 'Yesterday\'s done thing', dueAt: '2026-07-28T10:00:00+03:00', isDone: true },
      { id: '2', title: 'Next week', dueAt: '2026-08-05T10:00:00+03:00', isDone: false },
    );
    const result = JSON.parse(await answerReplanRemainder({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.stranded).toEqual([]);
  });

  it('proposes new slots for an overdue task', async () => {
    const snap = baseSnapshot();
    snap.tasks.push(
      { id: '1', title: 'Call bank', dueAt: '2026-07-27T10:00:00+03:00', isDone: false },
    );
    const result = JSON.parse(await answerReplanRemainder({}, baseInput({ snapshot: snap })));
    expect(result.ok).toBe(true);
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    expect(result.proposals[0].taskId).toBe('1');
    expect(result.proposals[0].newDueAt).toBeTruthy();
  });
});
