# MANUAL_QA.md — Backend Manual Test Checklist

Manual QA guide for the Personal Assistant backend. Wire-shape source of
truth is `API_CONTRACT.md`; this file only contains concrete test scenarios
in checklist form.

- **Base URL:** `http://localhost:5000`
- **Requirements:** Node 22+, Docker Desktop, Postgres port 5432 free.

> Status: the database layer is **already wired in code** (docker-compose,
> Prisma schema, and 2 migrations exist). You do **not** need to author it —
> only bring it up locally. See §0 for the setup checklist.

---

## 0. Database setup — is it already done?

**Short answer:** yes, it's implemented. The repo already contains:

- [x] `backend/docker-compose.yml` — Postgres 16 service with healthcheck
- [x] `backend/prisma/schema.prisma` — Users / RefreshToken / Task / Event /
      ChatMessage / Device models
- [x] `backend/prisma/migrations/20260723200828_init/` — initial schema
- [x] `backend/prisma/migrations/20260726102911_refresh_tokens/` — refresh
      token rotation table
- [x] `backend/.env.example` — env template
- [x] `backend/.env` — already contains `JWT_SECRET` + `JWT_REFRESH_SECRET`

**What you still have to do to bring the DB up locally:**

- [ ] Confirm Docker Desktop is running
- [ ] Confirm port 5432 is free (`Test-NetConnection localhost -Port 5432`
      should fail before start)
- [ ] `cd backend`
- [ ] If `.env` is missing: `cp .env.example .env`
- [ ] Verify `.env` has `JWT_SECRET` and `JWT_REFRESH_SECRET`, each ≥ 32
      chars. Generate with:
      `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- [ ] `docker compose up -d` — brings up `personal-assistant-db`
- [ ] `docker compose ps` — wait until state is `healthy` (up to ~30 sec)
- [ ] `npm install` — install backend dependencies
- [ ] `npx prisma migrate deploy` — apply both migrations
- [ ] `npx prisma db pull` (optional) or open a psql shell to confirm tables:
      ```powershell
      docker exec personal-assistant-db psql -U pa_user -d personal_assistant -c "\dt"
      ```
      Expected tables: `users`, `refresh_tokens`, `tasks`, `events`,
      `chat_messages`, `devices` (+ `_prisma_migrations`)
- [ ] `npm run dev` — expect log line
      `server listening {"port":5000,"env":"development"}`

**Sanity check:**

- [ ] `curl http://localhost:5000/health` → `{"status":"ok","version":"1.0.0"}`
- [ ] `curl -i http://localhost:5000/does-not-exist` → `HTTP/1.1 404` with
      body `{"error":{"code":"NOT_FOUND","message":"Route not found","details":{}}}`

---

## 1. Automated tests (run before manual QA)

- [ ] `npm test` — expect `Test Files 4 passed`, `Tests 66 passed | 3 skipped`
- [ ] Confirm the 3 skipped tests are the chat integration tests that need
      `OPENAI_API_KEY` (they auto-enable once the key is present in `.env`)
- [ ] If fewer than 66 pass: **stop** and investigate before continuing

---

## 2. Local access token (bypasses Google/Apple sign-in)

Real Google/Apple sign-in needs real ID tokens. For manual QA, mint a JWT
directly against the DB.

- [ ] Create a test user:
  ```powershell
  npx tsx --env-file=.env -e "
  import { prisma } from './src/db.js';
  const u = await prisma.user.create({
    data: { provider: 'google', providerUserId: 'manual-' + Date.now(),
            email: 'me@test', name: 'Me', timezone: 'Asia/Jerusalem' }
  });
  console.log('USER_ID=' + u.id);
  await prisma.\$disconnect();
  "
  ```
- [ ] Sign an access token for that user id:
  ```powershell
  npx tsx --env-file=.env -e "
  import { signAccessToken } from './src/lib/tokens.js';
  console.log('TOKEN=' + signAccessToken('<USER_ID>'));
  "
  ```
- [ ] Save both values (PowerShell: `$env:TOKEN = '...'`, `$env:USER_ID = '...'`)

---

## 3. Users — `/me`

- [ ] `GET /me` with valid Bearer → 200 + user object matching created row
- [ ] `GET /me` with **no** Authorization header → 401 `UNAUTHORIZED`
- [ ] `PATCH /me` with `{"name":"New Name","language":"en"}` → 200 + updated
      fields reflected
