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
_TODO_
**What to do:** `POST /auth/google` עם `google-auth-library`. verify ID token, upsert user לפי `(provider, provider_user_id)`. הנפקת access (15min) + refresh (30d).
**Definition of Done:** ID token תקין → 200 + tokens + user. Token זויף → 401. משתמש חדש נוצר, קיים מתעדכן.

### T1.2 — Apple Sign-in
_TODO_
**What to do:** `POST /auth/apple` — fetch JWKS מ-Apple, verify ID token, upsert.
**Definition of Done:** אותו חוזה כמו Google. שגיאה ברורה על audience/issuer לא תואמים.

### T1.3 — Refresh + logout
_TODO_
**What to do:** `POST /auth/refresh` עם rotation (refresh ישן בטל). `POST /auth/logout` מוחק refresh + מוחק את ה-device של ה-`pushToken` שנשלח.
**Definition of Done:** refresh משומש פעם שנייה → 401. logout מבטל את ה-session ומוחק row מ-devices.

### T1.4 — Auth middleware
_TODO_
**What to do:** `src/middleware/auth.ts` — verify JWT, `req.user = { id, timezone, language }`. 401 על חסר/פג/פסול.
**Definition of Done:** endpoint מוגן מחזיר 401 בלי header, 200 עם header תקין.

### T1.5 — Users module (/me)
_TODO_
**What to do:** `GET /me`, `PATCH /me` (name, language, timezone), `DELETE /me` (soft — `deletion_requested_at = NOW()`, refresh tokens נמחקים).
**Definition of Done:** תרחישי §8 QA של auth ו-account deletion (ראה CLAUDE.md §8) עוברים בטסטים.

---

## Phase 2 — Tasks, Events, Sync, Agenda

### T2.1 — Tasks CRUD
_TODO_
**What to do:** `POST` idempotent על id, `GET ?updatedSince=` כולל מחוקים, `PATCH`, `DELETE` (soft, bump `updated_at`). Ownership check על כל mutation.
**Definition of Done:** תרחישי sync ב-§8 של CLAUDE.md עוברים. POST חוזר עם אותו id → 200 (לא כפילות). id של משתמש אחר → 409.

### T2.2 — Events CRUD
_TODO_
**What to do:** אותו דבר כמו Tasks + שדה `reminder_minutes_before`. בלי תזמון עדיין (Phase 3).
**Definition of Done:** אותם תרחישי sync.

### T2.3 — /agenda
_TODO_
**What to do:** `GET /agenda?date=YYYY-MM-DD` או `?from=&to=`. מחזיר `{ events, tasks }` עם משימות שיש להן `due_at` בטווח.
**Definition of Done:** `date` יחיד → יום אחד. `from/to` → טווח. לא כולל מחוקים. סינון לפי user_id בלבד.

### T2.4 — Sync tests
_TODO_
**What to do:** `tests/sync.test.ts` שמכסה: create → updatedSince, edit → updatedSince, delete → updatedSince, replay POST, cross-user 409.
**Definition of Done:** כל תרחיש עובר. הטסטים behavioral (§8 test review).

---

## Phase 3 — Notifications & Reminders

### T3.1 — pg-boss init
_TODO_ · **Orchestrator only** (§6 — `boss.ts`)
**What to do:** `src/jobs/boss.ts` — init pg-boss מול ה-DB הקיים. job types: `send-reminder`, `purge-deleted-users`.
**Definition of Done:** pg-boss עולה עם השרת, טבלאות schema נוצרות ב-Postgres.

### T3.2 — Devices register/upsert
_TODO_
**What to do:** `POST /devices` upsert על `(platform, push_token)`. אם token שייך למשתמש אחר — reassign.
**Definition of Done:** אותו token של אותו משתמש → אותו row, `last_seen_at` מתעדכן. Token של משתמש אחר → הועבר.

### T3.3 — Reminder scheduling
_TODO_ · **Orchestrator only**
**What to do:** hooks על create/update/delete event: אם `reminder_minutes_before != NULL` וזמן ההתראה בעתיד → schedule job. Update מבטל ו-reschedules. Delete מבטל. תיעוד: מפתח job הוא `event_id`.
**Definition of Done:** תרחישי Reminders ב-§8 עוברים. אירוע עבר → לא נדחף job. `NULL` → לא נדחף job.

