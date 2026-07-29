-- Seeds a demo user with tasks and events.
--
--   psql "$DATABASE_URL" -f scripts/seed.sql
--
-- Idempotent: re-running replaces the demo rows rather than duplicating them.
-- Times are relative to the day it runs, so today always has a full agenda.
--
-- Timestamps are stored UTC (the app converts using users.timezone). The
-- literals below are written in Asia/Jerusalem local time and converted by
-- Postgres, so 09:00 here means 09:00 to the user regardless of DST.

BEGIN;

-- ── User ────────────────────────────────────────────────────────────────────
-- Keyed on (provider, provider_user_id) so a re-run reuses the same account
-- and its data stays attached.
INSERT INTO users (id, provider, provider_user_id, email, name, language, timezone,
                   created_at, updated_at)
VALUES (
  '8092bf27-b01d-40f3-94c5-e44739077be7',
  'google', 'local-dev-user', 'dev@local', 'Dev User', 'en', 'Asia/Jerusalem',
  now(), now()
)
ON CONFLICT (provider, provider_user_id) DO UPDATE
  SET deleted_at = NULL, deletion_requested_at = NULL, updated_at = now();

-- Reuse whatever id the row actually has (it may pre-date this script).
CREATE TEMP TABLE seed_user ON COMMIT DROP AS
SELECT id FROM users WHERE provider = 'google' AND provider_user_id = 'local-dev-user';

-- ── Clear previous demo rows ────────────────────────────────────────────────
-- Hard delete, not soft: this is a reset, and leaving tombstones would make
-- sync endpoints return rows the client then has to discard.
DELETE FROM events WHERE user_id = (SELECT id FROM seed_user);
DELETE FROM tasks  WHERE user_id = (SELECT id FROM seed_user);

-- ── Events ──────────────────────────────────────────────────────────────────
-- `d` is a day offset from today; `t` is local wall-clock time.
INSERT INTO events (id, user_id, title, note, starts_at, ends_at,
                    reminder_minutes_before, created_at, updated_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM seed_user),
  title,
  note,
  ((CURRENT_DATE + d) + t) AT TIME ZONE 'Asia/Jerusalem',
  ((CURRENT_DATE + d) + t + interval '1 hour') AT TIME ZONE 'Asia/Jerusalem',
  15,
  now(), now()
FROM (VALUES
  -- Today
  (0, TIME '09:00', 'Daily standup with the team', '[Medium] Sprint blockers and hand-offs'),
  (0, TIME '10:00', 'Review PR #482 — auth refactor', '[High] Token refresh edge cases'),
  (0, TIME '11:00', 'Reply to client emails',        '[Low] Northwind + Ridgeway threads'),
  (0, TIME '12:00', 'Design review: onboarding flow','[Medium] Feedback on steps 2–4'),
  (0, TIME '13:30', 'Fix checkout validation bug',   '[High] Ticket ENG-1187'),
  (0, TIME '14:30', 'Design Landing page',           '[High] Hero section + pricing table'),
  (0, TIME '15:30', 'Sync with Maya on Q3 roadmap',  '[Medium] Priorities for next two sprints'),
  (0, TIME '16:30', 'Write release notes for v2.4',  '[Medium] Changelog + migration notes'),
  (0, TIME '17:30', 'Prepare demo deck',             '[High] Stakeholder walkthrough'),
  (0, TIME '18:30', 'Gym — upper body',              '[Low] Push day, 45 min'),
  -- Yesterday
  (-1, TIME '09:30', 'Quarterly budget review',      '[High] Finance sign-off on Q3 spend'),
  (-1, TIME '11:00', 'Customer interview — Acme Co', '[Medium] Notes in the research doc'),
  (-1, TIME '15:00', 'Deploy hotfix to production',  '[High] Rollback plan confirmed'),
  (-2, TIME '14:00', 'Team retro',                   '[Medium] Action items assigned'),
  -- Upcoming
  (1, TIME '11:00', 'Stakeholder demo',              '[High] v2.4 walkthrough — 40 min'),
  (1, TIME '09:00', 'Code review block',             '[Medium] Clear the review queue'),
  (1, TIME '16:30', 'Dentist appointment',           '[Low] Cleaning'),
  (2, TIME '10:00', 'Onboard new designer',          '[High] Accounts, tooling, first project'),
  (2, TIME '14:00', 'Performance testing — API',     '[Medium] Load test the search endpoint'),
  (3, TIME '09:30', 'Sprint planning',               '[High] Scope and capacity'),
  (3, TIME '13:30', 'Write technical spec: search',  '[Medium] Indexing strategy + rollout'),
  (4, TIME '11:00', 'Monthly metrics report',        '[Medium] Growth + retention'),
  (5, TIME '15:00', 'Conference talk rehearsal',     '[Low] Full run-through with slides'),
  (6, TIME '10:30', 'Architecture review',           '[High] Event-driven migration proposal')
) AS v(d, t, title, note);

-- ── Tasks ───────────────────────────────────────────────────────────────────
-- due_at is nullable, so NULL day offsets stay undated.
INSERT INTO tasks (id, user_id, title, notes, due_at, is_done, created_at, updated_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM seed_user),
  title,
  notes,
  CASE WHEN d IS NULL THEN NULL
       ELSE ((CURRENT_DATE + d) + t) AT TIME ZONE 'Asia/Jerusalem' END,
  is_done,
  now(), now()
FROM (VALUES
  (0,    TIME '17:00', 'Write the weekly update',      '[Medium] Send before end of day', false),
  (0,    TIME '12:00', 'Book flights for the offsite', '[High] Two travellers, direct',   false),
  (1,    TIME '10:00', 'Renew the SSL certificate',    '[High] Expires in 6 days',        false),
  (2,    TIME '09:00', 'Draft Q4 OKRs',                '[Medium] First pass for review',  false),
  (-1,   TIME '16:00', 'Ship the auth refactor',       '[High] Merged after two rounds',  true),
  (-2,   TIME '11:00', 'Close out the security audit', '[Medium] Findings resolved',      true),
  (NULL, TIME '00:00', 'Read the pg-boss docs',        '[Low] Background job patterns',   false),
  (NULL, TIME '00:00', 'Tidy the component library',   '[Low] Remove unused variants',    false)
) AS v(d, t, title, notes, is_done);

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM users WHERE deleted_at IS NULL)  AS users,
  (SELECT count(*) FROM events WHERE deleted_at IS NULL) AS events,
  (SELECT count(*) FROM tasks WHERE deleted_at IS NULL)  AS tasks,
  (SELECT count(*) FROM events
     WHERE deleted_at IS NULL
       AND (starts_at AT TIME ZONE 'Asia/Jerusalem')::date = CURRENT_DATE) AS events_today;
