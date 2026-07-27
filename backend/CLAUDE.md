# CLAUDE.md — AI Personal Secretary, Backend

## 1. What this project is

A Node/TypeScript backend for a mobile app whose primary interface is a chat
with an AI secretary. The user talks (text or voice), the LLM proposes an
action, the user confirms, and only then does anything get written.

Four surfaces: Home, Chat, Tasks, Calendar.
Scope is frozen at MVP v1.1. Anything not in `SPEC_MVP_V1.1.md` is out of scope
and is priced separately — including shopping lists, recurring events,
all-day events, calendar sync, monthly view, and sharing. If a task seems to
require one of these, stop and ask rather than building it.

Stack: Express, PostgreSQL + Prisma, OpenAI (chat + Whisper), pg-boss,
Expo Push, Zod, Vitest + Supertest.

---

## 2. The four rules that break everything if violated

These are the invariants. Most bugs in this codebase will trace back to one.

**2.1 Nothing executes without confirmation.**
The LLM never mutates data directly. It proposes; the proposal is stored as
`pending_action`; the user confirms; only then does an executor run. Any code
path where a tool call reaches the database without a confirm step is a bug,
regardless of how convenient it is.

**2.2 Every mutation checks ownership.**
The LLM can and will hallucinate a `task_id` or `event_id`. Before any read or
write on a resource, assert `resource.user_id === token.user_id`. Never trust
an id from an LLM, and never take `user_id` from a request parameter — only
from the verified token.

**2.3 Soft delete must move `updated_at`.**
Setting `deleted_at` without bumping `updated_at` means the deletion never
surfaces in `GET /tasks?updatedSince=`, and the client keeps a ghost row
forever. Sync endpoints return deleted rows, with `deleted_at` populated.

**2.4 Create is idempotent on the client's id.**
Ids are UUIDs generated on the device so offline creation works. A retried
`POST` must not create a duplicate: same user + same id → `200` with the
existing row; different user + existing id → `409`.

---

## 3. Time

All timestamps are stored and transmitted in UTC, ISO-8601. Conversion happens
in the client, using `users.timezone`.

Changing `users.timezone` does not move existing events. This was decided
explicitly — don't "fix" it.

The chat system prompt must include the current date, time, and the user's
timezone on every call. Without it, "קבע פגישה ביום שלישי ב-10" cannot be
resolved and the model will invent a date.

`create_event` with no `ends_at` defaults to 60 minutes.

---

## 4. Source of truth and documentation

`TASKS.md` drives the build (Phase 0 → 6). Read the task before starting, run
`git status`, and update the task entry in the same turn you finish it.

Status line goes directly under the task heading:
`DONE (commit <sha>)` · `DONE (local, uncommitted)` · `PARTIAL` ·
`NEEDS FOLLOW-UP` · `BLOCKED` · `OBSOLETE`

Include: files changed, tests run, deviations from spec, what remains.
Don't rewrite the original `What to do` / `Definition of Done` lines.
If the repo and `TASKS.md` disagree, fix `TASKS.md` immediately.

`API_CONTRACT.md` is a real deliverable — the frontend is built by a different
developer who never reads this code. Update it in the same turn as any change
to an endpoint, payload shape, status code, enum, or error response. Mark
breaking changes as `BREAKING` with the date so they're findable by diff.

It must always be accurate about: the idempotency status codes, the exact wire
shape of `pending_action` and `{ confirm: true, message_id }`, UTC formatting,
enum values (`role`, `language`, `platform`), and rate-limit responses.

Don't log internal refactors there.

---

## 5. Model selection

Recommend once before meaningful work, then stop:

`Model recommendation: <Haiku|Sonnet|Opus|Fable> — <reason>. Switch with /model <name>, or say "go".`

- **Sonnet** — normal implementation: tasks/events CRUD, devices, agenda,
  validators, tests, docs.
- **Opus** — schema and migrations, the chat tool-use loop, reminder
  scheduling and cancellation, auth and token rotation, sync semantics,
  spec conflicts, orchestration, final QA.
- **Fable** — see §7.
- No recommendation needed for read-only investigation or one-line fixes.

Never claim to have switched models. The user controls `/model`.

---

## 6. Parallel agents

Before editing: `git status`, avoid files another agent holds, prefer creating
a new helper file over editing a shared one.

High-conflict files:
`TASKS.md` · `API_CONTRACT.md` · `prisma/schema.prisma` · `prisma/migrations/*`
· `src/app.ts` · `src/modules/chat/tools.ts` · `src/modules/chat/router.ts`
· `src/jobs/boss.ts` · `src/lib/zod.ts`

**Migrations are orchestrator-only.** One agent may edit `schema.prisma`, and
only the orchestrator generates migrations. Two agents generating migrations
in parallel produces a history that is genuinely painful to unwind.

