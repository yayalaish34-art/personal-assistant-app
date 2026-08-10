/**
 * reminders.test.ts — Behavioural tests for event reminder scheduling.
 *
 * pg-boss is never started in the suite, so until now every call in here hit
 * the `catch` and logged "failed to schedule reminder" — the scheduling rules
 * CLAUDE.md §8 asks to verify were running, failing, and being swallowed. The
 * queue is mocked instead, so the decisions can be asserted: what gets
 * scheduled, what gets cancelled, and what is deliberately skipped.
 *
 * The graceful-degradation path is covered too — a queue outage must not fail
 * the API request that triggered the schedule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the mock factory below can reach them: `vi.mock` is lifted above
// the imports, and a plain top-level const would still be in its dead zone.
const q = vi.hoisted(() => ({
  upsert: vi.fn(),
  findJobs: vi.fn(),
  deleteJob: vi.fn(),
  available: { value: true },
}));

vi.mock('../src/jobs/boss.js', () => ({
  JobName: { SendReminder: 'send-reminder', PurgeDeletedUsers: 'purge-deleted-users' },
  getBoss: () => {
    if (!q.available.value) {
      throw new Error('pg-boss not started — call startBoss() during bootstrap');
    }
    return { upsert: q.upsert, findJobs: q.findJobs, deleteJob: q.deleteJob };
  },
}));

const { scheduleEventReminder, cancelEventReminder } = await import(
  '../src/modules/events/reminders.js'
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MINUTE = 60_000;

function eventStartingIn(ms: number, reminderMinutesBefore: number | null = 30) {
  return {
    id: 'event-1',
    startsAt: new Date(Date.now() + ms),
    reminderMinutesBefore,
  };
}

beforeEach(() => {
  q.upsert.mockReset().mockResolvedValue('job-1');
  q.findJobs.mockReset().mockResolvedValue([]);
  q.deleteJob.mockReset().mockResolvedValue(undefined);
  q.available.value = true;
});

// ─── Scheduling ───────────────────────────────────────────────────────────────

describe('scheduleEventReminder', () => {
  it('1. an event in the future is queued once, keyed on the event id', async () => {
    await scheduleEventReminder(eventStartingIn(120 * MINUTE, 30));

    expect(q.upsert).toHaveBeenCalledTimes(1);
    const arg = q.upsert.mock.calls[0]![0];
    expect(arg.name).toBe('send-reminder');
    expect(arg.data).toEqual({ eventId: 'event-1' });
    // One pending job per event — this is what makes a re-schedule replace
    // rather than accumulate.
    expect(arg.options.singletonKey).toBe('event-1');
  });

  it('2. it fires the reminder before the event, by exactly the lead time', async () => {
    const event = eventStartingIn(120 * MINUTE, 30);
    await scheduleEventReminder(event);

    const startAfter: Date = q.upsert.mock.calls[0]![0].options.startAfter;
    const gap = event.startsAt.getTime() - startAfter.getTime();
    expect(gap).toBe(30 * MINUTE);
  });

  it('3. a null lead time schedules nothing, and clears anything pending', async () => {
    q.findJobs.mockResolvedValue([{ id: 'stale-job' }]);

    await scheduleEventReminder(eventStartingIn(120 * MINUTE, null));

    expect(q.upsert).not.toHaveBeenCalled();
    expect(q.deleteJob).toHaveBeenCalledWith('send-reminder', ['stale-job']);
  });

  it('4. an event whose reminder time has already passed is not queued', async () => {
    // Starts in 10 minutes, wants 30 minutes' notice — that moment is gone.
    await scheduleEventReminder(eventStartingIn(10 * MINUTE, 30));

    expect(q.upsert).not.toHaveBeenCalled();
  });

  it('5. moving such an event past its reminder time clears the stale job', async () => {
    q.findJobs.mockResolvedValue([{ id: 'stale-job' }]);

    await scheduleEventReminder(eventStartingIn(10 * MINUTE, 30));

    expect(q.deleteJob).toHaveBeenCalledWith('send-reminder', ['stale-job']);
  });

  it('6. an event already under way is not queued', async () => {
    await scheduleEventReminder(eventStartingIn(-60 * MINUTE, 30));

    expect(q.upsert).not.toHaveBeenCalled();
  });

  it('7. rescheduling to a new time replaces the pending job rather than adding one', async () => {
    const first = eventStartingIn(120 * MINUTE, 30);
    await scheduleEventReminder(first);
    const moved = { ...first, startsAt: new Date(Date.now() + 240 * MINUTE) };
    await scheduleEventReminder(moved);

    expect(q.upsert).toHaveBeenCalledTimes(2);
    const [a, b] = q.upsert.mock.calls.map((c) => c[0]);
    expect(a.options.singletonKey).toBe(b.options.singletonKey);
    expect(b.options.startAfter.getTime()).toBeGreaterThan(a.options.startAfter.getTime());
  });

  it('8. a queue outage does not fail the caller', async () => {
    q.available.value = false;

    await expect(scheduleEventReminder(eventStartingIn(120 * MINUTE, 30))).resolves.toBeUndefined();
  });
});

// ─── Cancelling ───────────────────────────────────────────────────────────────

describe('cancelEventReminder', () => {
  it('9. a pending job for the event is deleted', async () => {
    q.findJobs.mockResolvedValue([{ id: 'job-a' }, { id: 'job-b' }]);

    await cancelEventReminder('event-1');

    expect(q.findJobs).toHaveBeenCalledWith('send-reminder', { key: 'event-1', queued: true });
    expect(q.deleteJob).toHaveBeenCalledWith('send-reminder', ['job-a', 'job-b']);
  });

  it('10. nothing pending → no delete call', async () => {
    q.findJobs.mockResolvedValue([]);

    await cancelEventReminder('event-1');

    expect(q.deleteJob).not.toHaveBeenCalled();
  });

  it('11. it only looks for jobs belonging to that event', async () => {
    q.findJobs.mockResolvedValue([{ id: 'job-a' }]);

    await cancelEventReminder('event-2');

    expect(q.findJobs.mock.calls[0]![1]).toMatchObject({ key: 'event-2' });
  });

  it('12. a queue outage does not fail the caller', async () => {
    q.available.value = false;

    await expect(cancelEventReminder('event-1')).resolves.toBeUndefined();
  });
});
