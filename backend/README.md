# Backend — Personal Assistant App

Node.js + TypeScript backend for a Hebrew-first AI personal assistant. The primary interface is a chat with an LLM that proposes actions (create task, create event) and only executes them after explicit user confirmation. Phases 0–5 are complete and all 26 tests pass.

---

## Stack

- **Node.js 22 + TypeScript** on **Express 4**
- **PostgreSQL 16** via **Prisma 6** ORM (migrations in `prisma/migrations/`)
- **OpenAI SDK v6** — GPT (chat loop) + Whisper (speech transcription)
- **pg-boss 12** — Postgres-native job queue (reminders, account purge)
- **expo-server-sdk** — Push notifications
- **Zod 4** — request validation and tool argument schemas
- **jsonwebtoken + jose** — JWT access tokens (15 min) + opaque refresh tokens (30 d, rotation)
- **pino + pino-http** — structured JSON logging
- **express-rate-limit** — per-user rate limits (chat 30/min + 500/day, speech 10/min, auth 20/min per IP)
- **Vitest + Supertest** — integration tests against local Postgres

---

## Directory Layout

```
backend/
├── src/
│   ├── config.ts             Zod env parse — fail-fast on missing vars
│   ├── db.ts                 Shared Prisma client singleton
│   ├── app.ts                Express app factory (helmet, cors, routes)
│   ├── index.ts              Bootstrap: pg-boss start → app.listen
│   ├── lib/
│   │   ├── errors.ts         AppError + typed subclasses (NotFound, Forbidden, …)
│   │   ├── logger.ts         Pino instance (pretty in dev, JSON in prod)
│   │   ├── tokens.ts         JWT issue/verify + refresh token rotation helpers
│   │   └── http.ts           Shared HTTP utilities
│   ├── middleware/
│   │   ├── auth.ts           Bearer JWT → req.user (id, timezone, language)
│   │   ├── errorHandler.ts   Central error handler + 404 handler + HTTP logger
│   │   └── rateLimit.ts      chatLimiter / speechLimiter / authLimiter
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── providers/    google.ts · apple.ts (token verification)
│   │   │   ├── service.ts    signInFromIdentity — upsert user + issue tokens
│   │   │   └── router.ts     POST /auth/{google,apple,refresh,logout}
│   │   ├── users/
│   │   │   └── router.ts     GET /me · PATCH /me · DELETE /me
│   │   ├── tasks/
│   │   │   └── router.ts     GET /tasks · POST · PATCH /:id · DELETE /:id
│   │   ├── events/
│   │   │   ├── router.ts     GET /events · POST · PATCH /:id · DELETE /:id
│   │   │   └── reminders.ts  scheduleEventReminder / cancelEventReminder
│   │   ├── agenda/
│   │   │   ├── router.ts     GET /agenda?date= or ?from=&to=
│   │   │   └── dateRange.ts  Timezone-aware day boundary helpers
│   │   ├── devices/
│   │   │   └── router.ts     POST /devices (upsert push token)
│   │   ├── chat/
│   │   │   ├── router.ts     POST /chat/message (text or confirm)
│   │   │   ├── historyRouter.ts  GET /chat/history?cursor=&limit=
│   │   │   ├── persistence.ts    save/load chat messages, pending action helpers
│   │   │   ├── prompt.ts     buildSystemPrompt (date, time, user context)
│   │   │   ├── tools.ts      Tool definitions, Zod arg schemas, executors
│   │   │   ├── llm.ts        OpenAI client singleton + model constant
│   │   │   └── mutex.ts      Per-user in-memory lock (serializes chat calls)
│   │   └── speech/
│   │       └── router.ts     POST /speech/transcribe (multipart audio → text)
│   └── jobs/
│       ├── boss.ts           pg-boss singleton: startBoss / stopBoss / getBoss
│       ├── register.ts       registerJobHandlers (called on startup)
│       ├── sendReminder.ts   Handler: fetch event → push via Expo
│       └── purgeDeletedUsers.ts  Handler: hard-delete users past 30-day window
├── prisma/
│   ├── schema.prisma         5 models: User, Task, Event, ChatMessage, Device + RefreshToken
│   └── migrations/           Applied SQL migrations (orchestrator-only)
├── tests/
│   ├── sync.test.ts          12 tests: tasks + events sync semantics
│   └── prompt.test.ts        14 tests: system prompt builder (Hebrew/English/UTC)
├── docker-compose.yml        postgres:16-alpine on port 5432
├── .env.example              All required env vars with comments
├── package.json
└── tsconfig.json
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values below. The app will fail fast at startup if any required variable is missing or invalid (Zod parse in `src/config.ts`).

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string |
| `POSTGRES_USER` | Yes (Docker) | DB user — used by `docker-compose.yml` |
| `POSTGRES_PASSWORD` | Yes (Docker) | DB password |
| `POSTGRES_DB` | Yes (Docker) | DB name |
| `JWT_SECRET` | Yes | Signs access tokens (15 min). Min 32 chars. |
| `JWT_REFRESH_SECRET` | Yes | Signs refresh token hash. Min 32 chars. |
| `GOOGLE_CLIENT_ID` | For Google auth | OAuth 2.0 client ID from Google Cloud Console |
| `APPLE_CLIENT_ID` | For Apple auth | Bundle ID / Service ID registered with Apple |
| `OPENAI_API_KEY` | For chat + speech | Required for `POST /chat/message` and `/speech/transcribe` |
| `EXPO_ACCESS_TOKEN` | For push | Expo account token for sending push notifications |
| `PORT` | No | Default `5000` |
| `NODE_ENV` | No | `development` / `production` / `test`. **Defaults to `production`** — an unset environment is a locked one, not an open one. |
| `ENABLE_DEV_AUTH` | No | `true` mounts `POST /auth/dev`, the OAuth-free sign-in shortcut. Takes `NODE_ENV=development` as well. Never set it in a deployment. |
| `LOG_LEVEL` | No | Default `info`. Pino log level. |

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## Local Setup

```bash
# 1. Start Postgres
docker compose up -d
# Wait for: personal-assistant-db  ...  (healthy)