- [ ] `PATCH /me` with empty body `{}` → 400 `VALIDATION_ERROR` "No fields to update"
- [ ] `DELETE /me` → 202 with `deletionRequestedAt` timestamp
- [ ] `DELETE /me` again → 202 with **same** `deletionRequestedAt` (idempotent,
      not re-stamped)
- [ ] Clear deletion mark before continuing tests:
  ```powershell
  npx tsx --env-file=.env -e "
  import { prisma } from './src/db.js';
  await prisma.user.update({ where: { id: '$env:USER_ID' },
    data: { deletionRequestedAt: null } });
  await prisma.\$disconnect();
  "
  ```

---

## 4. Tasks — CRUD + sync

- [ ] Generate a client UUID (`node -e "console.log(crypto.randomUUID())"`),
      save it as `TASK_ID`
- [ ] `POST /tasks` with `{id, title, dueAt}` → **201** + task object
- [ ] `POST /tasks` again with the **same** `id` → **200** (idempotent replay,
      not 201, not 409), returns the same row
- [ ] `POST /tasks` with the same `id` while authenticated as a **different**
      user → **409** `CONFLICT`
- [ ] `GET /tasks` → `{"tasks":[...],"serverTime":"..."}`, task present
- [ ] `PATCH /tasks/{TASK_ID}` with `{"isDone":true}` → 200, `isDone` flipped,
      `updatedAt` moved
- [ ] `PATCH /tasks/00000000-0000-0000-0000-000000000000` → 404 `NOT_FOUND`
- [ ] `DELETE /tasks/{TASK_ID}` → 204
- [ ] `GET /tasks?updatedSince=2026-01-01T00:00:00Z` → includes the deleted
      task with `deletedAt` populated (**sync must surface soft deletes**)
- [ ] `GET /tasks` (no filter) → deleted task is **not** returned
- [ ] Verify `updatedAt` on the deleted row is newer than `deletedAt-1s`
      (CLAUDE.md §2.3 invariant: soft delete must bump `updated_at`)

---

## 5. Events — CRUD + `ends_at` guard

- [ ] Save `EVENT_ID` = new UUID
- [ ] `POST /events` with only `startsAt` (no `endsAt`) → 201 with
      `endsAt = startsAt + 60min` (default from CLAUDE.md §3)
- [ ] `POST /events` with `endsAt` **before** `startsAt` → 400
      `VALIDATION_ERROR "endsAt must be after startsAt"`
- [ ] `POST /events` idempotent replay → 200 same row
- [ ] `PATCH /events/{EVENT_ID}` with `{"reminderMinutesBefore":null}` → 200,
      field is null
- [ ] `PATCH /events/{EVENT_ID}` moving `startsAt` → response reflects new
      time, and (see §12) the reminder job was rescheduled
- [ ] `DELETE /events/{EVENT_ID}` → 204
- [ ] Reminder job for that event no longer exists in `pgboss.job` (see §12)

---

## 6. Agenda

- [ ] Create one event and one task on the same day (e.g. 2026-08-15)
- [ ] `GET /agenda?date=2026-08-15` → both event and task returned
- [ ] `GET /agenda?from=2026-08-01&to=2026-08-31` → both returned
- [ ] `GET /agenda` with no query params → 400 `VALIDATION_ERROR`
- [ ] `GET /agenda?date=not-a-date` → 400 `VALIDATION_ERROR`
- [ ] Soft-deleted event/task from §4-§5 does **not** appear

---

## 7. Devices — push token upsert

- [ ] `POST /devices` with `{pushToken, platform:"ios"}` → 200 with
      `{device:{id, platform, lastSeenAt}}`
- [ ] Response body does **not** contain `pushToken` or `userId` (privacy)
- [ ] Repeat the same request → same `device.id`, `lastSeenAt` advanced
- [ ] `POST /devices` with an invalid platform → 400 `VALIDATION_ERROR`

---

## 8. Auth — refresh + logout

- [ ] Mint a refresh token in-process:
  ```powershell
  npx tsx --env-file=.env -e "
  import { issueRefreshToken } from './src/lib/tokens.js';
  console.log(await issueRefreshToken('$env:USER_ID'));
  process.exit(0);
  "
  ```
- [ ] `POST /auth/refresh` with that token → 200 with **new** `accessToken`
      and **new** `refreshToken`
- [ ] `POST /auth/refresh` **reusing the old** refresh token → 401
      (rotation must invalidate the prior token)
- [ ] `POST /auth/logout` with Bearer + `{pushToken}` → 204; corresponding
      device row is deleted from `devices` table
