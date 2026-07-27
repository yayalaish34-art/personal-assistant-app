# API_CONTRACT.md — Wire Contract for Frontend

The frontend is built by a different developer who does not read backend code.
Every field, status code, and enum value here is the contract. Update this file
in the **same turn** as any endpoint change. Mark breaking changes as
`BREAKING <YYYY-MM-DD>`.

Base URL (dev): `http://localhost:5000`
Content-Type: `application/json; charset=utf-8` unless noted.
Timestamps: **ISO-8601 UTC**, always with `Z` suffix (e.g. `2026-07-23T14:30:00Z`).
Ids: UUID v4, lowercase.

---

## Enums

- `provider`: `google` | `apple`
- `language`: `he` | `en`
- `platform`: `ios` | `android` | `web`
- `role` (chat_messages): `user` | `assistant` | `tool`

---

## Auth headers

All endpoints except `POST /auth/*` require:
```
Authorization: Bearer <access_token>
```
Missing/expired → `401 Unauthorized`.

---

## Error shape

Every non-2xx returns:
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "human readable",
    "details": { }
  }
}
```

Codes: `VALIDATION_ERROR` · `UNAUTHORIZED` · `FORBIDDEN` · `NOT_FOUND` ·
`CONFLICT` · `RATE_LIMITED` · `PAYLOAD_TOO_LARGE` · `UNSUPPORTED_MEDIA` ·
`INTERNAL`.

Rate-limited responses include `Retry-After` header (seconds).

---

## Auth

### `POST /auth/google`
Request:
```json
{
  "idToken": "<google id token>",
  "timezone": "Asia/Jerusalem"   // optional; IANA name of the device timezone.
                                 // Used only for NEW users (create path).
                                 // Defaults to "UTC" if omitted — send it to
                                 // avoid all new Israeli users being UTC.
}
```
Response `200`:
```json
{
  "user": { "id": "…", "email": "…", "name": "…", "language": "he", "timezone": "Asia/Jerusalem" },
  "accessToken": "…",
  "refreshToken": "…"
}
```
- `401` invalid token · `500` provider unavailable.

### `POST /auth/apple`
Same request/response shape as `/auth/google` (including optional `timezone`).

### `POST /auth/refresh`
Request:
```json
{ "refreshToken": "…" }
```
Response `200`:
```json
{ "accessToken": "…", "refreshToken": "…" }
```
Rotation: the returned `refreshToken` replaces the old one. Reusing a rotated
token → `401`.

### `POST /auth/logout`
**Requires `Authorization: Bearer <access_token>`.**

Request:
```json
{
  "refreshToken": "…",     // optional but strongly recommended — server
                           // revokes this refresh token so the session
                           // is closed on the server side too.
  "pushToken": "…"         // optional; deletes the device row for the
                           // caller's user + this pushToken.
}
```
Response `204`.
- Both `refreshToken` and `pushToken` are scoped to the caller — a token
  belonging to another user is a silent no-op (never leaks ownership).

---

## Users

### `GET /me`
Response `200`:
```json
{
  "user": {
    "id": "…",
    "email": "…",
    "name": "…",
    "language": "he",
    "timezone": "Asia/Jerusalem",
    "createdAt": "2026-01-05T09:00:00Z"
  }
}
```

### `PATCH /me`
Request (any subset):
```json
{ "name": "…", "language": "en", "timezone": "Europe/London" }
```
Response `200`: same as `GET /me`.

### `DELETE /me`
Response `202`:
```json
{ "deletionRequestedAt": "2026-07-23T14:30:00Z" }
```
Signing back in within 30 days cancels the deletion. All refresh tokens for
this user are invalidated immediately.

---

## Tasks

Task shape:
```json
{
  "id": "…",
  "title": "…",
  "notes": "… or null",
  "dueAt": "2026-07-23T14:30:00Z or null",
  "isDone": false,
  "createdAt": "…",
  "updatedAt": "…",
  "deletedAt": null
}
```

### `GET /tasks?updatedSince=<ISO>`
Response `200`:
```json
{
  "tasks": [ /* task, including rows with deletedAt != null */ ],
  "serverTime": "2026-07-23T14:30:05Z"
}
```
- Deleted rows are included so the client can remove them locally.
- Use `serverTime` as the next `updatedSince` cursor.
- No `updatedSince` → returns everything the user has (not deleted).

### `POST /tasks`
Request (client-generated `id`):
```json
{
  "id": "…",
  "title": "…",
  "notes": "… or omitted",
  "dueAt": "… or omitted",
  "updatedAt": "…"
}
```
Responses:
- `201` — created.
- `200` — same id already exists for this user (idempotent replay). Body is the existing row.
- `409` — id belongs to a different user. Code `CONFLICT`.

### `PATCH /tasks/:id`
Request (any subset):
```json
{ "title": "…", "notes": "…", "dueAt": "…", "isDone": true, "updatedAt": "…" }
```
Response `200`: updated task.
- `404` if not owned by user (or does not exist — same response, no leakage).

### `DELETE /tasks/:id`
Response `204`. Soft delete. `updatedAt` is bumped.

---

## Events

Event shape:
```json
{
  "id": "…",
  "title": "…",
  "note": "… or null",
  "startsAt": "2026-07-23T14:00:00Z",
  "endsAt": "2026-07-23T15:00:00Z",
  "reminderMinutesBefore": 15,
  "createdAt": "…",
  "updatedAt": "…",
  "deletedAt": null
}
```

### `GET /events?updatedSince=<ISO>`
Same semantics as `GET /tasks?updatedSince=`. Includes deleted rows.

### `POST /events`
Request:
```json
{
  "id": "…",
  "title": "…",
  "note": "…",
  "startsAt": "…",
  "endsAt": "… or omitted (defaults to startsAt + 60 min)",
  "reminderMinutesBefore": 15,
  "updatedAt": "…"
}
```
Responses: same idempotency rules as tasks.

### `PATCH /events/:id`
Any subset of the fields above. `reminderMinutesBefore: null` disables the
reminder.

### `DELETE /events/:id`
`204`. Soft delete. Any scheduled reminder is cancelled.

---

## Agenda

### `GET /agenda?date=YYYY-MM-DD`
### `GET /agenda?from=YYYY-MM-DD&to=YYYY-MM-DD`
Response `200`:
```json
{
  "events": [ /* event shape */ ],
  "tasks":  [ /* task shape — only tasks whose dueAt falls in the range */ ]
}
```
- `date` and `from`/`to` are interpreted in the **user's timezone**.
- Excludes deleted rows.
- `from` and `to` inclusive.

---

## Chat

Message shape:
```json
{
  "id": "…",
  "role": "user | assistant | tool",
  "content": "…",
  "toolCalls": [ … ] | null,
  "toolCallId": "…" | null,
  "pendingAction": {
    "tool": "create_event",
    "arguments": { "title": "…", "startsAt": "…", "endsAt": "…" }
  } | null,
  "createdAt": "…"
}
```

### `POST /chat/message`
**Normal message:**
```json
{ "text": "קבע לי פגישה מחר ב-10" }
```

**Confirming a pending action:**
```json
{ "confirmMessageId": "<id of the assistant message that carried pendingAction>" }
```
- The assistant message referenced must belong to the same user and still
  carry a non-null `pendingAction`, otherwise `404`.
- On confirm, the server executes the tool, appends a `role: "tool"` message
  with the result, and clears `pendingAction` on the original message.

Response `200`:
```json
{
  "messages": [ /* one or more chat messages appended, in order */ ]
}
```
- The last message is either the assistant's reply (text or with
  `pendingAction`) or, after a confirm, the `tool` result.

Rate limits: 30/min and 500/day per user → `429` with `Retry-After`.

### `GET /chat/history?cursor=<messageId>&limit=<n>`
Response `200`:
```json
{
  "messages": [ /* message shape, newest first */ ],
  "nextCursor": "…" | null
}
```
- `limit`: default 50, max 100.
- `cursor`: the `id` of the oldest message from the previous page. Omit for
  the first page.

---

## Speech

### `POST /speech/transcribe`
Content-Type: `multipart/form-data`
Fields:
- `audio` (file, required) — `m4a` · `webm` · `mp3` · `wav`. Max 25 MB.
- `language` (optional) — `he` or `en`. Hint only.

Response `200`:
```json
{ "text": "…" }
```
- `413` file too large · `415` unsupported format.
- Audio is **not stored**. It streams to the STT provider and is discarded.

Rate limit: 10/min per user.

---

## Devices

### `POST /devices`
Request:
```json
{ "pushToken": "ExpoPushToken[…]", "platform": "ios" }
```
Response `200`:
```json
{ "device": { "id": "…", "platform": "ios", "lastSeenAt": "…" } }
```
- Upsert on `(platform, pushToken)`. If the token was previously owned by
  another user, ownership transfers to the caller.

---

## Sync semantics summary

1. Client generates UUIDs for tasks/events → offline creation works.
2. `POST` is idempotent on `id` (`200` on replay, `409` on cross-user collision).
3. `GET …?updatedSince=` returns rows including soft-deleted ones. Client
   removes local rows whose `deletedAt != null`.
4. `updatedAt` bumps on every mutation, including soft delete.
5. Conflict resolution is last-write-wins by `updatedAt` — client sends
   `updatedAt`, server keeps the larger of the two.

---

## Change log

- `2026-07-23` — Initial contract (aligns with `SPEC_BACKEND_V1.2.md`).
