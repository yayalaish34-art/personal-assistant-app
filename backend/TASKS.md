# TASKS.md — Backend Build Log

מקור האמת ל-build. כל task נסגר עם שורת סטטוס מתחת לכותרת:
`DONE (commit <sha>)` · `DONE (local, uncommitted)` · `PARTIAL` · `NEEDS FOLLOW-UP` · `BLOCKED` · `OBSOLETE`

מבנה כל task: כותרת → שורת סטטוס → `What to do` → `Definition of Done`. אל תשכתב את שתי השורות האחרונות — הוסף מידע מעל/מתחת.

---

## Phase 0 — Foundation

### T0.1 — Migrate to TypeScript
DONE (local, uncommitted)
Files changed: `package.json` (added helmet, tsx, typescript, @types/*; removed morgan; updated scripts), `tsconfig.json` (new, strict ES2022/ESNext/Bundler), `src/index.ts` (new minimal placeholder), `.gitignore` (added dist/, .env, .env.local).
Files deleted: `src/index.js`, `src/store.js`, `src/routes/events.js`, `src/routes/journal.js`. No `data/` dir existed.
Tests run: `npx tsc --noEmit` — zero errors. `npm run dev` started server; `GET /health` returned 200 `{"status":"ok"}`.
Deviations: none.
**What to do:** להמיר את `backend/src/*.js` הקיים ל-TypeScript. להוסיף `tsconfig.json`, `@types/*`, `ts-node-dev` (או `tsx`) ל-dev. לעדכן `package.json` scripts.
**Definition of Done:** `npx tsc --noEmit` עובר, `npm run dev` מריץ שרת ריק, `.js` ישנים הוסרו.

### T0.2 — Docker Compose for Postgres
DONE (local, uncommitted)
Files created: `docker-compose.yml` (postgres:16-alpine, container `personal-assistant-db`, port 5432, named volume `pg_data`, healthcheck via `pg_isready`), `.env.example` (all §10 env vars with placeholder values, grouped and commented). Docker test: `docker compose up -d` reached `(healthy)` status in ~57 seconds; `docker compose down` cleaned up successfully. Docker binary lives at `C:\Program Files\Docker\Docker\resources\bin\docker.exe` (not on system PATH by default — devs must add it or use Docker Desktop terminal).
**What to do:** קובץ `docker-compose.yml` עם Postgres 16, volume, פורט 5432. משתמש/סיסמה מקומיים בלבד. `.env.example` עם `DATABASE_URL`.
**Definition of Done:** `docker compose up -d` מעלה DB בריא, `psql` מתחבר.

### T0.3 — Prisma schema + initial migration
DONE (local, uncommitted) · **Orchestrator only** (§6)
Files created: `prisma/schema.prisma`, `prisma/migrations/20260723200828_init/migration.sql`. `package.json` gained `prisma@6` (dev) and `@prisma/client@6`. `.env` (local, gitignored) created from `.env.example`.
Enums: `AuthProvider(google,apple)`, `Language(he,en)`, `ChatRole(user,assistant,tool)`, `DevicePlatform(ios,android,web)`. Tables: users, tasks, events, chat_messages, devices — all with `@map` to snake_case columns, `@db.Timestamptz(6)` on time fields, `@db.JsonB` on `tool_calls` / `pending_action`, cascade delete from users.
Indexes verified via `psql`: `users(provider,provider_user_id) UNIQUE`; `tasks(user_id,due_at)` + `tasks(user_id,updated_at)`; `events(user_id,starts_at)` + `events(user_id,updated_at)`; `chat_messages(user_id,created_at DESC)`; `devices(platform,push_token) UNIQUE` + `devices(user_id)`.
Tests run: `npx prisma format` ok; `npx prisma migrate dev --name init` applied cleanly; `\dt` shows 5 domain tables + `_prisma_migrations`; `npx tsc --noEmit` still passes.
Deviations: chose **Prisma 6** (not 7). Prisma 7 moves `url` out of schema into `prisma.config.ts` + requires an adapter — added friction with no MVP benefit. Documented for future upgrade decision.
Notes: no `refresh_tokens` table yet — will be added in Phase 1 (T1.3) as a separate migration.
**What to do:** `prisma/schema.prisma` לפי `SPEC_BACKEND_V1.2.md` §2. כולל אינדקסים: `events(user_id, starts_at)`, `events(user_id, updated_at)`, `tasks(user_id, due_at)`, `tasks(user_id, updated_at)`, `chat_messages(user_id, created_at DESC)`. Enums: `provider`, `language`, `role`, `platform`. Unique: `(provider, provider_user_id)` על users, `(platform, push_token)` על devices.
**Definition of Done:** `npx prisma migrate dev --name init` עובד, כל הטבלאות נוצרות, ניתן לעשות rollback דרך `migrate reset`.

### T0.4 — Config, logging, error handler
DONE (local, uncommitted)
Files created: `src/config.ts` (Zod env parse, fail-fast exit on missing DATABASE_URL), `src/lib/errors.ts` (AppError abstract base + 8 typed subclasses + isAppError helper), `src/lib/logger.ts` (pino with pino-pretty transport in dev, plain JSON in prod/test), `src/middleware/errorHandler.ts` (errorHandler + notFoundHandler + httpLogger with authorization redaction).
Deps added: `zod`, `pino`, `pino-http` (dependencies); `pino-pretty` (devDependency).
Tests run: `npx tsc --noEmit` — zero errors. Config smoke: `tsx --env-file=.env` loaded config object with all fields typed correctly. Logger smoke: pino-pretty emitted colorized INFO/ERROR lines in dev mode.
Deviations: none. Error shape exactly matches API_CONTRACT.md. JWT_SECRET/JWT_REFRESH_SECRET marked optional (Phase 0); T1 will tighten.
**What to do:** `src/config.ts` עם `zod.parse(process.env)` fail-fast. `src/lib/errors.ts` (AppError, NotFound, Forbidden, Conflict, RateLimited). `src/middleware/errorHandler.ts` שממפה ל-JSON. `pino` logger + `pino-http`.
**Definition of Done:** חסר משתנה סביבה → השרת נופל עם הודעה ברורה. שגיאה zoruk מוחזרת כ-JSON תקין. logs ב-JSON structured.

### T0.5 — Express app skeleton + health
DONE (local, uncommitted)
Files created: `src/app.ts` (exports `createApp()` + `app`; wires `helmet`, `cors`, `express.json({ limit: '1mb' })`, `httpLogger`, `/health` returning `{status,version}`, `notFoundHandler`, `errorHandler`; version read from `package.json` via `createRequire`), `src/index.ts` (bootstrap: `app.listen(config.PORT)` + SIGINT/SIGTERM graceful shutdown).
Also changed: `package.json` scripts — `dev` and `start` now include `--env-file=.env` (Node 20.6+/tsx). Without it config crashes on missing `DATABASE_URL`.
Tests run: `npx tsc --noEmit` — zero errors. `npm run dev`: `GET /health` → 200 `{"status":"ok","version":"1.0.0"}`. `GET /does-not-exist` → 404 `{"error":{"code":"NOT_FOUND","message":"Route not found","details":{}}}` — matches `API_CONTRACT.md` error shape exactly.
Deviations: CORS is open (`cors()` with no options) for Phase 0. T6.3 (security review) will tighten to an allowlist. Noted inline.
**What to do:** `src/app.ts` (testable), `src/index.ts` (bootstrap). `helmet`, `cors` מוגבל, `express.json`. `/health` מחזיר `{ status: 'ok', version }`.
**Definition of Done:** `curl :5000/health` → 200. `app.ts` יבוא מ-tests.

---

## Phase 1 — Auth & Users

### T1.1 — Google Sign-in
DONE (local, uncommitted) · **Orchestrator**
Deps added: `google-auth-library`, `jsonwebtoken`, `@types/jsonwebtoken`, `jose`.
Files created: `src/db.ts` (shared Prisma client), `src/lib/tokens.ts` (access JWT + opaque refresh w/ SHA-256 hash + rotation + revoke helpers), `src/modules/auth/providers/google.ts` (verifies via `OAuth2Client.verifyIdToken` with `GOOGLE_CLIENT_ID`), `src/modules/auth/service.ts` (`signInFromIdentity` upsert + issue pair; clears pending deletion), `src/modules/auth/router.ts` (POST /google → sign in).
Config tightened: `JWT_SECRET`/`JWT_REFRESH_SECRET` now required (min 32 chars). Real secrets set in `.env`.
Tests: `npx tsc --noEmit` clean. Runtime verification deferred to T1.5 smoke (which exercises the auth stack end-to-end via a manufactured access token).
**What to do:** `POST /auth/google` עם `google-auth-library`. verify ID token, upsert user לפי `(provider, provider_user_id)`. הנפקת access (15min) + refresh (30d).
**Definition of Done:** ID token תקין → 200 + tokens + user. Token זויף → 401. משתמש חדש נוצר, קיים מתעדכן.

### T1.2 — Apple Sign-in
DONE (local, uncommitted) · **Orchestrator**
Files created: `src/modules/auth/providers/apple.ts` — `jose.createRemoteJWKSet(https://appleid.apple.com/auth/keys)` + `jwtVerify` with issuer `https://appleid.apple.com` and `audience=APPLE_CLIENT_ID`. Falls back name to email (Apple only sends name on first sign-in through a separate client payload). Wired POST /apple in the auth router.
Tests: `npx tsc --noEmit` clean. Bad audience/issuer → 401 via jose throwing → mapped by `Unauthorized`.
**What to do:** `POST /auth/apple` — fetch JWKS מ-Apple, verify ID token, upsert.
**Definition of Done:** אותו חוזה כמו Google. שגיאה ברורה על audience/issuer לא תואמים.

### T1.3 — Refresh + logout
DONE (local, uncommitted) · **Orchestrator**
Schema: added `RefreshToken` model (`token_hash` UNIQUE, `expires_at`, `revoked_at`, cascade from user). Migration `20260726102911_refresh_tokens` applied.
Files: `src/lib/tokens.ts` — `issueRefreshToken`, `rotateRefreshToken` (single tx: verify → revoke old → create new), `revokeRefreshToken` (idempotent), `revokeAllRefreshTokensForUser` (used by T1.5 DELETE /me).
Router: POST /auth/refresh rotates and returns new pair. POST /auth/logout revokes refresh + deletes device row by pushToken (both optional).
Semantic guarantees: reusing a rotated refresh → 401 (rows come back with `revokedAt` set → rejected by the transaction). Logout is idempotent for both fields.
**What to do:** `POST /auth/refresh` עם rotation (refresh ישן בטל). `POST /auth/logout` מוחק refresh + מוחק את ה-device של ה-`pushToken` שנשלח.
**Definition of Done:** refresh משומש פעם שנייה → 401. logout מבטל את ה-session ומוחק row מ-devices.

### T1.4 — Auth middleware
DONE (local, uncommitted) · **Orchestrator**
File: `src/middleware/auth.ts` — extracts Bearer, `verifyAccessToken`, then hits DB for the user (id/timezone/language, `deletedAt=null`). Attaches `req.user`. Missing header / bad token / expired / user gone → 401 via `Unauthorized`. Express Request augmented via module augmentation.
Trade-off: one indexed PK lookup per authenticated request. Bought us fresh `timezone`/`language` after PATCH /me and defence-in-depth against tokens for soft-deleted users. Acceptable for MVP.
**What to do:** `src/middleware/auth.ts` — verify JWT, `req.user = { id, timezone, language }`. 401 על חסר/פג/פסול.
**Definition of Done:** endpoint מוגן מחזיר 401 בלי header, 200 עם header תקין.

### T1.5 — Users module (/me)
DONE (local, uncommitted)
Files created: `src/modules/users/router.ts` (GET/PATCH/DELETE /me, guarded by authMiddleware).
Files edited: `src/app.ts` (added usersRouter import + `app.use('/', usersRouter)`).
Curl results: GET /me → 200 + user shape; PATCH /me {name:"New"} → 200 updated; PATCH /me {} → 400 VALIDATION_ERROR; DELETE /me → 202 + deletionRequestedAt; second DELETE → 202 same timestamp (idempotent); GET /me after DELETE → 200 (deletionRequestedAt set, not deletedAt). npx tsc --noEmit: zero errors (before and after smoke). Test user cleaned up via prisma.deleteMany.
Deviations: none.
**What to do:** `GET /me`, `PATCH /me` (name, language, timezone), `DELETE /me` (soft — `deletion_requested_at = NOW()`, refresh tokens נמחקים).
**Definition of Done:** תרחישי §8 QA של auth ו-account deletion (ראה CLAUDE.md §8) עוברים בטסטים.

---

## Phase 2 — Tasks, Events, Sync, Agenda

### T2.1 — Tasks CRUD
DONE (local, uncommitted)
Files created: `src/modules/tasks/router.ts` (single file — router + `serializeTask` exported together).
Serializer smoke: fed a fake Prisma Task object to `serializeTask`, all 9 field assertions passed (nulls, ISO strings, notes/dueAt fallback).
tsc result: `npx tsc --noEmit` — zero errors.
Deviations: none. `GET /tasks` with no `updatedSince` excludes soft-deleted rows (contract: "No updatedSince → returns everything the user has (not deleted)"). With `updatedSince` present, soft-deleted rows are included (contract: "Deleted rows are included so the client can remove them locally"). `PATCH` and `DELETE` both return 404 for missing, wrong-user, or soft-deleted rows (no existence leakage). Temp smoke script deleted.
**What to do:** `POST` idempotent על id, `GET ?updatedSince=` כולל מחוקים, `PATCH`, `DELETE` (soft, bump `updated_at`). Ownership check על כל mutation.
**Definition of Done:** תרחישי sync ב-§8 של CLAUDE.md עוברים. POST חוזר עם אותו id → 200 (לא כפילות). id של משתמש אחר → 409.

### T2.2 — Events CRUD
DONE (local, uncommitted)
Files created: `src/modules/events/router.ts` (single file: serializer + all four endpoints).
Endpoints: `GET /events?updatedSince=`, `POST /events` (idempotent on id, endsAt default +60min, endsAt>startsAt validation), `PATCH /events/:id` (merged-state time validation, empty-body 400, 404 hides ownership), `DELETE /events/:id` (soft delete, Prisma @updatedAt bumps automatically).
Serializer: `serializeEvent(e)` emits all fields per API_CONTRACT.md — ISO strings, reminderMinutesBefore as number|null, deletedAt as ISO|null.
Tests run: `npx tsc --noEmit` — zero errors. Serializer smoke (shape + null cases) — PASS. Router import confirms correct load (halts at config env-var check as expected without .env).
Deviations: none. Does not touch app.ts; orchestrator wires the router.
**What to do:** אותו דבר כמו Tasks + שדה `reminder_minutes_before`. בלי תזמון עדיין (Phase 3).
**Definition of Done:** אותם תרחישי sync.

### T2.3 — /agenda
DONE (local, uncommitted)
Files created: `src/modules/agenda/dateRange.ts` (tz helpers: `toUtcDayBoundary`, `dayRangeInTz`, `rangeInTz`), `src/modules/agenda/router.ts` (GET /agenda, guarded by authMiddleware, local serializers for Task and Event).
Tz smoke results: `toUtcDayBoundary('2026-07-26','Asia/Jerusalem')` → `2026-07-25T21:00:00.000Z`; UTC → `2026-07-26T00:00:00.000Z`; London summer → `2026-07-25T23:00:00.000Z`; IL winter → `2026-01-14T22:00:00.000Z`; bad IANA fallback → `2026-07-26T00:00:00.000Z`. All match expected.
`npx tsc --noEmit`: zero errors. `src/app.ts` not touched — orchestrator wires.
Deviations: serializeTask/serializeEvent are local copies (T2.1/T2.2 were in-flight); orchestrator to DRY up.
**What to do:** `GET /agenda?date=YYYY-MM-DD` או `?from=&to=`. מחזיר `{ events, tasks }` עם משימות שיש להן `due_at` בטווח.
**Definition of Done:** `date` יחיד → יום אחד. `from/to` → טווח. לא כולל מחוקים. סינון לפי user_id בלבד.

### T2.4 — Sync tests
DONE (local, uncommitted)
File created: `tests/sync.test.ts` (12 tests, all passing — 6 for tasks, 6 for events).
Key scenarios verified: (1) POST with client UUID → 201 + body echo; (2) idempotent replay → 200 existing row, no duplicate; (3) cross-user same id → 409; (4) updatedSince cursor roundtrip — edited row appears before cursor, absent after cursor; (5) soft-delete: deletedAt set, updatedAt bumped, row in updatedSince query with deletedAt, absent from plain GET; (6) cross-user PATCH/DELETE → 404, no leakage, original untouched. Event-specific: endsAt defaults to startsAt+60min verified. Env loading: package.json test script updated to `node --env-file=.env node_modules/vitest/vitest.mjs run`. DB cleanup confirmed: 0 @test users remain post-run. tsc: pre-existing errors in `src/jobs/boss.ts` (T3.2 territory) only — no errors from T2.4 files.
**What to do:** `tests/sync.test.ts` שמכסה: create → updatedSince, edit → updatedSince, delete → updatedSince, replay POST, cross-user 409.
**Definition of Done:** כל תרחיש עובר. הטסטים behavioral (§8 test review).

---

## Phase 3 — Notifications & Reminders

### T3.1 — pg-boss init
DONE (local, uncommitted) · **Orchestrator only** (§6 — `boss.ts`)
Deps added: `pg-boss@12`.
Files: `src/jobs/boss.ts` — exports `startBoss()`, `stopBoss()`, `getBoss()`, and `JobName` enum + `SendReminderPayload`/`PurgeDeletedUsersPayload`. Queues `send-reminder` and `purge-deleted-users` are created on start with per-queue retry policy (retryLimit=3, retryDelay=60s, retryBackoff=true). Singleton pattern; `getBoss()` throws before `startBoss()`.
Edited: `src/index.ts` — bootstrap now `async main()` that awaits `startBoss()` before `app.listen()`; SIGINT/SIGTERM awaits `stopBoss()`.
Deviations: retry options moved to per-queue (pg-boss v12 API no longer accepts them at constructor level).
**What to do:** `src/jobs/boss.ts` — init pg-boss מול ה-DB הקיים. job types: `send-reminder`, `purge-deleted-users`.
**Definition of Done:** pg-boss עולה עם השרת, טבלאות schema נוצרות ב-Postgres.

### T3.2 — Devices register/upsert
DONE (local, uncommitted)
File created: `src/modules/devices/router.ts` — exports `devicesRouter`. Single `POST /devices` endpoint guarded by `authMiddleware`. Zod body: `{ pushToken: string.min(1), platform: enum['ios','android','web'] }`. Upserts on `(platform, pushToken)`: create if absent, update `lastSeenAt` + reassign `userId` if present (covers both same-user refresh and cross-user phone account change). Serializer exposes only `id/platform/lastSeenAt` — no `pushToken` or `userId` leakage.
Smoke (3 calls, device.id=`8cf488bb`): Call 1 created row (userId=user1); Call 2 same user returned same row id with bumped `lastSeenAt`; Call 3 different user (user2) reassigned same row — `userId` updated, same row id, `lastSeenAt` bumped. Only 1 device row in DB throughout. All assertions passed.
tsc: 2 pre-existing errors in `boss.ts` (orchestrator's T3.1 file); zero errors introduced by devices router.
Deviations: none. `app.ts` not touched — orchestrator wires after this report.
**What to do:** `POST /devices` upsert על `(platform, push_token)`. אם token שייך למשתמש אחר — reassign.
**Definition of Done:** אותו token של אותו משתמש → אותו row, `last_seen_at` מתעדכן. Token של משתמש אחר → הועבר.

### T3.3 — Reminder scheduling
DONE (local, uncommitted) · **Orchestrator only**
Files created: `src/modules/events/reminders.ts` — `scheduleEventReminder(event)` and `cancelEventReminder(eventId)`. Uses pg-boss `singletonKey = eventId` so at most one pending job per event. Rules: `reminderMinutesBefore === null` → cancel any pending; `reminderTime <= now` → cancel any pending; else `boss.upsert` with new `startAfter` (safe on create AND update).
`cancelEventReminder` uses `findJobs({ key: eventId, queued: true })` then `deleteJob`.
Both wrappers catch errors from `getBoss()` / boss RPCs and log warnings — a reminder-scheduling failure never breaks the API request. Tests can therefore run without starting pg-boss (chosen over adding globalSetup complexity).
Edited: `src/modules/events/router.ts` — hooks wired: POST calls `scheduleEventReminder(created)`; PATCH calls it when `startsAt` or `reminderMinutesBefore` was in the update; DELETE calls `cancelEventReminder(id)`.
Handler-side defence at fire time (T3.4) still re-checks `deletedAt` — belt-and-braces against races between delete and fire.
Tests: 12/12 sync tests still pass. tsc clean.
**What to do:** hooks על create/update/delete event: אם `reminder_minutes_before != NULL` וזמן ההתראה בעתיד → schedule job. Update מבטל ו-reschedules. Delete מבטל. תיעוד: מפתח job הוא `event_id`.
**Definition of Done:** תרחישי Reminders ב-§8 עוברים. אירוע עבר → לא נדחף job. `NULL` → לא נדחף job.

### T3.4 — Push sender
DONE (local, uncommitted)
Files created: `src/jobs/sendReminder.ts` (handler + localisation), `src/jobs/register.ts` (exports `registerJobHandlers`).
Handler: fetches event (deletedAt: null guard), checks reminderMinutesBefore not null, verifies ±5 min wall-clock sanity, loads user+devices, builds Hebrew/English push messages, sends via Expo chunkPushNotifications/sendPushNotificationsAsync, deletes device row on DeviceNotRegistered ticket.
Smoke: fake device with invalid ExponentPushToken; Expo returned DeviceNotRegistered; device row deleted — PASS.
tsc: zero errors from T3.4 files; 4 pre-existing errors in `src/modules/chat/persistence.ts` (T4.1 territory, not introduced here).
Deviations: pg-boss WorkHandler signature is `(Job[]) => Promise<void>` (batch), not single-job — handler wraps per-job processing in a for-loop with individual try/catch.
**What to do:** `sendReminder` handler שולף event, בונה הודעה בשפת המשתמש, שולח דרך `expo-server-sdk` לכל ה-devices של המשתמש.
**Definition of Done:** job שרץ שולח push. אם ה-token invalid — מוחק את ה-device. Errors מתועדים ב-pino.

---

## Phase 4 — Chat & Tools

### T4.1 — Chat messages persistence
DONE (local, uncommitted)
Files created: `src/modules/chat/persistence.ts` (serializeChatMessage, saveUserMessage, saveAssistantMessage, saveToolMessage, getRecentHistory, clearPendingAction, findAssistantMessageWithPending), `src/modules/chat/historyRouter.ts` (GET /chat/history, cursor pagination, exports chatHistoryRouter).
Smoke outcomes (18/18 pass): getRecentHistory returned 3 msgs oldest-first; page1 (limit=2) returned m3+m2 newest-first with nextCursor=m2.id; page2 (cursor=m2.id, limit=2) returned m1 with nextCursor=null; pendingAction find/clear round-trip correct; serializer preserves null for optional JSON fields with Z-suffix ISO timestamps.
tsc: clean (zero errors in new files).
Deviations: Prisma nullable JsonB fields require `Prisma.DbNull` (not `null`) for writes and `Prisma.AnyNull` for `{ not: ... }` filter.
**What to do:** מודל `chat_messages` (כבר בסכימה). helpers לשמירה/קריאה. `GET /chat/history?cursor=&limit=` עם pagination.
**Definition of Done:** קריאה ב-order יציב, cursor עובד קדימה, `limit` מוגבל ל-100.

### T4.2 — System prompt builder
DONE (local, uncommitted)
Files created: `src/modules/chat/prompt.ts` (exports `PromptContext` interface + `buildSystemPrompt` function — pure, no LLM/HTTP/DB), `tests/prompt.test.ts` (14 tests across 3 suites: Hebrew/Jerusalem, English/UTC, invalid-timezone fallback).
Test count: 14 new (all pass) + 12 existing sync tests = 26 total passing.
tsc: 2 pre-existing errors in T4.1's `persistence.ts`; zero errors from T4.2 files.
Deviations: none. Bad-timezone fallback uses try/catch around `Intl.DateTimeFormat` constructor; effective timezone is returned so prompt uses `UTC` label correctly.
**What to do:** `src/modules/chat/prompt.ts` — בונה system prompt כולל: תאריך UTC, שעה מקומית של המשתמש, `timezone`, `language`, שם, כלל "אין ביצוע אוטומטי".
**Definition of Done:** unit test מוודא שהתאריך והשעה נכללים ומעודכנים.

### T4.3 — Tools + executors
DONE (local, uncommitted) · **Orchestrator only** (§6 — `tools.ts`)
File: `src/modules/chat/tools.ts` — OpenAI function-calling `TOOL_DEFINITIONS` for 6 tools (`create_task`, `update_task`, `complete_task`, `list_tasks`, `create_event`, `list_events`). Field names snake_case (matches SPEC §5). Per-tool Zod arg schemas in `ARG_SCHEMAS`; `parseArgs(name, raw)` validates. `isReadOnlyTool` marks `list_*` as inline-executable.
Executors:
- `executeReadOnlyTool` for `list_tasks` / `list_events` — filters by userId, returns JSON string for the LLM. `list_tasks` supports ranges `today/week/overdue/all`; `list_events` uses overlap semantics `startsAt < to AND endsAt > from`.
- `buildPendingAction(name, args)` for mutating tools — returns `{ tool, arguments }` shape stored on assistant messages.
- `executePendingAction(action, userId)` — re-validates args (defence in depth), does `existing.userId !== userId` ownership check on `update_task`/`complete_task`, calls `scheduleEventReminder` after `create_event`. Returns typed `ExecutionSuccess | ExecutionFailure`. Hallucinated ids → `NOT_FOUND` (not `FORBIDDEN`) to avoid leaking existence.
Note: `create_event` default of 60 min applied here too, mirroring the REST endpoint.
**What to do:** `src/modules/chat/tools.ts` עם Zod schemas + executors + ownership check לכל tool. Tools: `create_task`, `update_task`, `complete_task`, `list_tasks`, `create_event` (default 60min), `list_events`. Executor מוודא `resource.user_id === token.user_id`.
**Definition of Done:** כל tool עובר Zod. hallucinated id → executor מחזיר שגיאת ownership. `list_*` מסונן ל-user_id.

### T4.4 — Chat router + confirmation flow
DONE (local, uncommitted) · **Orchestrator only** (§6 — `router.ts`)
Files: `src/modules/chat/router.ts` (POST /chat/message), `src/modules/chat/mutex.ts` (per-user in-memory serialization), `src/modules/chat/llm.ts` (`getOpenAI()` singleton + `CHAT_MODEL='gpt-4o-mini'`).
Body: Zod validates exactly one of `text` xor `confirmMessageId`. All calls wrapped in `withUserLock(userId, ...)`.
Confirm flow: `findAssistantMessageWithPending` → `executePendingAction` → `clearPendingAction` → save `role='tool'` message with the original OpenAI `tool_call_id` → `runFollowUp` narrates result with `tool_choice: 'none'`.
Text flow: save user msg → loop up to 3 read-only tool rounds (`MAX_READ_ONLY_LOOPS`). Mutating tool → save assistant with `pendingAction` + `toolCallId`, return the card. Read-only → execute, save tool message, iterate. Text-only → save assistant, done.
OpenAI SDK v6: guarded `toolCall.type === 'function'` before accessing `.function`. Uses `TOOL_DEFINITIONS`, `tool_choice: 'auto'` (or `'none'` for follow-up).
Wired in app.ts. `chatLimiter` applied to `POST /chat/message` per T4.5.
Tests: 26/26 still pass. tsc clean.
**What to do:** `POST /chat/message`:
- אם `confirmMessageId` נשלח → שולף `pending_action` מהודעת ה-assistant, מריץ את ה-tool, שומר תוצאה כהודעת `tool`, מנקה `pending_action`.
- אחרת → קריאה ל-LLM, אם הוחזר tool_call → שומר `pending_action` ומחזיר כרטיס אישור. אם טקסט → שומר ומחזיר.
Per-user mutex.
**Definition of Done:** תרחישי Chat ב-§8 עוברים. שני messages רצופים מאותו משתמש — סדרתיים.

### T4.5 — Rate limits
DONE (local, uncommitted)
File created: `src/middleware/rateLimit.ts` — exports `chatLimiter` (array: 30/min + 500/day per user id), `speechLimiter` (10/min per user id), `authLimiter` (20/min per IP). All use `handler: next(new RateLimited(...))` so errors flow through the central error handler. User-key generators fall back to `ipKeyGenerator(req.ip)` if `req.user` is absent. Dep added: `express-rate-limit@^8.6.0`. Wire: `authLimiter` inserted into `src/app.ts` on `/auth` mount; `chatLimiter`/`speechLimiter` exported for orchestrator to apply in T4.4 and T5.1 routers. Smoke: 21 req from IP-A → req #21 returned 429 `RATE_LIMITED` + `Retry-After: 60`; 20 req from IP-B → all 200. tsc: zero errors in T4.5 files (2 pre-existing errors in `chat/router.ts`, T4.4 territory). 26/26 existing tests pass.
**What to do:** middleware לפי משתמש: chat 30/min + 500/day, speech 10/min, auth 20/min per IP.
**Definition of Done:** חריגה → 429 עם `Retry-After`.

---

## Phase 5 — Speech

### T5.1 — /speech/transcribe
DONE (local, uncommitted)
File created: `src/modules/speech/router.ts` (exports `speechRouter`). Deps added: `multer` (dep) + `@types/multer` (devDep).
Size/type checks: multer `limits.fileSize=25MB` → 413 `PAYLOAD_TOO_LARGE`; fileFilter rejects non-m4a/webm/mp3/wav by both MIME and extension → 415 `UNSUPPORTED_MEDIA`. Both verified in smoke test.
Whisper path: `toFile(buffer, filename, { type: mimetype })` from `openai/uploads` produces an OpenAI-compatible `Uploadable`; forwarded to `openai.audio.transcriptions.create({ model:'whisper-1', file, language? })`. Language omitted when absent (Whisper auto-detects). No-key guard: throws `ValidationError('Speech transcription is not configured on this server')`.
Whisper happy path DEFERRED — no `OPENAI_API_KEY` in local `.env`; 400 guard confirmed instead.
`npx tsc --noEmit` clean. 26/26 existing tests pass. `app.ts` not touched — orchestrator wires.
**What to do:** `multer` memory storage, גודל מקסימלי 25MB, פורמטים `m4a/webm/mp3/wav`. שליחה ל-Whisper כ-stream. אין כתיבה לדיסק. Content נמחק לאחר התשובה.
**Definition of Done:** אודיו תקין → `{ text }`. גדול מדי → 413. פורמט לא נתמך → 415.

---

## Phase 6 — Housekeeping

### T6.1 — purgeDeletedUsers job
DONE (local, uncommitted) · **Orchestrator**
Files: `src/jobs/purgeDeletedUsers.ts` — `handlePurgeDeletedUsers(jobs)` batch handler with per-job try/catch; hard-deletes users whose `deletionRequestedAt < now - 30d`; Prisma cascade removes tasks/events/chat_messages/devices/refresh_tokens.
`src/jobs/register.ts` edited: registers the handler AND schedules cron `0 3 * * *` (daily 03:00 UTC — `boss.schedule` is idempotent).
Smoke (tsx): created two users, one with `deletionRequestedAt = now-31d`, one with `now-5d`. Ran handler. Old user deleted (`deleted: 1`), recent one survived. Log confirmed cutoff. Both cleaned up after.
Tests + tsc still clean.
**What to do:** job יומי דרך pg-boss cron. שולף users עם `deletion_requested_at < NOW() - 30 days` ומוחק hard: tasks, events, chat_messages, devices, users.
**Definition of Done:** תרחיש deletion ב-§8 עובר. משתמש שחזר בתוך 30 יום — לא נמחק.

### T6.2 — README + .env.example
DONE (local, uncommitted)
Files changed: `/README.md` (rewritten — Hebrew-first, English lede, repo layout, prerequisites, quickstart, docs table), `backend/README.md` (new — stack, directory layout, env vars table, scripts, testing notes, docs map).
Verifications: both files render as valid Markdown (mental check); all quickstart commands (`docker compose up -d`, `npm install`, `npx prisma migrate deploy`, `npm run dev`, `npm test`) already verified working from prior phases; `git status` shows only `/README.md` and `backend/README.md` modified/created (plus `backend/TASKS.md`).
Deviations: T6.1 (`purgeDeletedUsers.ts`) was being built in parallel by orchestrator; its handler file (`src/jobs/purgeDeletedUsers.ts`) is listed in the directory layout as-is. No endpoint or feature invented; all content cross-checked against `API_CONTRACT.md` and `SPEC_BACKEND_V1.2.md`.
**What to do:** README עם: הרצה מקומית (docker + npm), משתני סביבה, מבנה תיקיות, קישור ל-`SPEC_BACKEND_V1.2.md` ו-`API_CONTRACT.md`.
**Definition of Done:** dev חדש עולה על הפרויקט בפחות מ-10 דקות.

### T6.3 — Security review
DONE (local, uncommitted) · **Orchestrator**

Checklist against SPEC §7 + CLAUDE.md §2 invariants:

- [x] **helmet** wired at `src/app.ts:30`. Default headers set (CSP off by default which is fine for a JSON API; RN client doesn't need it).
- [x] **CORS allowlist** — added `CORS_ORIGINS` env var (`src/config.ts` transforms to `string[]`). `src/app.ts` throws on production boot if empty; dev falls back to open `cors()`. `.env.example` documents the setting.
- [x] **x-powered-by** disabled (`src/app.ts:29`).
- [x] **JSON payload cap** — `express.json({ limit: '1mb' })` on `src/app.ts:36`. Multer caps audio at 25MB.
- [x] **Rate limits** — chat 30/min + 500/day (per user id), speech 10/min (per user id), auth 20/min (per IP). All map to `RateLimited` with `Retry-After` header.
- [x] **Authorization header redacted in logs** — `pino-http` `redact: ['req.headers.authorization']` (`src/middleware/errorHandler.ts:14`).
- [x] **No body logging** — pino-http default omits `req.body`. Grep confirms no `logger.info({ body: … })` anywhere in `src/`. Refresh tokens, id tokens, and OpenAI keys never touch the log stream.
- [x] **Ownership from token only** — grep `userId ?[:=] ?req\.user!?\.id` finds 11 matches across tasks/events/agenda/devices/chat routers; grep `req\.(params|query|body)\.userId` finds 0. `authMiddleware` sources id from the verified JWT `sub`, cross-checked against `deletedAt: null` in the DB.
- [x] **Ownership on every mutation** — verified in code review: tasks PATCH/DELETE, events PATCH/DELETE, and every mutating chat tool (`executePendingAction` re-checks `existing.userId !== userId` for update_task, complete_task) return `NOT_FOUND` (never `FORBIDDEN`, to avoid leakage) on cross-user access. Behavioral coverage: `tests/sync.test.ts` cross-user 404 scenarios (2 tests × 2 modules = 4 tests, all pass).
- [x] **Idempotent POST** — same user + same id → 200 (existing row); different user → 409. Covered by `tests/sync.test.ts`.
- [x] **Soft delete + updatedAt bump** — invariant enforced via `prisma.task.update({ data: { deletedAt } })` (Prisma `@updatedAt` bumps). Behavioral test in `sync.test.ts` verifies both.
- [x] **Refresh rotation** — `rotateRefreshToken` is a single Prisma transaction: verify → revoke old → create new. Reusing an already-rotated token → 401 (the old row now has `revokedAt` set). Store is opaque + SHA-256 hashed (`src/lib/tokens.ts`).
- [x] **Session invalidation on delete** — `DELETE /me` calls `revokeAllRefreshTokensForUser` (`src/modules/users/router.ts`).
- [x] **Audio not persisted** — multer `memoryStorage`, never written to disk; streamed to Whisper via `toFile(buffer, filename)`; buffer is garbage-collected after the response.
- [x] **Confirmation gating (CLAUDE.md §2.1)** — mutating tools do not execute inline. `handleUserTurn` saves a `pendingAction` on the assistant message and returns the card. `handleConfirm` is the only path to `executePendingAction` and it requires the `pendingAction` to still be set on the row that belongs to the caller.
- [x] **Config secrets** — `JWT_SECRET`/`JWT_REFRESH_SECRET` required in production (min 32 chars). Zod fail-fast at boot if missing/short.
- [x] **Google / Apple verify** — signed by provider, audience checked against `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID`, Apple JWKS pinned to `appleid.apple.com`.

Deferred to post-MVP:
- Expo push **receipt** verification (`getPushNotificationReceiptsAsync`) — MVP only handles immediate ticket errors.
- Structured audit log for auth failures.
- CSP tightening (irrelevant for JSON-only API).

Final verification: `npx tsc --noEmit` clean; `npm test` 26/26 pass.

**What to do:** helmet מוגדר, CORS origins ב-config, secrets לא ב-logs, rate limits בפועל, ownership checks בכל mutation.
**Definition of Done:** רשימת ביקורת מסומנת ומצורפת ב-report.

---

## Post-QA Fixes

### QA-fix Chat tests
DONE (local, uncommitted)
File created: `tests/chat.test.ts` (17 active tests, 3 skipped — see below).

Scenarios locked in:
- `withUserLock`: serial execution same userId, parallel different userIds, resilience to rejection, Map cleanup (4 tests).
- `executePendingAction`: create_task ownership, update_task cross-user NOT_FOUND, update_task soft-deleted NOT_FOUND, complete_task sets isDone, create_event +60min default, create_event ends_at<=starts_at VALIDATION_ERROR, userId injection defence, missing required arg VALIDATION_ERROR (8 tests).
- `executeReadOnlyTool`: list_tasks all (user isolation + deleted excluded), list_tasks overdue, list_events overlap semantics (3 tests).
- Chat persistence: pendingAction save/find/clear round-trip, cross-user find returns null (2 tests).
- POST /chat/message confirm path: **3 tests skipped** (`describe.skipIf(!OPENAI_API_KEY)`) — confirm create_task, cross-user 404, already-cleared 404. No OPENAI_API_KEY in local env.

tsc: clean. npm test: 66 passed / 3 skipped / 0 failed (69 total including auth + sync + prompt tests).

### QA-fix Auth tests
DONE (local, uncommitted)
File created: `tests/auth.test.ts` (23 tests).

Scenarios locked in:
- **Access token middleware** (tests 1–8): no header, wrong scheme, empty bearer, invalid JWT, wrong-secret JWT, expired JWT, deleted-user JWT, deletionRequestedAt-user allowed through.
- **Refresh + rotation** (tests 9–13): valid rotate returns new tokens, replay of old token → 401, unknown token → 401, expired row → 401, revoked row → 401.
- **Logout QA-2 B-1 fix** (tests 14–18): no auth → 401, own refresh revoked + row has revokedAt, cross-user refresh silent no-op (B token stays active), other-user pushToken not deleted, own pushToken deleted.
- **DELETE /me + purge** (tests 19–22): 202 with both deletionRequestedAt + revoked tokens visible atomically, idempotent (timestamp not overwritten), sign-back-in clears deletionRequestedAt, purge job removes 31-day-old user and keeps 5-day-old user.
- **signInFromIdentity returning-user** (test 23): saved name persists after re-login (QA-2 M-2 / N-3 fix).

tsc: clean. npm test: 66 passed / 3 skipped / 0 failed (69 total — 23 new auth tests all pass).

---

## Phase 7 — Voice assistant

### T7.1 — Voice turn + speech (stateless)
DONE (local, uncommitted)

The app is local-first: tasks and events live on the device, not in this
database. The voice assistant therefore follows `POST /parse` rather than
`POST /chat/message` — stateless, unauthenticated, owning no rows. What it
owns is the provider keys.

Files added: `src/modules/voice/agent.ts`, `src/modules/voice/tts.ts`,
`src/modules/voice/router.ts`. Files changed: `src/app.ts` (mount),
`src/config.ts` (`OPENAI_VOICE_MODEL`, `ELEVENLABS_*`), `.env.example`,
`API_CONTRACT.md`.

- `POST /voice/turn` — the device sends the transcript, the conversation so
  far, and a snapshot of its own tasks and events. The model answers in one
  or two spoken sentences and returns `actions` the **client** applies.
- `GET /voice/speak` — ElevenLabs proxy returning mp3. Only `eleven_v3`
  speaks Hebrew (verified against their /v1/models); other languages use
  `eleven_flash_v2_5`, which is roughly six times faster in testing
  (0.4s vs 2.5s for a sentence).
- Runs on `gpt-4.1-mini`, not the chat model: `gpt-4o-mini` narrated actions
  it had not taken ("I am deleting it now" with no tool call).

Deviation from CLAUDE.md §2.1, deliberate and product-driven: there is no
confirm step. The user asked for an assistant that acts while they talk. The
invariant it replaces:
- Rule §2.2 (never trust an id from the model) is kept and strengthened —
  ids must exist in the snapshot, and every action naming an existing entry
  carries `matchTitle`, checked against that row server-side. This came
  directly from testing: asked to delete a meeting that did not exist, the
  model deleted the nearest one and announced it as the one asked for.
- Deletions are reversible on the client (undo bar), because a spoken
  confirmation is the only signal the user gets.

Verified by hand against a local server (no DB): move-an-event + create-task
in one turn, a schedule question combined with a delete, and a delete of
something not in the snapshot (refused, nothing touched). Hebrew and English
TTS both returned playable mp3.

tsc: clean. npm test: 66 passed / 3 failed — the same 3 that fail on a clean
checkout here, all of which need a live database.

### T7.2 — Every language, not one
DONE (commit 1ece7af) · deployed to Railway production 2026-08-17

What to do: the assistant answers in whatever language the user speaks —
hearing, thinking and speaking all follow the user instead of a setting.
Explicitly requested; the previous pin to one language was itself a request
(see the 2026-08-01 contract entry), which this supersedes.

Files: `src/modules/voice/agent.ts` (prompt: mirror the user's latest message;
`language` now names only the greeting) · `src/modules/voice/tts.ts`
(`modelFor` reads the text's script instead of taking a language — Hebrew
script → `eleven_v3`, else flash) · `src/modules/voice/router.ts` (`language`
optional and ignored on `/voice/speak`) · `tests/voice.test.ts` (32–35) ·
`API_CONTRACT.md` (both routes + change log). Frontend, same turn:
`frontend/src/lib/voice.ts` stops hinting Whisper (auto-detect), sends the
interface language as the greeting language, and drops `language` from the
speak URL.

The moving part worth knowing: the device cannot name the reply's language any
more — it follows the speech, not the settings — so `/voice/speak` decides the
voice model from the text itself. One Hebrew character is enough to pay for
`eleven_v3`; anything else rides flash. The known trade on hearing: without
the Whisper hint, a very short utterance can be detected as the wrong
language. The hint was the old bug's fix, but it made every unhinted language
impossible, which is the thing being removed.

tsc: clean on both sides (backend and frontend). `tests/voice.test.ts`: 43
passed / 1 skipped (test 32 skips itself when `ELEVENLABS_API_KEY` is set, so
the suite never reaches the provider). Full run: 122 passed / 16 failed — all
16 are `PrismaClientInitializationError` from auth/chat/sync against a
localhost Postgres that is not running here, unchanged by this task.

### T7.3 — The interface in 25 languages
DONE (commit 1ece7af) · backend deployed to Railway production 2026-08-17

What to do: ship the app itself in many more languages. T7.2 freed the
*assistant* to answer in any language; the *interface* was still the seven it
shipped with, and the interface language is also what picks her greeting.
Explicitly requested.

Backend files: `src/modules/voice/router.ts` · `src/modules/voice/agent.ts`
(`LANGUAGE_NAMES` now covers all 25) · `tests/voice.test.ts` (24, 31, 32) ·
`API_CONTRACT.md`. Frontend, same turn: `src/lib/i18n.ts` split into
`src/lib/i18n/` — one file per language, plus `types.ts` and `index.ts` —
with 18 new dictionaries; `src/screens/SettingsScreen.tsx` (collapsible
picker).

Three things worth knowing:

1. **`language` on `/voice/turn` stopped being an enum.** It listed the seven
   languages the client shipped with, which tied a client-side list to a
   server deploy: an app updated with an 8th language would send a code the
   enum rejected, take a 400, and lose the entire turn — not just the greeting
   the code was for. It now validates the *shape* of an ISO-639-1 code and
   greets in English for one it has no name for. `/voice/speak` drops
   `language` from its schema entirely (Zod ignores unmentioned query keys, so
   older clients still sending it are unaffected). Test 24 changed from
   "rejects `zz`" to "rejects malformed codes", because `zz` is now well-formed
   and would otherwise have reached OpenAI from the test suite.

2. **Translations are checked by the compiler, not by trust.** `Dict` is
   `Partial<Record<keyof typeof en, string>>`, so a key that is not in English
   fails the build, while a key missing from a translation is legal and falls
   back to English at runtime — which is what makes an unfinished dictionary
   safe to ship. What the compiler cannot see (a key left out, a dropped
   `{{placeholder}}`, a line left in English) is covered by a checker that
   walks the TS AST of every dictionary; all 25 report 195/195 keys, no
   missing, no extra, no placeholder mismatches.

3. **`locale()` was returning invented BCP-47 tags.** It built them by
   uppercasing the code — right for `it-IT` and `fr-FR` by luck, wrong the
   moment the region differs from the language. Adding Japanese or Hindi would
   have produced `ja-JA` and `hi-HI`, which are not locales, and `Intl` falls
   back to English formatting when handed one — every date and time in the app
   would have quietly rendered in English. The tag is now spelled out per
   language in the `LANGUAGES` table.

Languages added: German, Portuguese (BR), Hindi, Chinese (Simplified),
Japanese, Korean, Turkish, Dutch, Polish, Ukrainian, Romanian, Greek, Swedish,
Persian (RTL), Indonesian, Vietnamese, Thai, Bengali. Persian brings the RTL
count to three, and goes through the same `I18nManager` reload path as Hebrew
and Arabic.

tsc: clean on both sides. `tests/voice.test.ts`: 42 passed / 2 skipped (31 and
32 skip themselves when `ELEVENLABS_API_KEY` is set, so the suite never reaches
the provider). Translation checker: 25/25 dictionaries agree with English.

Not verified: the app rendering in each of the 18 new languages on a device,
and the translations themselves were not reviewed by native speakers — see the
remaining risk in the final report.

Verified against the deployed service (not just locally), 2026-08-17:
- `/health` → 200.
- A turn whose `text` is Spanish while `language` is `he` answers in Spanish,
  reads the event back as "a las nueve de la mañana" rather than an ISO
  timestamp, and calls no tool for a read-only question.
- `[SESSION START]` with `language=th` greets in Thai — the exact request the
  previous build answered with a 400.
- `[SESSION START]` with `language=he` still greets in Hebrew.

The frontend was **not** shipped: no EAS build was made, so the store app is
still the old bundle. That ordering is deliberate — the backend had to accept
the new language codes before an app that sends them goes out, and it now
does.

### T7.4 — The opening questionnaire
DONE (local, uncommitted)

**Outside the frozen scope.** `CLAUDE.md` §1 freezes the build at
`SPEC_MVP_V1.1.md`, and onboarding is not in it — it comes from a later spec
document (§2.1, "אונבורדינג ושאלון היכרות"). Requested explicitly, so it is
here and marked, same as `create_image` and `create_note`.

What to do: a short questionnaire on first launch that maps the user's
preferences, producing a profile that feeds the decision engine for the rest
of the time they use the app. Language is asked **first**, and everything
after it — interface and assistant alike — is in the language chosen.

Frontend files: `src/screens/OnboardingScreen.tsx` (new) · `App.tsx` (gate) ·
`src/lib/storage.ts` (`Profile`, `EVENT_TYPES`, `getProfile`/`saveProfile`,
`isOnboarded`/`setOnboarded`) · `src/lib/voice.ts` (sends the profile) ·
`src/lib/i18n/*.ts` (32 new keys × 25 languages).
Backend files: `src/modules/voice/agent.ts` (`profileSchema`, `describeProfile`
in the prompt, threaded into the schedule review) · `src/modules/voice/slots.ts`
(`SlotPrefs`) · `src/modules/voice/schedule.ts` (passes them through) ·
`src/modules/voice/router.ts` (optional `profile`) · `tests/slots.test.ts`
(37–42) · `tests/voice.test.ts` (26b, 26c) · `API_CONTRACT.md`.

Seven steps: language, name, work hours, sleep hours, gap between meetings,
what fills their days, standing commitments. Skippable, and every answer has a
default.

Three decisions worth keeping:

1. **Language is asked first for a mechanical reason, not a cosmetic one.**
   Switching between an LTR and an RTL language flips a native flag that is
   only read when a surface starts, so it can restart the app mid-
   questionnaire. Asking it first means a restart costs nothing — the language
   is already saved and nothing else has been answered. The questionnaire then
   comes back up in the new language. `loadLanguage()` also falls back to the
   device language, so the first question arrives pre-answered with a good
   guess rather than in English for everyone.

2. **Working hours are guidance, not a rule.** Sleep hours and the buffer are
   enforced mechanically in `slots.ts`; working hours only reach the prompt.
   Enforcing them would mean someone who finishes at six could never be
   offered a seven o'clock dinner — worse than the problem it solves. Whether
   an evening is acceptable depends on what is being scheduled, which is a
   judgement, so it belongs with the model.

3. **The profile is opt-in all the way down.** `findFreeSlots` keeps its fixed
   08:00–21:00 window when no prefs are passed, so an install that predates the
   questionnaire behaves exactly as before — and the 37 existing slot tests
   still pass untouched, which is what proves it.

tsc: clean on both sides. `tests/slots.test.ts` 43 passed (37 pre-existing +
6 new); voice/slots/image together 92 passed / 2 skipped. The 16 failures in
the full run are `Can't reach database server at localhost:5432` from the
auth/chat/sync suites — those are Phase 1–4 leftovers for routes this
local-first app no longer uses, and are unrelated to this task.
Translation checker: 25/25 dictionaries at 227/227 keys.

Not verified: the questionnaire on a device, including the RTL restart path
(picking Hebrew, Arabic or Persian from an LTR language), and the 32 new
strings in the 24 non-English dictionaries were machine-translated without
native review.

---

## Phase 8 — Pictures

### T8.1 — Image generation
DONE (local, uncommitted)

**Outside the frozen scope.** `CLAUDE.md` §1 freezes the build at
`SPEC_MVP_V1.1.md` and says to stop and ask rather than build past it. It was
raised as out of scope and then explicitly requested, so it is here, marked,
and easy to find later.

What to do: let the user ask the assistant for a picture and get one back.

Files: `src/modules/image/router.ts` (new) · `src/middleware/rateLimit.ts`
(added `imageLimiter`) · `src/app.ts` (mount) · `src/modules/voice/agent.ts`
(`create_image` in `ACTION_TOOLS` and `ARG_SCHEMAS`) · `tests/image.test.ts`
(new) · `tests/voice.test.ts` (5 cases) · `API_CONTRACT.md`.

Shape: `POST /image` takes a prompt and returns base64 png. The model calls
`create_image`, which reaches the device as an ordinary entry in `actions` —
the device then asks `/image` separately. It is the one action that writes no
row, so it is checked against neither the ownership gate nor the duplicate
gate; both key on fields it does not have, and `tests/voice.test.ts` 21–25 pin
that down rather than leaving it to inspection.

Measured, not estimated: **~35 s** per image and **~1.3 MB** per png, against
the live API with the project key. Both numbers drove the design — 35 s inside
a conversational turn would have looked like a hang, so generation is fired
alongside the reply and filled in when it lands; 1.3 MB is far past what
AsyncStorage is for, so the client writes a file and keeps the path.

Rate limit is deliberately the tightest in the app (4/min, 30/day): a picture
costs orders of magnitude more than a chat turn, and at 35 s a second tap is
more likely to be impatience than intent.

Tests: `tests/image.test.ts` 5 validation cases (none reach OpenAI — that is
the point of them), `tests/voice.test.ts` 21–25 for the tool gate.
tsc clean. 41 passed across the two suites.

Not verified: a generated picture rendering on a real device. The client points
at the Railway deployment, which does not have this code — see the remaining
risk below.

**Remaining risk:** `/image` 404s in production until the backend is deployed.
Nothing else in this phase can be exercised end-to-end from the app before
that.

---

## Phase 9 — Notes

### T9.1 — `create_note` tool
DONE (local, uncommitted)

**Outside the frozen scope.** `CLAUDE.md` §1 freezes the build at
`SPEC_MVP_V1.1.md` and says to stop and ask rather than build past it. It was
raised as out of scope and then explicitly requested — the frontend's own
"My Tasks" tab is being replaced with a Notes screen — so it is here, marked,
and easy to find later, same as T8.1.

What to do: let the assistant file a short, free-text note the user asks her
to remember — not a task (no due date, nothing to complete) and not an event.

Files: `src/modules/voice/agent.ts` (`create_note` in `ACTION_TOOLS` and
`ARG_SCHEMAS`, a routing bullet in the system prompt) · `tests/voice.test.ts`
(4 cases, 36–39) · `API_CONTRACT.md`.

Shape: mirrors `create_image` — the tool owns no row, so `collectAction`
checks it against neither the ownership gate (no id) nor the duplicate gate
(no title). There is deliberately no `update_note` or `delete_note` tool, and
no `notes` array added to `snapshot`: the model only ever files a new one, it
never reads or edits an existing one. On the device, `create_note` reaches
`applyActions` in `frontend/src/lib/voice.ts` and is written to local storage
via a new `Note` type and `listNotes`/`createNote`/`deleteNote` in
`frontend/src/lib/api.ts`, exactly like `create_task`.

Tests: `tests/voice.test.ts` 36–39 for the tool gate (text required, refused
when empty, never asked for an id, not subject to the duplicate check).
tsc clean (frontend and backend). Backend: voice suite 43 passed / 1 skipped
(unchanged, pre-existing) — full `npm test` otherwise unaffected; the 16
failures across 3 suites are the pre-existing DB-backed ones, unreachable
without a local Postgres, not caused by this change.

Not verified: a note filed by voice on a real device — the client points at
the Railway deployment, which does not have this code yet (same remaining
risk as T8.1).

### T8.2 — Clashes, journeys, and times to choose instead
DONE (local, uncommitted) · **Orchestrator** — spans the tool contract, the
turn loop and a new wire action.

**Outside the frozen scope**, like T8.1, and requested directly.

What to do: when a meeting cannot be kept, say so and offer times that can.

Two ways it cannot. The hour is taken — any overlap check finds that. Or the
hour is free and the person would have to be in two places: Jerusalem at nine,
Haifa at half past ten. Nothing overlaps on the clock, so no overlap check
finds it, and it is the case that was actually asked for.

Files: `src/modules/voice/slots.ts` (new) · `travel.ts` (new) ·
`schedule.ts` (new) · `agent.ts` (`location` on the snapshot and on
create/update_event; `reviewProposedTime`; `offer_times` in `VoiceAction`) ·
`tests/slots.test.ts` (new, 37) · `API_CONTRACT.md`.

`offer_times` is the one action the model cannot ask for — the server raises it
in place of the create it refused, so it is in neither `ACTION_TOOLS` nor
`ARG_SCHEMAS` and nothing untrusted can produce one.

Distance is great-circle, and crude in one direction only: no road is shorter
than the straight line, so when even that does not fit the gap, the real
journey certainly does not. The reverse is not claimed. Measured against the
live geocoder: Jerusalem→Haifa in 30 min flagged, Tel Aviv→Ramat Gan in the
same 30 min not — the discrimination that matters.

Alternatives are put through both tests. Told a ten o'clock in Haifa is
impossible because of a nine in Jerusalem, half past ten is equally impossible,
and offering it would be worse than offering nothing because it looks like an
answer.

**Four defects were found by an adversarial review of this code and fixed
before it shipped**, each now pinned by a test (31–36):
- offers in the past — there was no `now` anywhere in the signature; the router
  had parsed `now` all along and never threaded it down
- a trailing sort by clock time threw the ranking away, so widening the
  candidate pool made the answer *worse*: a 14:00 request answered with 09:30
- a non-IANA timezone (`Israel Standard Time`, `GMT+2`) threw out of `Intl` and
  lost the whole turn to a 500; the sibling modules already guard this
- `new Date('tomorrow at 10')` is not NaN — V8's fallback parser returns a day
  in 2001 — so the NaN guard passed it and four slots came back in 2001

Also from that review, and taken: ties now go later (a meeting can be pushed
back more easily than pulled forward), and offers are spaced at least 75
minutes apart so four options are four answers rather than one restated.

Tests: 37 in `slots.test.ts`; 93 pass across slots/voice/image/reminders.
tsc clean both sides.

Scenarios verified by hand, distinct from "tests passed": the estimate against
the live geocoder for four real city pairs.

**Not verified:** the tiles rendering on a device. The frontend cannot bundle —
`src/navigation/index.tsx` imports `../screens/NotesScreen`, which does not
exist yet — and that is in-flight work from another thread, not this one.

---

## Phase 10 — Shopping and money

### T10.1 — Two screens swapped, and the tools behind them
DONE (local, uncommitted)

**Outside the frozen scope, and named in it.** `CLAUDE.md` §1 freezes the
build at `SPEC_MVP_V1.1.md` and lists **shopping lists** explicitly among the
things that are out of scope and priced separately. It was requested directly
and in detail, so it is here, marked, and easy to find later — the same
treatment T8.1 got.

What to do: replace the app's Notes and Profile screens with a shopping list
and a personal finance screen, and point the assistant at them.

Backend files: `src/modules/voice/agent.ts` (`create_note` removed from
`ACTION_TOOLS` and `ARG_SCHEMAS`; `add_shopping_item` and `add_money_entry`
added, plus the routing lines in the system prompt) · `tests/voice.test.ts`
(cases 36–46 rewritten) · `API_CONTRACT.md`.

Shape: both new tools follow `create_image` and the old `create_note` — they
own no row, so `collectAction` checks them against neither the ownership gate
(no id) nor the duplicate gate (no title), and `snapshot` gains no new arrays.
The model only ever *adds*; editing and deleting stay on the device, where the
two screens do their own CRUD against `frontend/src/lib/api.ts`.

`add_money_entry.amount` is `z.number().positive()` deliberately: `kind`
carries the direction, and a negative expense would subtract twice once the
device applied it. `date` is a strict `YYYY-MM-DD` regex and optional — the
device fills its own local today, because the server does not know the
device's day.

**`create_note` was removed rather than left in place.** The notes screen it
fed no longer exists, so a note the model filed would have been written to
storage with nothing able to read it back. That is marked `BREAKING` in
`API_CONTRACT.md` for any other client that implemented it.

Tests: `tests/voice.test.ts` 36–40 for shopping (name required, unknown aisle
refused, never asked for an id, a same-named task does not trip the duplicate
gate) and 41–46 for money (negative and zero amounts refused, unknown `kind`
refused, malformed date refused, a good date passes through untouched).
tsc clean (frontend and backend). Voice suite: 51 passed / 2 skipped.

Not verified: either screen on a real device, and neither tool end-to-end
through the model — the client points at the Railway deployment, which does
not have this code until it is redeployed.

**Remaining risk:** until the backend is deployed, `add_shopping_item` and
`add_money_entry` do not exist in production, so asking her to add milk or log
an expense does nothing. The screens themselves work regardless — they read
and write local storage and do not need the server.