- [ ] `POST /auth/logout` with **no** Bearer → 401 `UNAUTHORIZED`
- [ ] `POST /auth/google` with bogus `idToken` → 401 (proves handler runs;
      needed for §11 rate-limit test)

---

## 9. Chat — requires `OPENAI_API_KEY`

Add `OPENAI_API_KEY=sk-...` to `.env` and restart the server.

- [ ] `POST /chat/message` with `{text:"Schedule a meeting tomorrow at 10am
      with Dr Cohen"}` → response contains 2 messages, the assistant one
      carries a `pendingAction` of type `create_event`
- [ ] No new event exists in the DB yet (`GET /events` confirms)
- [ ] `POST /chat/message` with `{confirmMessageId: <assistant msg id>}` →
      response contains a tool result + a final assistant message
- [ ] `GET /events` now shows the created event
- [ ] `GET /chat/history?limit=10` → returns messages in reverse-chronological
      order with optional `nextCursor`
- [ ] `POST /chat/message` with `confirmMessageId` for a message that does
      **not** belong to the current user → 404 `NOT_FOUND`
- [ ] Send a message that references a hallucinated `task_id` of another
      user; ownership check rejects the tool call (assistant response should
      not confirm a mutation on foreign data)
- [ ] Send two chat messages back-to-back for the same user — mutex should
      serialize them (no interleaved tool calls in `chat_messages`)

**Golden rule:** any user request that would mutate data **must** surface a
`pendingAction`, and without a matching `confirmMessageId` nothing changes.

---

## 10. Speech — requires `OPENAI_API_KEY`

- [ ] `POST /speech/transcribe` with `audio=@sample.mp3` and `language=he`
      → 200 `{"text":"..."}`
- [ ] `POST /speech/transcribe` with `audio=@notes.txt` (bad mime) → 415
      `UNSUPPORTED_MEDIA`
- [ ] `POST /speech/transcribe` with a file > 25 MB → 413 `PAYLOAD_TOO_LARGE`
- [ ] No Bearer → 401

---

## 11. Rate limits

- [ ] Loop 25 `POST /auth/google` calls: first ~20 return 401, the rest
      return **429 `RATE_LIMITED`** with a `Retry-After` header (20/min/IP)
- [ ] Loop 31 `POST /chat/message` calls with the same Bearer: first 30
      proceed, the 31st returns 429 (30/min/user)
- [ ] Speech limiter — 11 rapid calls → 11th returns 429 (10/min/user)

---

## 12. Reminders (pg-boss background job)

- [ ] Create an event with `startsAt` = now + 90 sec and
      `reminderMinutesBefore = 1`
