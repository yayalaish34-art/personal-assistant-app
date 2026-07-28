// Seeds the running backend with realistic demo events + tasks.
//
//   ACCESS_TOKEN=<jwt> node scripts/seed-demo.mjs            # add demo data
//   ACCESS_TOKEN=<jwt> node scripts/seed-demo.mjs --reset    # wipe first
//
// Mint a token with `npx tsx sign-token.ts`; every data endpoint is behind
// authMiddleware.
//
// Events have no completion flag, so the UI infers status from the clock: an
// event is `done` once its hour has passed, `inprogress` during it, `todo` if
// still upcoming (see frontend/src/lib/tasks.ts). Today's times are therefore
// laid out on a window anchored to the current hour, so all three columns are
// populated whenever the script runs.

const BASE = process.env.API_BASE ?? 'http://localhost:5000';
const RESET = process.argv.includes('--reset');
// Every data endpoint requires a Bearer token. Mint one with
// `npx tsx sign-token.ts` in backend/ and pass it here.
const TOKEN = process.env.ACCESS_TOKEN ?? '';

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A date `n` days from today (n may be negative). */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

/** Fixed wall-clock time, for tasks on other days where "now" is irrelevant. */
const at = (h, m = 0) => `${pad(h)}:${pad(m)}`;

// Today's tasks are laid out on a grid anchored to the current hour.
//
// Two constraints fight each other here. Offsetting blindly from now wraps past
// midnight late in the day, putting "later" tasks at 01:00 *today*, where they
// read as long since done. But a fixed 08:00–22:00 window can't contain `now`
// when the script runs at 06:00 or 23:00, so every task lands on one side of it
// and a whole column goes empty.
//
// So: slide a window that always brackets `now`, and only clamp at the actual
// day boundaries. Completed work sits behind the current hour, one task is live,
// the rest queue ahead — at any hour the script runs.
const DAY_MIN = 0;
const DAY_MAX = 23.5; // last usable slot; keeps every time inside today

/**
 * Builds `count` slot times for today with `doneCount` of them in the past and
 * one straddling the current hour. Returns 'HH:MM' strings, ascending.
 */
function todaySlots(count, doneCount) {
  const now = new Date();
  const nowH = now.getHours() + now.getMinutes() / 60;
  const pendingCount = count - doneCount - 1;

  // The live task starts at the current hour, so it reads as in progress. Only
  // pull the anchor off `now` when the day boundary forces it: pending tasks
  // just need to fall after `now`, not to each own a half-hour slot, so the
  // upper clamp leaves room for one hour of runway and lets them share it.
  const live = Math.min(
    Math.max(nowH, DAY_MIN + doneCount * 0.5),
    DAY_MAX - 1,
  );
  // Reach back far enough for the done tasks, but not past midnight; likewise
  // forward. Prefer a natural ~14h spread when the day has room for it.
  const start = Math.max(DAY_MIN, live - Math.min(live - DAY_MIN, 8));
  const end = Math.min(DAY_MAX, live + 1 + Math.min(DAY_MAX - live - 1, 6));

  const slots = [];
  for (let i = 0; i < doneCount; i++) {
    slots.push(start + ((live - start) * (i + 0.5)) / doneCount);
  }
  slots.push(live);
  for (let i = 0; i < pendingCount; i++) {
    slots.push(live + 1 + ((end - live - 1) * (i + 0.5)) / pendingCount);
  }

  return slots.map((h, i) => {
    const hh = Math.floor(h);
    // Snap to a half hour so times look human. The live slot rounds *down* so
    // it can't drift past the current time and lose its in-progress status.
    const isLive = i === doneCount;
    const half = (h - hh) * 2;
    const mm = (isLive ? Math.floor(half) : Math.round(half)) * 30;
    return mm === 60 ? at(hh + 1, 0) : at(hh, mm);
  });
}

// ── Today ────────────────────────────────────────────────────────────────
// Chronological order; times come from todaySlots() below. The first
// TODAY_DONE entries land in the past, the next one is live, the rest queue up.
const TODAY_DONE = 6;
const TODAY = [
  // Morning — completed.
  ['Daily standup with the team',        'Medium', 'Sprint 24 blockers and hand-offs'],
  ['Review PR #482 — auth refactor',     'High',   'Token refresh edge cases'],
  ['Reply to client emails',             'Low',    'Northwind + Ridgeway threads'],
  ['Update sprint board',                'Low',    'Move carry-over into Sprint 25'],
  ['Design review: onboarding flow',     'Medium', 'Feedback on steps 2–4'],
  ['Fix checkout validation bug',        'High',   'Ticket ENG-1187 — reported by support'],

  // In progress right now.
  ['Design Landing page',                'High',   'Hero section + pricing table'],

  // Still ahead.
  ['Sync with Maya on Q3 roadmap',       'Medium', 'Priorities for the next two sprints'],
  ['Write release notes for v2.4',       'Medium', 'Changelog + migration notes'],
  ['Prepare Thursday demo deck',         'High',   'Stakeholder walkthrough, 12 slides'],
  ['Refactor notification service',      'Low',    'Split retry logic out of the handler'],
  ['1:1 with Daniel',                    'Medium', 'Career growth + workload check-in'],
  ['Review analytics dashboard specs',   'Low',    'Confirm event naming with data team'],
  ['Gym — upper body',                   'Low',    'Push day, 45 min'],
  ['Plan tomorrow priorities',           'Medium', 'Top 3 before inbox'],
];

