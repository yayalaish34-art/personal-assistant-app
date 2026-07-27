/**
 * chat.test.ts — Behavioural tests for the chat subsystem.
 *
 * Does NOT call OpenAI. Covers:
 *   - withUserLock mutex (pure JS)
 *   - executePendingAction (DB + ownership)
 *   - executeReadOnlyTool (DB queries)
 *   - Chat persistence helpers
 *   - POST /chat/message confirm path (skipped unless OPENAI_API_KEY is set)
 *
 * Style mirrors sync.test.ts: fresh users per describe block, afterAll cleanup.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { signAccessToken } from '../src/lib/tokens.js';
import { withUserLock } from '../src/modules/chat/mutex.js';
import {
  executePendingAction,
  executeReadOnlyTool,
  type PendingAction,
} from '../src/modules/chat/tools.js';
import {
  saveAssistantMessage,
  findAssistantMessageWithPending,
  clearPendingAction,
} from '../src/modules/chat/persistence.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createTestUser(providerUserId = randomUUID()) {
  return prisma.user.create({
    data: {
      provider: 'google',
      providerUserId,
      email: `${providerUserId}@test`,
      name: 'Test',
      timezone: 'UTC',
    },
  });
}

function auth(userId: string) {
  return `Bearer ${signAccessToken(userId)}`;
}

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

// ─── withUserLock ─────────────────────────────────────────────────────────────

describe('withUserLock — mutex semantics', () => {
  const userId = randomUUID(); // no DB needed

  it('serialises two calls for the same userId: second fn starts after first resolves', async () => {
    const log: string[] = [];
    let firstResolved = false;

    const first = withUserLock(userId, async () => {
      log.push('first-start');
      await new Promise<void>((r) => setTimeout(r, 30));
      firstResolved = true;
      log.push('first-end');
    });

    // Give the first a head-start so it holds the chain before we register second
    await new Promise<void>((r) => setTimeout(r, 5));

    const second = withUserLock(userId, async () => {
      // At the moment the second fn body begins, first must already be done.
      expect(firstResolved).toBe(true);
      log.push('second-start');
    });

    await Promise.all([first, second]);
    expect(log).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('allows two calls with DIFFERENT userIds to run in parallel', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const starts: Record<string, number> = {};

    const a = withUserLock(idA, async () => {
      starts['a'] = Date.now();
      await new Promise<void>((r) => setTimeout(r, 40));
    });

    const b = withUserLock(idB, async () => {
      starts['b'] = Date.now();
      await new Promise<void>((r) => setTimeout(r, 40));
    });

    await Promise.all([a, b]);

    // Both should have started within a 20 ms window of each other — parallel.
    expect(Math.abs(starts['a']! - starts['b']!)).toBeLessThan(20);
  });

  it('second fn still runs if the first fn rejects', async () => {
    let secondRan = false;

    // Attach a no-op rejection handler immediately to avoid unhandled rejection.
    const first = withUserLock(userId, async () => {
      throw new Error('boom');
    });
    first.catch(() => {});

    // Wait long enough for `first` to be registered in the chain.
    await new Promise<void>((r) => setTimeout(r, 5));

    const second = withUserLock(userId, async () => {
      secondRan = true;
    });

    await first.catch(() => {});
    await second;

    expect(secondRan).toBe(true);
  });

  it('cleans up the internal Map after all calls resolve — third call starts immediately', async () => {
    const id = randomUUID();

    // Two sequential calls — after both finish the Map entry should be gone.
    await withUserLock(id, async () => {});
    await withUserLock(id, async () => {});

    // Third call: measure how long it blocks (should be ~0ms, not queued behind anything)
    const t0 = Date.now();
    await withUserLock(id, async () => {});
    const elapsed = Date.now() - t0;

    // If the Map entry persisted and chained, elapsed would be large; fresh call is instant.
    expect(elapsed).toBeLessThan(20);
  });
});

// ─── executePendingAction ─────────────────────────────────────────────────────

describe('executePendingAction — mutation + ownership', () => {
  let userAId: string;
  let userBId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    userAId = a.id;
    userBId = b.id;
    createdUserIds.push(userAId, userBId);
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.chatMessage.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  // 5. create_task
  it('create_task — creates a Task row owned by the caller', async () => {
    const action: PendingAction = {
      tool: 'create_task',
      arguments: { title: 'Buy milk' },
    };
    const outcome = await executePendingAction(action, userAId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const task = outcome.result as { id: string; title: string; userId: string };
    expect(task.title).toBe('Buy milk');
    expect(task.userId).toBe(userAId);

    const row = await prisma.task.findUnique({ where: { id: task.id } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(userAId);
  });

  // 6. update_task — wrong user → NOT_FOUND
  it('update_task — task owned by another user → NOT_FOUND, no mutation', async () => {
    const taskId = randomUUID();
    await prisma.task.create({
      data: { id: taskId, userId: userAId, title: 'Original' },
    });

    const action: PendingAction = {
      tool: 'update_task',
      arguments: { id: taskId, title: 'Hijacked' },
    };
    const outcome = await executePendingAction(action, userBId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_FOUND');

    const row = await prisma.task.findUnique({ where: { id: taskId } });
    expect(row!.title).toBe('Original'); // untouched
  });

  // 7. update_task — soft-deleted task → NOT_FOUND
  it('update_task — soft-deleted own task → NOT_FOUND, no mutation', async () => {
    const taskId = randomUUID();
    await prisma.task.create({
      data: { id: taskId, userId: userAId, title: 'Deleted task', deletedAt: new Date() },
    });

    const action: PendingAction = {
      tool: 'update_task',
      arguments: { id: taskId, title: 'Resurrected' },
    };
    const outcome = await executePendingAction(action, userAId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_FOUND');

    const row = await prisma.task.findUnique({ where: { id: taskId } });
    expect(row!.title).toBe('Deleted task'); // untouched
  });

  // 8. complete_task
  it('complete_task — own row → ok, isDone=true', async () => {
    const taskId = randomUUID();
    await prisma.task.create({
      data: { id: taskId, userId: userAId, title: 'Finish report' },
    });

    const action: PendingAction = {
      tool: 'complete_task',
      arguments: { id: taskId },
    };
    const outcome = await executePendingAction(action, userAId);

    expect(outcome.ok).toBe(true);

    const row = await prisma.task.findUnique({ where: { id: taskId } });
    expect(row!.isDone).toBe(true);
  });

  // 9. create_event — no ends_at → defaults to startsAt + 60 min
  it('create_event — omitting ends_at → endsAt = startsAt + 60 min', async () => {
    const startsAt = hoursFromNow(2).toISOString();

    const action: PendingAction = {
      tool: 'create_event',
      arguments: { title: 'Stand-up', starts_at: startsAt },
    };
    const outcome = await executePendingAction(action, userAId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const event = outcome.result as { startsAt: Date; endsAt: Date };
    const expectedEnds = new Date(new Date(startsAt).getTime() + 60 * 60 * 1000);
    expect(Math.abs(new Date(event.endsAt).getTime() - expectedEnds.getTime())).toBeLessThan(1000);
  });

  // 10. create_event — ends_at <= starts_at → VALIDATION_ERROR, no row
  it('create_event — ends_at before starts_at → VALIDATION_ERROR, no row created', async () => {
    const startsAt = hoursFromNow(3).toISOString();
    const endsAt = hoursFromNow(2).toISOString(); // before starts_at

    const before = await prisma.event.count({ where: { userId: userAId } });

    const action: PendingAction = {
      tool: 'create_event',
      arguments: { title: 'Bad event', starts_at: startsAt, ends_at: endsAt },
    };
    const outcome = await executePendingAction(action, userAId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('VALIDATION_ERROR');

    const after = await prisma.event.count({ where: { userId: userAId } });
    expect(after).toBe(before);
  });

  // 11. create_event — userId from token param, not from arguments
  it('create_event — bogus userId in arguments is ignored; row is owned by caller', async () => {
    const startsAt = hoursFromNow(4).toISOString();

    const action: PendingAction = {
      tool: 'create_event',
      arguments: {
        title: 'Defence test',
        starts_at: startsAt,
        userId: userBId, // adversarial — must be ignored
      },
    };
    const outcome = await executePendingAction(action, userAId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const event = outcome.result as { id: string };
    const row = await prisma.event.findUnique({ where: { id: event.id } });
    expect(row!.userId).toBe(userAId); // NOT userBId
  });

  // 12. Invalid arguments → VALIDATION_ERROR, no row change
  it('update_task — missing required id → VALIDATION_ERROR', async () => {
    const before = await prisma.task.count({ where: { userId: userAId } });

    const action: PendingAction = {
      tool: 'update_task',
      arguments: { title: 'No id supplied' }, // id is required
    };
    const outcome = await executePendingAction(action, userAId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('VALIDATION_ERROR');

    const after = await prisma.task.count({ where: { userId: userAId } });
    expect(after).toBe(before);
  });
});

// ─── executeReadOnlyTool ──────────────────────────────────────────────────────

describe('executeReadOnlyTool — list_tasks and list_events', () => {
  let userAId: string;
  let userBId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    userAId = a.id;
    userBId = b.id;
    createdUserIds.push(userAId, userBId);

    // Seed tasks for both users
    const pastDue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const future = hoursFromNow(24);

    await prisma.task.createMany({
      data: [
        { id: randomUUID(), userId: userAId, title: 'Task A1', dueAt: pastDue },
        { id: randomUUID(), userId: userAId, title: 'Task A2', dueAt: future },
        { id: randomUUID(), userId: userAId, title: 'Task A done', dueAt: pastDue, isDone: true },
        { id: randomUUID(), userId: userBId, title: 'Task B1' },
      ],
    });

    // Seed events
    const t1 = new Date('2030-01-01T09:00:00Z');
    const t2 = new Date('2030-01-01T10:00:00Z');
    const t3 = new Date('2030-01-01T11:00:00Z');
    const t4 = new Date('2030-01-01T12:00:00Z');

    await prisma.event.createMany({
      data: [
        // Event that starts before window but ends inside it — must be included
        { id: randomUUID(), userId: userAId, title: 'Overlapping event', startsAt: t1, endsAt: t3 },
        // Event fully inside window
        { id: randomUUID(), userId: userAId, title: 'Inside event', startsAt: t2, endsAt: t3 },
        // Event outside window (ends before from)
        { id: randomUUID(), userId: userAId, title: 'Past event', startsAt: new Date('2030-01-01T06:00:00Z'), endsAt: t1 },
        // Another user's event inside window — must NOT appear
        { id: randomUUID(), userId: userBId, title: 'User B event', startsAt: t2, endsAt: t3 },
      ],
    });

    // Deleted task for user A — must not appear in 'all'
    await prisma.task.create({
      data: {
        id: randomUUID(),
        userId: userAId,
        title: 'Deleted A task',
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  // 13. list_tasks — range 'all', only caller's tasks returned
  it("list_tasks all — returns only caller's tasks, not other users'", async () => {
    const raw = await executeReadOnlyTool('list_tasks', { range: 'all' }, userAId);
    const tasks = JSON.parse(raw) as Array<{ title: string }>;

    const titles = tasks.map((t) => t.title);
    expect(titles).not.toContain('Task B1');
    expect(titles).not.toContain('Deleted A task'); // soft-deleted excluded
    expect(titles).toContain('Task A1');
    expect(titles).toContain('Task A2');
  });

  // 14. list_tasks — range 'overdue', only past-due non-done tasks
  it('list_tasks overdue — returns only past-due, not-done tasks for caller', async () => {
    const raw = await executeReadOnlyTool('list_tasks', { range: 'overdue' }, userAId);
    const tasks = JSON.parse(raw) as Array<{ title: string; is_done: boolean }>;

    const titles = tasks.map((t) => t.title);
    expect(titles).toContain('Task A1');
    expect(titles).not.toContain('Task A done'); // is_done=true → excluded
    expect(titles).not.toContain('Task A2');     // future due date → not overdue
    expect(titles).not.toContain('Task B1');     // wrong user
  });

  // 15. list_events — overlap window; event starting before `from` but ending after `from` is included
  it('list_events — returns overlapping events; event starting before window but ending inside is included', async () => {
    const from = '2030-01-01T09:30:00Z'; // after 'Overlapping event' starts but before it ends
    const to = '2030-01-01T11:30:00Z';

    const raw = await executeReadOnlyTool('list_events', { from, to }, userAId);
    const events = JSON.parse(raw) as Array<{ title: string }>;

    const titles = events.map((e) => e.title);
    expect(titles).toContain('Overlapping event'); // starts before `from`, ends after `from` → included
    expect(titles).toContain('Inside event');
    expect(titles).not.toContain('Past event');   // ends at 09:00 = `from`-boundary, before `from`
    expect(titles).not.toContain('User B event'); // wrong user
  });
});

// ─── Chat persistence helpers ─────────────────────────────────────────────────

describe('Chat persistence — saveAssistantMessage / findAssistantMessageWithPending / clearPendingAction', () => {
  let userAId: string;
  let userBId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    userAId = a.id;
    userBId = b.id;
    createdUserIds.push(userAId, userBId);
  });

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  // 16. saveAssistantMessage with pendingAction → findAssistantMessageWithPending returns row;
  //     clearPendingAction → returns null
  it('pending action round-trip: save → find → clear → null', async () => {
    const pending: PendingAction = {
      tool: 'create_task',
      arguments: { title: 'Round-trip test' },
    };

    const msg = await saveAssistantMessage({
      userId: userAId,
      content: 'Shall I create this task?',
      pendingAction: pending,
    });

    // Find before clear — should return the row
    const found = await findAssistantMessageWithPending(msg.id, userAId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(msg.id);

    await clearPendingAction(msg.id);

    // Find after clear — should return null
    const afterClear = await findAssistantMessageWithPending(msg.id, userAId);
    expect(afterClear).toBeNull();
  });

  // 17. findAssistantMessageWithPending — wrong userId → null (no leakage)
  it('findAssistantMessageWithPending — message belonging to another user returns null', async () => {
    const pending: PendingAction = {
      tool: 'create_task',
      arguments: { title: 'Private task' },
    };

    const msg = await saveAssistantMessage({
      userId: userAId,
      content: 'Confirm?',
      pendingAction: pending,
    });

    // Attempt to find with userB's id
    const result = await findAssistantMessageWithPending(msg.id, userBId);
    expect(result).toBeNull();
  });
});

// ─── POST /chat/message — confirm path (conditional on OPENAI_API_KEY) ────────

const hasOpenAI = Boolean(process.env['OPENAI_API_KEY']);

describe.skipIf(!hasOpenAI)('POST /chat/message — confirm path (requires OPENAI_API_KEY)', () => {
  let userId: string;
  let otherUserId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const u = await createTestUser();
    const o = await createTestUser();
    userId = u.id;
    otherUserId = o.id;
    createdUserIds.push(userId, otherUserId);
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.chatMessage.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  // 18. Confirm a pending create_task action → 200, task in DB, pendingAction cleared, tool message present
  it('confirms a pending create_task: 200, task created, pendingAction cleared, tool role in response', async () => {
    const pending: PendingAction = {
      tool: 'create_task',
      arguments: { title: 'HTTP confirm test' },
    };

    const assistantMsg = await saveAssistantMessage({
      userId,
      content: 'Shall I create this task?',
      pendingAction: pending,
    });

    const res = await request(app)
      .post('/chat/message')
      .set('Authorization', auth(userId))
      .send({ confirmMessageId: assistantMsg.id });

    expect(res.status).toBe(200);

    const messages = res.body.messages as Array<{ role: string }>;
    const hasToolMsg = messages.some((m) => m.role === 'tool');
    expect(hasToolMsg).toBe(true);

    // pendingAction must be cleared
    const cleared = await findAssistantMessageWithPending(assistantMsg.id, userId);
    expect(cleared).toBeNull();

    // Task must exist in DB
    const tasks = await prisma.task.findMany({ where: { userId, title: 'HTTP confirm test' } });
    expect(tasks.length).toBe(1);
  });

  // 19. confirmMessageId belonging to another user → 404
  it('confirms a message owned by another user → 404 NOT_FOUND', async () => {
    const pending: PendingAction = {
      tool: 'create_task',
      arguments: { title: 'Other user task' },
    };

    const assistantMsg = await saveAssistantMessage({
      userId: otherUserId,
      content: 'Confirm?',
      pendingAction: pending,
    });

    const res = await request(app)
      .post('/chat/message')
      .set('Authorization', auth(userId)) // logged in as a DIFFERENT user
      .send({ confirmMessageId: assistantMsg.id });

    expect(res.status).toBe(404);
  });

  // 20. confirmMessageId whose pendingAction is already cleared → 404
  it('confirms a message whose pendingAction was already cleared → 404', async () => {
    const pending: PendingAction = {
      tool: 'create_task',
      arguments: { title: 'Already cleared' },
    };

    const assistantMsg = await saveAssistantMessage({
      userId,
      content: 'Confirm?',
      pendingAction: pending,
    });

    // Clear it before the HTTP call
    await clearPendingAction(assistantMsg.id);

    const res = await request(app)
      .post('/chat/message')
      .set('Authorization', auth(userId))
      .send({ confirmMessageId: assistantMsg.id });

    expect(res.status).toBe(404);
  });
});

// ─── Global teardown ──────────────────────────────────────────────────────────

afterAll(async () => {
  await prisma.$disconnect();
});