- [ ] Confirm a `send-reminder` job appears in `pgboss.job`:
  ```powershell
  docker exec personal-assistant-db psql -U pa_user -d personal_assistant `
    -c "SELECT id, name, state, startafter FROM pgboss.job WHERE name='send-reminder';"
  ```
- [ ] `PATCH` the event's `startsAt` to a different future time → the job's
      `startafter` moves (rescheduled via `singletonKey = eventId`)
- [ ] `PATCH` the event with `reminderMinutesBefore=null` → job row is
      removed
- [ ] Re-create a reminder, then `DELETE /events/{id}` → job row is removed
- [ ] Create an event whose reminder time is already in the past → **no**
      job is scheduled (should not immediately fire)

---

## 13. Purge job (30-day account deletion)

- [ ] Run the manual driver — creates one "old" user (deletion 31 days ago)
      and one "recent" user (deletion 5 days ago), invokes the handler, and
      asserts only the recent survives:
  ```powershell
  npx tsx --env-file=.env -e "
  import { prisma } from './src/db.js';
  import { handlePurgeDeletedUsers } from './src/jobs/purgeDeletedUsers.js';
  const old = await prisma.user.create({ data: { provider:'google',
    providerUserId:'old-'+Date.now(), email:'a@a', name:'A', timezone:'UTC',
    deletionRequestedAt: new Date(Date.now() - 31*24*3600*1000) } });
  const recent = await prisma.user.create({ data: { provider:'google',
    providerUserId:'new-'+Date.now(), email:'b@b', name:'B', timezone:'UTC',
    deletionRequestedAt: new Date(Date.now() - 5*24*3600*1000) } });
  await handlePurgeDeletedUsers([{ id:'x', name:'y', data:{}, expireInSeconds:900 }]);
  const survivors = await prisma.user.findMany({
    where: { id: { in: [old.id, recent.id] } }, select: { id: true } });
  console.log('Survivors:', survivors.length, '(expect 1)');
  await prisma.user.deleteMany({ where: { id: { in: [old.id, recent.id] } } });
  await prisma.\$disconnect();
  "
  ```
- [ ] Confirm output prints `Survivors: 1 (expect 1)`

---

## 14. Teardown

- [ ] Delete the test user (cascade removes their tasks/events/chat/devices):
  ```powershell
  npx tsx --env-file=.env -e "
  import { prisma } from './src/db.js';
  await prisma.user.delete({ where: { id: '$env:USER_ID' } });
  await prisma.\$disconnect();
  "
  ```
- [ ] `Ctrl+C` in the `npm run dev` terminal
- [ ] `docker compose down` — stops Postgres, **keeps** the volume
- [ ] Only for a full reset: `docker compose down -v` (destroys DB data)

---

## Endpoint summary

| Method | Path | Auth | Rate limit |
|---|---|---|---|
| GET | `/health` | — | — |
| POST | `/auth/google` | — | 20/min/IP |
| POST | `/auth/apple` | — | 20/min/IP |
| POST | `/auth/refresh` | — | 20/min/IP |
| POST | `/auth/logout` | **Bearer** | 20/min/IP |
| GET | `/me` | Bearer | — |
| PATCH | `/me` | Bearer | — |
| DELETE | `/me` | Bearer | — |
| GET | `/tasks` (`?updatedSince=`) | Bearer | — |
| POST | `/tasks` | Bearer | — |
| PATCH | `/tasks/:id` | Bearer | — |
| DELETE | `/tasks/:id` | Bearer | — |
| GET | `/events` (`?updatedSince=`) | Bearer | — |
| POST | `/events` | Bearer | — |
| PATCH | `/events/:id` | Bearer | — |
| DELETE | `/events/:id` | Bearer | — |
| GET | `/agenda` (`?date=` **or** `?from=&to=`) | Bearer | — |
| POST | `/devices` | Bearer | — |
| POST | `/chat/message` | Bearer | 30/min + 500/day |
| GET | `/chat/history` (`?cursor=&limit=`) | Bearer | — |
| POST | `/speech/transcribe` | Bearer | 10/min |

Total: **21 endpoints**, 5 of them public (`/health` + 4 auth routes; logout
is Bearer-protected).

---

## 15. Production Postgres — setup checklist

Goal: run the same schema on a managed Postgres in production, backed up,
reachable only over TLS, and driven by the same Prisma migrations.

### 15.1 Provision the managed Postgres instance

Pick **one** of the following (all are vanilla Postgres — Prisma doesn't care):

- **Railway Postgres** — `New → Database → Postgres` inside the same project
  that hosts the backend service (private networking = lowest latency)
- **Render Postgres** — `New → PostgreSQL`, pick region matching the web
  service, plan ≥ Starter (free tier expires after 90 days)
- **Fly.io Postgres** — `fly pg create --name pa-db --region <same as app>`

Checklist regardless of provider:

- [ ] Choose a region **in the same zone as the backend** (< 5 ms round-trip)
- [ ] Postgres version **16** (matches local `postgres:16-alpine`)
- [ ] Plan size: start with 1 GB RAM / 10 GB disk; scale later
- [ ] Enable **automatic daily backups** with retention ≥ 7 days
- [ ] Enable **Point-in-Time Recovery (PITR)** with a window ≥ 7 days
      - Railway: PITR is on by default on paid plans (verify in DB → Backups)
      - Render: enabled on Standard plan and above (Starter has snapshots only)
      - Fly.io: `fly pg config update --wal-archiving-enabled=true`
- [ ] Copy the connection string — it must look like
      `postgresql://<user>:<password>@<host>:<port>/<db>?sslmode=require`
- [ ] **Force SSL:** the string above ends with `?sslmode=require`; refuse a
      connection string that lacks it
- [ ] Restrict access:
      - Prefer **private networking** to your backend service (Railway
        Private Network / Render Private Service Connect / Fly 6PN)
      - If public: **allowlist only** the backend's egress IPs; deny 0.0.0.0/0

### 15.2 Provision the production `.env` on the backend host

Do **not** commit these to git. Set them as secrets in Railway/Render/Fly
dashboards (or `fly secrets set`).

- [ ] `DATABASE_URL` — the SSL-required connection string from 15.1
- [ ] `NODE_ENV=production`
- [ ] `LOG_LEVEL=info`
- [ ] `PORT` — whatever the host expects (Railway/Render: any; Fly: 8080)
- [ ] `JWT_SECRET` — **new** 48-byte base64url string, **not** the dev value
- [ ] `JWT_REFRESH_SECRET` — **new** 48-byte base64url string, distinct from
      `JWT_SECRET`