# 2. Install deps
npm install

# 3. Run migrations
npx prisma migrate deploy

# 4. Dev server (hot reload via tsx watch)
npm run dev
# → http://localhost:5000/health
```

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | `tsx watch --env-file=.env src/index.ts` — hot reload, reads `.env` |
| `npm run build` | `tsc` — compiles to `dist/` |
| `npm run start` | `node --env-file=.env dist/index.js` — runs compiled output |
| `npm run typecheck` | `tsc --noEmit` — type-checks without emitting files |
| `npm test` | Vitest in singleFork mode against local Postgres, reads `.env` |
| `npm run test:watch` | Vitest in watch mode (interactive, no `--env-file`) |

Both `dev` and `start` load `.env` via Node's built-in `--env-file` flag (requires Node 20.6+; Node 22 recommended).

---

## Testing

```bash
npm test
```

Runs [Vitest](https://vitest.dev/) with `singleFork` pool against the local Postgres database (the same one Docker starts). The suite currently contains two files:

- `tests/sync.test.ts` — 12 tests covering tasks and events sync semantics: create, idempotent replay, cross-user conflict, `updatedSince` cursor, soft delete with `updatedAt` bump, ownership isolation.
- `tests/prompt.test.ts` — 14 tests covering `buildSystemPrompt`: Hebrew/Jerusalem, English/UTC, invalid-timezone fallback.

Total: 26 tests, all passing.

When adding a new module, add a corresponding test file under `tests/`. Focus on behavioral assertions: ownership checks, negative cases (wrong user, missing fields, expired token), and not just the happy path.

---

## Documentation Map

| File | Description |
|---|---|
| `SPEC_MVP_V1.1.md` | Product spec — user target, the four app surfaces (Home / Chat / Tasks / Calendar), what is out of MVP scope (recurring events, sharing, all-day events, etc.) |
| `SPEC_BACKEND_V1.2.md` | Technical spec — full data model, all endpoints, sync semantics, chat flow, reminder scheduling, security, account deletion, stack, env vars |
| `API_CONTRACT.md` | Wire contract for the Frontend developer — every endpoint, payload shape, status code, enum value, and error format. Update this in the same commit as any endpoint change. |
| `CLAUDE.md` | AI-agent guidelines — the four invariants that must not be broken, model selection, parallel-agent rules, QA checklist |
| `TASKS.md` | Build log — all tasks from Phase 0 to Phase 6 with status, files changed, and deviations |
