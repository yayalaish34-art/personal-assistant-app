/**
 * sync.test.ts — Behavioral tests for CLAUDE.md §2.3–§2.4 sync semantics.
 *
 * Env loading: vitest is invoked with --env-file=.env (see package.json).
 * Each test creates its own user and cleans up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { signAccessToken } from '../src/lib/tokens.js';
import { randomUUID } from 'node:crypto';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** Returns a startsAt string 1 hour from now and endsAt 2 hours from now. */
function eventTimes() {
  const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  return { startsAt, endsAt };
}

// ─── Task sync tests ─────────────────────────────────────────────────────────

describe('Tasks — sync semantics', () => {
  let userId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const user = await createTestUser();
    userId = user.id;
    createdUserIds.push(userId);
  });

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  // Scenario 1: POST with client-generated UUID → 201, body echoes the row
  it('creates a task with a client-generated id and returns 201', async () => {
    const id = randomUUID();
    const res = await request(app)
      .post('/tasks')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Buy groceries' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    expect(res.body.title).toBe('Buy groceries');
    expect(res.body.isDone).toBe(false);
    expect(typeof res.body.updatedAt).toBe('string');
    expect(res.body.deletedAt).toBeNull();
  });

  // Scenario 2: POST replay with same id + same user → 200 (not 201, not 409)
  it('replays the same id and returns the existing row, not a duplicate', async () => {
    const id = randomUUID();
    await request(app)
      .post('/tasks')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Original title' })
      .expect(201);

    const replay = await request(app)
      .post('/tasks')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Different title' });

    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(id);
    // Original title preserved — idempotent, not an update
    expect(replay.body.title).toBe('Original title');

    // Confirm no duplicate row was created
    const count = await prisma.task.count({ where: { id } });
    expect(count).toBe(1);
  });

  // Scenario 3: POST with same id but different user → 409
  it('returns 409 when a different user posts with an already-owned id', async () => {
    const id = randomUUID();
    await request(app)
      .post('/tasks')
      .set('Authorization', auth(userId))
      .send({ id, title: 'User A task' })
      .expect(201);

    const userB = await createTestUser();
    createdUserIds.push(userB.id);

    const res = await request(app)
      .post('/tasks')
      .set('Authorization', auth(userB.id))
      .send({ id, title: 'User B task' });

    expect(res.status).toBe(409);
  });

  // Scenario 4: updatedSince roundtrip
  it('returns only rows modified after the cursor when updatedSince is provided', async () => {
    // Create a task and capture serverTime from the list response
    const id = randomUUID();
    await request(app)
      .post('/tasks')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Before cursor' })
      .expect(201);

    const listBefore = await request(app)
      .get('/tasks')
      .set('Authorization', auth(userId))
      .expect(200);

    const cursorBefore = listBefore.body.serverTime as string;

    // Patch the task after capturing the cursor
    const patchRes = await request(app)
      .patch(`/tasks/${id}`)
      .set('Authorization', auth(userId))
      .send({ title: 'After cursor' })
      .expect(200);

    const updatedAt = patchRes.body.updatedAt as string;

    // GET with cursor from before the patch — should include the updated row
    const listAfterPatch = await request(app)
      .get(`/tasks?updatedSince=${encodeURIComponent(cursorBefore)}`)
      .set('Authorization', auth(userId))
      .expect(200);

    const ids = (listAfterPatch.body.tasks as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(id);

    // GET with cursor AFTER the patch — should NOT include it
    const afterUpdatedAt = new Date(new Date(updatedAt).getTime() + 1).toISOString();
    const listAfterCursor = await request(app)
      .get(`/tasks?updatedSince=${encodeURIComponent(afterUpdatedAt)}`)
      .set('Authorization', auth(userId))
      .expect(200);

    const idsAfter = (listAfterCursor.body.tasks as Array<{ id: string }>).map((t) => t.id);
    expect(idsAfter).not.toContain(id);
  });

  // Scenario 5: DELETE soft-delete semantics
  it('soft-deletes a task: bumps updatedAt, includes in updatedSince query, excludes from plain GET', async () => {
    const id = randomUUID();
    const createRes = await request(app)
      .post('/tasks')
      .set('Authorization', auth(userId))
      .send({ id, title: 'To be deleted' })
      .expect(201);

    const createdUpdatedAt = createRes.body.updatedAt as string;

    // Delete it
    await request(app)
      .delete(`/tasks/${id}`)
      .set('Authorization', auth(userId))
      .expect(204);

    // Verify via DB: deletedAt populated, updatedAt moved past creation time
    const row = await prisma.task.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      new Date(createdUpdatedAt).getTime(),
    );

    // GET with updatedSince from before delete — deleted row IS included with deletedAt set
    const cursorBeforeDelete = createdUpdatedAt;
    const listWithDeleted = await request(app)
      .get(`/tasks?updatedSince=${encodeURIComponent(cursorBeforeDelete)}`)
      .set('Authorization', auth(userId))
      .expect(200);

    const deletedTask = (listWithDeleted.body.tasks as Array<{ id: string; deletedAt: string | null }>)
      .find((t) => t.id === id);
    expect(deletedTask).toBeDefined();
    expect(deletedTask!.deletedAt).not.toBeNull();

    // Plain GET (no updatedSince) does NOT include soft-deleted rows
    const plainList = await request(app)
      .get('/tasks')
      .set('Authorization', auth(userId))
      .expect(200);

    const plainIds = (plainList.body.tasks as Array<{ id: string }>).map((t) => t.id);
    expect(plainIds).not.toContain(id);
  });

  // Scenario 6: Cross-user ownership on PATCH and DELETE
  it('returns 404 (no ownership leakage) when user B touches user A task', async () => {
    const userA = await createTestUser();
    createdUserIds.push(userA.id);
    const userB = await createTestUser();
    createdUserIds.push(userB.id);

    const id = randomUUID();
    await request(app)
      .post('/tasks')
      .set('Authorization', auth(userA.id))
      .send({ id, title: "User A's private task" })
      .expect(201);

    const patchRes = await request(app)
      .patch(`/tasks/${id}`)
      .set('Authorization', auth(userB.id))
      .send({ title: 'Hijacked' });

    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/tasks/${id}`)
      .set('Authorization', auth(userB.id));

    expect(deleteRes.status).toBe(404);

    // Confirm the original task is untouched
    const row = await prisma.task.findUnique({ where: { id } });
    expect(row!.title).toBe("User A's private task");
    expect(row!.deletedAt).toBeNull();
  });
});

// ─── Event sync tests ─────────────────────────────────────────────────────────

describe('Events — sync semantics', () => {
  let userId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const user = await createTestUser();
    userId = user.id;
    createdUserIds.push(userId);
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  // Scenario 1: POST with client-generated UUID → 201, body echoes the row
  it('creates an event with a client-generated id and returns 201', async () => {
    const id = randomUUID();
    const { startsAt } = eventTimes();

    const res = await request(app)
      .post('/events')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Team meeting', startsAt });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    expect(res.body.title).toBe('Team meeting');
    expect(typeof res.body.updatedAt).toBe('string');
    expect(res.body.deletedAt).toBeNull();

    // endsAt defaults to startsAt + 60 min (§3 invariant)
    const expectedEndsAt = new Date(new Date(startsAt).getTime() + 60 * 60 * 1000);
    const actualEndsAt = new Date(res.body.endsAt);
    // Allow a 1-second tolerance for test timing jitter
    expect(Math.abs(actualEndsAt.getTime() - expectedEndsAt.getTime())).toBeLessThan(1000);
  });

  // Scenario 2: POST replay with same id + same user → 200 (not 201, not 409)
  it('replays the same event id and returns the existing row, not a duplicate', async () => {
    const id = randomUUID();
    const { startsAt } = eventTimes();

    await request(app)
      .post('/events')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Original event', startsAt })
      .expect(201);

    const replay = await request(app)
      .post('/events')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Replay event', startsAt });

    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(id);
    expect(replay.body.title).toBe('Original event');

    const count = await prisma.event.count({ where: { id } });
    expect(count).toBe(1);
  });

  // Scenario 3: POST with same id but different user → 409
  it('returns 409 when a different user posts with an already-owned event id', async () => {
    const id = randomUUID();
    const { startsAt } = eventTimes();

    await request(app)
      .post('/events')
      .set('Authorization', auth(userId))
      .send({ id, title: 'User A event', startsAt })
      .expect(201);

    const userB = await createTestUser();
    createdUserIds.push(userB.id);

    const res = await request(app)
      .post('/events')
      .set('Authorization', auth(userB.id))
      .send({ id, title: 'User B event', startsAt });

    expect(res.status).toBe(409);
  });

  // Scenario 4: updatedSince roundtrip
  it('returns only events modified after the cursor when updatedSince is provided', async () => {
    const id = randomUUID();
    const { startsAt } = eventTimes();

    await request(app)
      .post('/events')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Before cursor event', startsAt })
      .expect(201);

    const listBefore = await request(app)
      .get('/events')
      .set('Authorization', auth(userId))
      .expect(200);

    const cursorBefore = listBefore.body.serverTime as string;

    const patchRes = await request(app)
      .patch(`/events/${id}`)
      .set('Authorization', auth(userId))
      .send({ title: 'After cursor event' })
      .expect(200);

    const updatedAt = patchRes.body.updatedAt as string;

    // GET with cursor from before the patch — should include the updated row
    const listAfterPatch = await request(app)
      .get(`/events?updatedSince=${encodeURIComponent(cursorBefore)}`)
      .set('Authorization', auth(userId))
      .expect(200);

    const ids = (listAfterPatch.body.events as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(id);

    // GET with cursor AFTER the patch — should NOT include it
    const afterUpdatedAt = new Date(new Date(updatedAt).getTime() + 1).toISOString();
    const listAfterCursor = await request(app)
      .get(`/events?updatedSince=${encodeURIComponent(afterUpdatedAt)}`)
      .set('Authorization', auth(userId))
      .expect(200);

    const idsAfter = (listAfterCursor.body.events as Array<{ id: string }>).map((e) => e.id);
    expect(idsAfter).not.toContain(id);
  });

  // Scenario 5: DELETE soft-delete semantics
  it('soft-deletes an event: bumps updatedAt, includes in updatedSince query, excludes from plain GET', async () => {
    const id = randomUUID();
    const { startsAt } = eventTimes();

    const createRes = await request(app)
      .post('/events')
      .set('Authorization', auth(userId))
      .send({ id, title: 'Event to delete', startsAt })
      .expect(201);

    const createdUpdatedAt = createRes.body.updatedAt as string;

    await request(app)
      .delete(`/events/${id}`)
      .set('Authorization', auth(userId))
      .expect(204);

    // Verify via DB: deletedAt populated, updatedAt moved
    const row = await prisma.event.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      new Date(createdUpdatedAt).getTime(),
    );

    // GET with updatedSince from creation — deleted row IS included with deletedAt set
    const listWithDeleted = await request(app)
      .get(`/events?updatedSince=${encodeURIComponent(createdUpdatedAt)}`)
      .set('Authorization', auth(userId))
      .expect(200);

    const deletedEvent = (listWithDeleted.body.events as Array<{ id: string; deletedAt: string | null }>)
      .find((e) => e.id === id);
    expect(deletedEvent).toBeDefined();
    expect(deletedEvent!.deletedAt).not.toBeNull();

    // Plain GET (no updatedSince) does NOT include soft-deleted rows
    const plainList = await request(app)
      .get('/events')
      .set('Authorization', auth(userId))
      .expect(200);

    const plainIds = (plainList.body.events as Array<{ id: string }>).map((e) => e.id);
    expect(plainIds).not.toContain(id);
  });

  // Scenario 6: Cross-user ownership on PATCH and DELETE
  it('returns 404 (no ownership leakage) when user B touches user A event', async () => {
    const userA = await createTestUser();
    createdUserIds.push(userA.id);
    const userB = await createTestUser();
    createdUserIds.push(userB.id);

    const id = randomUUID();
    const { startsAt } = eventTimes();

    await request(app)
      .post('/events')
      .set('Authorization', auth(userA.id))
      .send({ id, title: "User A's private event", startsAt })
      .expect(201);

    const patchRes = await request(app)
      .patch(`/events/${id}`)
      .set('Authorization', auth(userB.id))
      .send({ title: 'Hijacked' });

    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/events/${id}`)
      .set('Authorization', auth(userB.id));

    expect(deleteRes.status).toBe(404);

    // Confirm the original event is untouched
    const row = await prisma.event.findUnique({ where: { id } });
    expect(row!.title).toBe("User A's private event");
    expect(row!.deletedAt).toBeNull();
  });
});

// ─── Global teardown ─────────────────────────────────────────────────────────

afterAll(async () => {
  await prisma.$disconnect();
});