- [ ] `GOOGLE_CLIENT_ID` — real production client id
- [ ] `APPLE_CLIENT_ID` — real production client id
- [ ] `OPENAI_API_KEY` — production key with usage limit set
- [ ] `EXPO_ACCESS_TOKEN` — Expo production token
- [ ] `CORS_ORIGINS` — comma-separated list of your real frontend origins
      (server refuses to boot in production without this)

Generate the two JWT secrets locally, then paste into the host's secret
manager:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 15.3 Apply the schema in production

Prisma migrations are the source of truth. Do **not** run `db push` — it
skips the migration history.

- [ ] From your laptop, one-shot deploy against production DB (safer than
      trusting an ephemeral build step):
  ```powershell
  $env:DATABASE_URL = "<prod connection string>"
  npx prisma migrate deploy
  ```
- [ ] Alternatively, add `npx prisma migrate deploy` to the host's release
      command:
      - Railway: `Settings → Deploy → Pre-deploy command`
      - Render: `Build Command` finishes with `&& npx prisma migrate deploy`
      - Fly.io: `release_command = "npx prisma migrate deploy"` in `fly.toml`
- [ ] Verify tables exist:
  ```powershell
  # psql from anywhere with the prod URL
  psql "<prod DATABASE_URL>" -c "\dt"
  ```
      Expected: `users`, `refresh_tokens`, `tasks`, `events`,
      `chat_messages`, `devices`, `_prisma_migrations`

### 15.4 Smoke test against production

- [ ] `curl https://<your-app-domain>/health` → `{"status":"ok",...}`
- [ ] `curl -i https://<your-app-domain>/does-not-exist` → 404 with the
      standard error envelope
- [ ] Repeat §2–§8 of this document against the production Base URL, using
      a **throwaway test user** you plan to delete
- [ ] Confirm real Google/Apple sign-in works end-to-end (needs real ID
      token from the mobile client; can't be faked as in §2)
- [ ] After smoke test: delete the throwaway user (§14) so the row goes
      through the 30-day purge flow like any real user

### 15.5 Backups + Point-in-Time Recovery

- [ ] Confirm the first automatic snapshot has succeeded (check host
      dashboard 24 h after go-live)
- [ ] **Rehearse a restore** — non-negotiable. Restore the latest snapshot
      into a **separate** DB instance and connect a local backend to it:
  ```powershell
  $env:DATABASE_URL = "<restored DB connection string>"
  npm run dev
  curl http://localhost:5000/health
  ```
- [ ] Verify PITR window covers the retention target (e.g. "any point in the
      last 7 days"); test recovering to a timestamp ~10 minutes in the past
- [ ] Document the restore command / dashboard steps in a runbook (a
      backup you've never restored is not a backup)
- [ ] Set a calendar reminder to rerun this drill **quarterly**

### 15.6 Post-deploy sanity + guardrails

- [ ] `GET /health` responds within 200 ms from the app region
- [ ] `SELECT count(*) FROM pg_stat_activity;` in prod stays well below the
      instance's `max_connections`
- [ ] Prisma connection pool size (`?connection_limit=` in `DATABASE_URL`)
      set to fit inside `max_connections` minus overhead for pg-boss
      (default `connection_limit` = `num_physical_cpus * 2 + 1`)
- [ ] pg-boss schema (`pgboss.*`) auto-created on first server start —
      confirm with `\dn` in psql
- [ ] Rotate `JWT_SECRET` / `JWT_REFRESH_SECRET` procedure documented (all
      users get logged out on rotation)
- [ ] Backup credentials to the DB stored separately from the host secrets
      manager (in case the host itself is the failure)

---

## Missing for production

- [ ] Real `OPENAI_API_KEY` (chat + speech)
- [ ] `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID` (real sign-in)
- [ ] `EXPO_ACCESS_TOKEN` (production push; not required with Expo dev clients)
- [ ] `CORS_ORIGINS` set (server refuses to boot in production without it)
- [ ] `NODE_ENV=production` + `LOG_LEVEL=info`
- [ ] Refresh-rotation transaction promoted to `SERIALIZABLE` isolation
      (QA-2 m-2 — pending)
- [ ] Periodic cleanup of expired `refresh_tokens` (QA-2 N-2 — nice-to-have)

Full decision log and outstanding gaps: `TASKS.md`, task `T6.3`.
