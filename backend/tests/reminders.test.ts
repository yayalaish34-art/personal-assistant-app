/**
 * reminders.test.ts — the scheduling rules, on their own.
 *
 * `scheduleEventReminder` and `cancelEventReminder` wrap everything in a
 * try/catch that logs and returns, so a scheduling bug looks exactly like a
 * working system from the outside: the API call succeeds either way. The
 * existing suites never start pg-boss, so every call in them lands in that
 * catch and proves nothing.
 *
 * Here pg-boss is mocked, which puts the rules themselves under assertion:
 * what gets scheduled, when, with which key, and what gets cancelled.
 *
 * No database and no queue — this file is pure unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be hoisted above the import of the module under test.
const boss = vi.hoisted(() => ({
  upsert: vi.fn(),
  findJobs: vi.fn(),
  deleteJob: vi.fn(),
}));

const getBoss = vi.hoisted(() => vi.fn());

vi.mock('../src/jobs/boss.js', () => ({
  getBoss,
  JobName: {
    SendReminder: 'send-reminder',
    PurgeDeletedUsers: 'purge-deleted-users',
  },
}));

const { scheduleEventReminder, cancelEventReminder } = await import(
  '../src/modules/events/reminders.js'
);

const SEND_REMINDER = 'send-reminder';

function minutesFromNow(m: number): Date {
  return new Date(Date.now() + m * 60_000);
}

beforeEach(() => {
  vi.clearAllMocks();
  getBoss.mockReturnValue(boss);
  boss.upsert.mockResolvedValue('job-id');
  boss.findJobs.mockResolvedValue([]);
  boss.deleteJob.mockResolvedValue(undefined);
});

// ─── scheduleEventReminder ───────────────────────────────────────────────────

describe('scheduleEventReminder', () => {
  it('schedules a job when the reminder time is in the future', async () => {
    const startsAt = minutesFromNow(120);

    await scheduleEventReminder({
      id: 'event-1',
      startsAt,
      reminderMinutesBefore: 30,
    });

    expect(boss.upsert).toHaveBeenCalledTimes(1);
    const call = boss.upsert.mock.calls[0]![0];
    expect(call.name).toBe(SEND_REMINDER);
    expect(call.data).toEqual({ eventId: 'event-1' });
  });

  it('fires the job exactly reminderMinutesBefore ahead of the event', async () => {
    const startsAt = minutesFromNow(120);

    await scheduleEventReminder({
      id: 'event-2',
      startsAt,
      reminderMinutesBefore: 45,
    });

    const { options } = boss.upsert.mock.calls[0]![0];
    expect((options.startAfter as Date).getTime()).toBe(startsAt.getTime() - 45 * 60_000);
  });

  it('keys the job on the event id, so re-scheduling replaces rather than duplicates', async () => {
    const startsAt = minutesFromNow(120);

    await scheduleEventReminder({ id: 'event-3', startsAt, reminderMinutesBefore: 10 });
    await scheduleEventReminder({ id: 'event-3', startsAt, reminderMinutesBefore: 20 });

    expect(boss.upsert).toHaveBeenCalledTimes(2);
    for (const [call] of boss.upsert.mock.calls) {
      expect(call.options.singletonKey).toBe('event-3');
    }
  });

  it('schedules nothing when reminderMinutesBefore is null', async () => {
    await scheduleEventReminder({
      id: 'event-4',
      startsAt: minutesFromNow(120),
      reminderMinutesBefore: null,
    });

    expect(boss.upsert).not.toHaveBeenCalled();
  });

  it('cancels any existing job when reminderMinutesBefore is cleared to null', async () => {
    boss.findJobs.mockResolvedValue([{ id: 'job-1' }]);

    await scheduleEventReminder({
      id: 'event-5',
      startsAt: minutesFromNow(120),
      reminderMinutesBefore: null,
    });

    expect(boss.deleteJob).toHaveBeenCalledWith(SEND_REMINDER, ['job-1']);
  });

  it('schedules nothing when the reminder time has already passed', async () => {
    // The event is still ahead, but the reminder for it is behind us.
    await scheduleEventReminder({
      id: 'event-6',
      startsAt: minutesFromNow(10),
      reminderMinutesBefore: 60,
    });

    expect(boss.upsert).not.toHaveBeenCalled();
  });

  it('cancels the stale job when a time change pushes the reminder into the past', async () => {
    boss.findJobs.mockResolvedValue([{ id: 'job-2' }]);

    await scheduleEventReminder({
      id: 'event-7',
      startsAt: minutesFromNow(-30), // event already started
      reminderMinutesBefore: 15,
    });

    expect(boss.upsert).not.toHaveBeenCalled();
    expect(boss.deleteJob).toHaveBeenCalledWith(SEND_REMINDER, ['job-2']);
  });

  it('does not fail the caller when pg-boss is unavailable', async () => {
    getBoss.mockImplementation(() => {
      throw new Error('pg-boss not started');
    });

    await expect(
      scheduleEventReminder({
        id: 'event-8',
        startsAt: minutesFromNow(120),
        reminderMinutesBefore: 30,
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── cancelEventReminder ─────────────────────────────────────────────────────

describe('cancelEventReminder', () => {
  it('looks for queued jobs keyed on the event id', async () => {
    await cancelEventReminder('event-9');

    expect(boss.findJobs).toHaveBeenCalledWith(SEND_REMINDER, {
      key: 'event-9',
      queued: true,
    });
  });

  it('deletes every job it finds', async () => {
    boss.findJobs.mockResolvedValue([{ id: 'job-a' }, { id: 'job-b' }]);

    await cancelEventReminder('event-10');

    expect(boss.deleteJob).toHaveBeenCalledWith(SEND_REMINDER, ['job-a', 'job-b']);
  });

  it('does not call deleteJob when there is nothing queued', async () => {
    boss.findJobs.mockResolvedValue([]);

    await cancelEventReminder('event-11');

    expect(boss.deleteJob).not.toHaveBeenCalled();
  });

  it('does not fail the caller when pg-boss is unavailable', async () => {
    boss.findJobs.mockRejectedValue(new Error('connection lost'));

    await expect(cancelEventReminder('event-12')).resolves.toBeUndefined();
    expect(boss.deleteJob).not.toHaveBeenCalled();
  });
});