### T3.4 — Push sender
_TODO_
**What to do:** `sendReminder` handler שולף event, בונה הודעה בשפת המשתמש, שולח דרך `expo-server-sdk` לכל ה-devices של המשתמש.
**Definition of Done:** job שרץ שולח push. אם ה-token invalid — מוחק את ה-device. Errors מתועדים ב-pino.

---

## Phase 4 — Chat & Tools

### T4.1 — Chat messages persistence
_TODO_
**What to do:** מודל `chat_messages` (כבר בסכימה). helpers לשמירה/קריאה. `GET /chat/history?cursor=&limit=` עם pagination.
**Definition of Done:** קריאה ב-order יציב, cursor עובד קדימה, `limit` מוגבל ל-100.

### T4.2 — System prompt builder
_TODO_
**What to do:** `src/modules/chat/prompt.ts` — בונה system prompt כולל: תאריך UTC, שעה מקומית של המשתמש, `timezone`, `language`, שם, כלל "אין ביצוע אוטומטי".
**Definition of Done:** unit test מוודא שהתאריך והשעה נכללים ומעודכנים.

### T4.3 — Tools + executors
_TODO_ · **Orchestrator only** (§6 — `tools.ts`)
**What to do:** `src/modules/chat/tools.ts` עם Zod schemas + executors + ownership check לכל tool. Tools: `create_task`, `update_task`, `complete_task`, `list_tasks`, `create_event` (default 60min), `list_events`. Executor מוודא `resource.user_id === token.user_id`.
**Definition of Done:** כל tool עובר Zod. hallucinated id → executor מחזיר שגיאת ownership. `list_*` מסונן ל-user_id.

### T4.4 — Chat router + confirmation flow
_TODO_ · **Orchestrator only** (§6 — `router.ts`)
**What to do:** `POST /chat/message`:
- אם `confirmMessageId` נשלח → שולף `pending_action` מהודעת ה-assistant, מריץ את ה-tool, שומר תוצאה כהודעת `tool`, מנקה `pending_action`.
- אחרת → קריאה ל-LLM, אם הוחזר tool_call → שומר `pending_action` ומחזיר כרטיס אישור. אם טקסט → שומר ומחזיר.
Per-user mutex.
**Definition of Done:** תרחישי Chat ב-§8 עוברים. שני messages רצופים מאותו משתמש — סדרתיים.

### T4.5 — Rate limits
_TODO_
**What to do:** middleware לפי משתמש: chat 30/min + 500/day, speech 10/min, auth 20/min per IP.
**Definition of Done:** חריגה → 429 עם `Retry-After`.

---

## Phase 5 — Speech

### T5.1 — /speech/transcribe
_TODO_
**What to do:** `multer` memory storage, גודל מקסימלי 25MB, פורמטים `m4a/webm/mp3/wav`. שליחה ל-Whisper כ-stream. אין כתיבה לדיסק. Content נמחק לאחר התשובה.
**Definition of Done:** אודיו תקין → `{ text }`. גדול מדי → 413. פורמט לא נתמך → 415.

---

## Phase 6 — Housekeeping

### T6.1 — purgeDeletedUsers job
_TODO_
**What to do:** job יומי דרך pg-boss cron. שולף users עם `deletion_requested_at < NOW() - 30 days` ומוחק hard: tasks, events, chat_messages, devices, users.
**Definition of Done:** תרחיש deletion ב-§8 עובר. משתמש שחזר בתוך 30 יום — לא נמחק.

### T6.2 — README + .env.example
_TODO_
**What to do:** README עם: הרצה מקומית (docker + npm), משתני סביבה, מבנה תיקיות, קישור ל-`SPEC_BACKEND_V1.2.md` ו-`API_CONTRACT.md`.
**Definition of Done:** dev חדש עולה על הפרויקט בפחות מ-10 דקות.

### T6.3 — Security review
_TODO_
**What to do:** helmet מוגדר, CORS origins ב-config, secrets לא ב-logs, rate limits בפועל, ownership checks בכל mutation.
**Definition of Done:** רשימת ביקורת מסומנת ומצורפת ב-report.