// ── Other days (fills out the Calendar screen) ───────────────────────────
const OTHER_DAYS = [
  // Yesterday — all complete.
  [-1, 'Quarterly budget review',        at(9, 30),  'High',   'Finance sign-off on Q3 spend'],
  [-1, 'Customer interview — Acme Co',   at(11),     'Medium', 'Notes in the research doc'],
  [-1, 'Deploy hotfix to production',    at(15),     'High',   'Rollback plan confirmed'],
  [-2, 'Team retro',                     at(14),     'Medium', 'Action items assigned'],
  [-2, 'Security audit follow-up',       at(10),     'High',   'Close remaining medium findings'],

  // Tomorrow.
  [1,  'Stakeholder demo',               at(11),     'High',   'v2.4 walkthrough — 40 min'],
  [1,  'Code review block',              at(9),      'Medium', 'Clear the review queue'],
  [1,  'Dentist appointment',            at(16, 30), 'Low',    'Cleaning — 20 min early'],
  [1,  'Draft Q4 OKRs',                  at(13),     'Medium', 'First pass for leadership review'],

  // Later this week.
  [2,  'Onboard new designer',           at(10),     'High',   'Accounts, tooling, first project'],
  [2,  'Performance testing — API',      at(14),     'Medium', 'Load test the search endpoint'],
  [3,  'Sprint planning',                at(9, 30),  'High',   'Sprint 25 scope and capacity'],
  [3,  'Write technical spec: search v2', at(13, 30), 'Medium', 'Indexing strategy + rollout'],
  [4,  'Monthly metrics report',         at(11),     'Medium', 'Growth + retention for July'],
  [5,  'Conference talk rehearsal',      at(15),     'Low',    'Full run-through with slides'],
  [6,  'Architecture review',            at(10, 30), 'High',   'Event-driven migration proposal'],
];

const JOURNAL = [
  ['Shipped the auth refactor',
   'Merged after two rounds of review. Token refresh is finally clean — no more duplicate requests on expiry. Worth writing up the approach for the team wiki.',
   'great'],
  ['Long day, good progress',
   'Landing page design took most of the afternoon but the hero section finally clicks. Pushed the pricing table to tomorrow rather than rushing it.',
   'good'],
  ['Retro takeaways',
   'Recurring theme: estimates slip when specs are vague. Agreed to spend more time on written specs before pulling anything into a sprint.',
   'ok'],
  ['Focus block experiment',
   'Blocked 9–11 for deep work with notifications off. Got more done than the whole afternoon. Making it a standing calendar hold.',
   'great'],
  ['Slow start',
   'Spent too long on email before real work. Tomorrow: top three priorities first, inbox after.',
   'ok'],
];

/** RFC-4122 v4 — ids are client-generated, per the sync contract. */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Local date + 'HH:MM' -> UTC ISO instant, which is what the API expects. */
function utcIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

async function req(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

async function reset() {
  const [{ events }, { tasks }] = await Promise.all([
    req('GET', '/events'),
    req('GET', '/tasks'),
  ]);
  const liveEvents = events.filter((e) => !e.deletedAt);
  const liveTasks = tasks.filter((t) => !t.deletedAt);
  for (const e of liveEvents) await req('DELETE', `/events/${e.id}`);
  for (const t of liveTasks) await req('DELETE', `/tasks/${t.id}`);
  console.log(`🗑  removed ${liveEvents.length} events, ${liveTasks.length} tasks`);
}

async function main() {
  // Fail fast with a clear message if the backend isn't up.
  try {
    await req('GET', '/health');
  } catch {
    console.error(`✗ Backend not reachable at ${BASE}. Start it with: npm run dev`);
    process.exit(1);
  }

  if (!TOKEN) {
    console.error(
      [
        '✗ ACCESS_TOKEN is required — every data endpoint needs a Bearer token.',
        '  Mint one in backend/:  npx tsx sign-token.ts',
        '  Then:  ACCESS_TOKEN=<token> node scripts/seed-demo.mjs --reset',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (RESET) await reset();

  // Posted oldest-last because store.create prepends; this keeps the
  // resulting list in a sensible chronological order.
  const slots = todaySlots(TODAY.length, TODAY_DONE);
  const events = [
    ...TODAY.map(([title, priority, note], i) => ({
      title,
      date: dayOffset(0),
      time: slots[i],
      notes: `[${priority}] ${note}`,
    })),
    ...OTHER_DAYS.map(([offset, title, time, priority, note]) => ({
      title,
      date: dayOffset(offset),
      time,
      notes: `[${priority}] ${note}`,
    })),
  ];

  for (const e of events) {
    await req('POST', '/events', {
      id: uuid(),
      title: e.title,
      note: e.notes,
      startsAt: utcIso(e.date, e.time),
      reminderMinutesBefore: 15,
      updatedAt: new Date().toISOString(),
    });
  }
  // The backend has no journal resource; the former journal entries become
  // undated tasks so the Tasks screen has content too.
  for (const [title, body] of JOURNAL) {
    await req('POST', '/tasks', {
      id: uuid(),
      title,
      notes: body,
      updatedAt: new Date().toISOString(),
    });
  }

  console.log(`✓ seeded ${events.length} events (${TODAY.length} today) and ${JOURNAL.length} tasks`);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