**`tools.ts` is orchestrator-only** when more than one tool is being added.
The tool schemas, the executors, and the ownership checks have to stay in
sync; splitting them across agents is how one of the three gets forgotten.

Sub-agent prompts must specify: task ID, exact goal, allowed files, files to
avoid, tests to run, known risks, expected output, and a reminder to report
any `TASKS.md` or `API_CONTRACT.md` impact.

Sub-agents report: what changed, files touched, tests run, remaining risks,
deviations from scope, doc impact.

Use Haiku only for grep, file inventory, stale-reference hunting, and test
output summaries. Not for schema, auth, scheduling, or the chat loop.

---

## 7. Fable in multi-agent work

Fable is the Mythos-tier model. It is slower and more expensive than Opus, so
it is reserved for work where a wrong decision propagates into many files and
is expensive to reverse later.

**Use Fable as orchestrator when:**
- the work spans Phase 2 + Phase 3 + Phase 4 together — sync, scheduling, and
  the chat loop interact, and getting the interaction wrong is a rewrite
- the data model is being changed after Phase 2 has shipped, where a migration
  has to preserve existing rows
- three or more sub-agents are running against overlapping modules
- a decision from `SPEC_BACKEND_V1.2.md` turns out to be wrong mid-build and
  the correction has to be reasoned through the whole stack
- reconciling a genuine conflict between the product spec, the backend spec,
  and what the code actually does

**Do not use Fable for:** routine CRUD, tests, formatting, doc updates,
isolated modules, or anything a single Sonnet agent can finish alone. Using it
there costs time and buys nothing.

**When Fable orchestrates:**
- it owns the plan, the file-assignment map, and the integration
- sub-agents run on Sonnet for implementation, Haiku for search
- it does not delegate the decisions that made it the right choice — schema
  shape, migration strategy, tool contracts, and confirmation-flow semantics
  stay with Fable
- it reviews the actual diffs, not the summaries
- it produces the final QA report (§9)

**Escalation to Fable mid-task** is allowed and expected when an Opus or Sonnet
agent discovers the change is structurally larger than the task described.
State the reason, stop, and recommend the switch. Don't push through a
structural change with the wrong model because a switch feels like a setback.

---

## 8. QA after sub-agents

The orchestrator owns final quality. "Tests pass" and "TypeScript compiles"
are signals, not verification.

Required every time:
- scope completed, no unintended files touched
- matches `TASKS.md` and the spec
- `npx tsc --noEmit` passes when TypeScript changed
- migration is reversible and doesn't drop data, when migrations changed
- `TASKS.md` and `API_CONTRACT.md` updated where required
- the actual diff was read

Behavioral checks, by area:

**Sync** — create, edit, delete, then `updatedSince` from before each: does the
delete come back with `deleted_at`? Does `updated_at` move on delete? Does a
replayed `POST` return the existing row instead of a duplicate?

**Chat** — does a tool proposal persist as `pending_action`? Does the executor
refuse to run without a confirm? Does a confirm for another user's
`message_id` get rejected? Does a hallucinated `task_id` belonging to another
user fail the ownership check? Are two rapid messages serialized per user?

**Reminders** — is a job scheduled on create? Rescheduled on time change?
Cancelled on delete and on task completion? Does `reminder_minutes_before =
NULL` schedule nothing? Does a past-dated event avoid scheduling a job that
fires immediately?

**Auth** — does an expired access token fail? Does refresh rotate? Does logout
delete the device row for that request's push token?

**Account deletion** — does `DELETE /me` set `deletion_requested_at` and kill
sessions? Does signing back in within 30 days cancel it? Does the daily purge
job only take users past the window?

Test review: assertions must be behavioral. A test that would still pass if the
handler were wired to the wrong module isn't a test. Cover the negative cases —
permission denied, empty state, invalid input — not only the happy path.
Test count is not evidence.

If QA finds a problem: fixes to Sonnet, searches to Haiku, schema/migration/
flow corrections stay with the orchestrator. Re-QA after the fix. Don't commit
before the recheck.

---

## 9. Before final response

Run relevant tests · `npx tsc --noEmit` if TypeScript changed · verify
migrations if migrations changed · update `TASKS.md` · update
`API_CONTRACT.md` if the contract moved · `git status` · read the diffs ·
verify the scenarios in §8 that the change touches.

Report:
- task IDs completed
- files changed, files manually reviewed
- scenarios actually verified (distinguish from "tests passed")
- test and TypeScript results
- commit SHA or local/uncommitted
- remaining risks

If sub-agents were used, also report which models were used, what each did,
what the orchestrator verified independently, and what was sent back after QA.

Sub-agent output is not final until the orchestrator has completed QA.