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

## Voice assistant

Stateless and unauthenticated, like `POST /parse`: the device owns the tasks
and events, sends what the assistant needs to see, and applies what comes back.
The server owns the provider keys and nothing else — it reads and writes no
rows for these two routes.

### `POST /voice/turn`
Request:
```json
{
  "text": "move the dentist to tomorrow at four",
  "language": "he",
  "timezone": "Asia/Jerusalem",
  "now": "2026-07-30T14:00:00.000Z",
  "userName": "Yonatan",
  "history": [{ "role": "user", "content": "…" }],
  "snapshot": {
    "tasks": [{ "id": "…", "title": "…", "notes": null, "dueAt": null, "isDone": false }],
    "events": [{ "id": "…", "title": "…", "note": null, "startsAt": "…", "endsAt": "…" }]
  },
  "profile": {
    "workStartHour": 9,
    "workEndHour": 18,
    "sleepStartHour": 23,
    "sleepEndHour": 7,
    "bufferMinutes": 15,
    "eventTypes": ["work", "family"],
    "fixedCommitments": "Gym Mon & Wed at 6am"
  }
}
```
- `text` required, 1–2000 chars.
- `language` — **any ISO-639-1 code** (two lowercase letters, default `he`).
  It sets the language of the **opening greeting only**. Every other turn is
  answered in whatever language `text` is in, and switching language
  mid-conversation switches the answers with it.
  Only the shape is validated, not the particular language: a code the server
  has no name for greets in English rather than failing the turn, so a client
  may ship a new interface language ahead of a server deploy. Malformed codes
  (`zzz`, `EN`, `e1`, `""`) are still `400`.
- `text` of exactly `"[SESSION START]"` means "the user just opened you":
  she greets them and summarises the day instead of answering anything.
- `history` — up to 20 earlier turns, oldest first, `user`/`assistant` only.
- `snapshot` — up to 200 tasks and 200 events. This is the whole of what she
  can see; ids come from here.
- `profile` — **optional**, the answers from the opening questionnaire. Every
  field has a default and each is filled in independently, so a partial object
  is valid and a missing one is fine (an install from before the questionnaire,
  or someone who skipped it). Hours are local wall-clock integers `0–23`;
  `bufferMinutes` is `0–120`; `eventTypes` is up to 20 short strings;
  `fixedCommitments` is free text up to 500 chars. Out-of-range values are a
  `400` rather than being clamped.

  Two of these change the times the server will offer in `offer_times`:
  **sleep hours** are never proposed, and **`bufferMinutes`** is kept clear
  either side of anything already in the diary. **Working hours are guidance
  only** — they reach the model, not the slot finder, so an evening can still
  be offered when the request calls for one.

Response `200`:
```json
{
  "reply": "העברתי את הפגישה למחר בארבע.",
  "actions": [
    { "tool": "update_event", "arguments": { "id": "…", "matchTitle": "…", "startsAt": "…" } }
  ],
  "canSpeak": true
}
```
- `reply` — one or two spoken sentences, plain text, in the language of `text`
  (or of `language`, for the greeting turn).
- `actions` — what the **client** must apply to its own storage, in order.
  Tools: `create_task` · `update_task` · `complete_task` · `delete_task` ·
  `create_event` · `update_event` · `delete_event` · `add_shopping_item` ·
  `add_money_entry`. Times are ISO-8601 with an explicit offset.
- `add_shopping_item` puts one thing on the shopping list:
  `{ "tool": "add_shopping_item", "arguments": { "name": "milk",
  "quantity": "2", "note": "…", "category": "dairy" } }`. Only `name` is
  required. `category` is one of `produce` `dairy` `meat` `bakery` `cleaning`
  `pharmacy` `other`. One call per item — three items is three actions.
- `add_money_entry` records money in or out:
  `{ "tool": "add_money_entry", "arguments": { "kind": "expense",
  "description": "lunch", "amount": 42, "date": "2026-03-10",
  "category": "food" } }`. `kind` is `income` or `expense`; **`amount` is
  always positive** and `kind` alone carries the direction, so a client must
  not negate it a second time. `date` is `YYYY-MM-DD` and is omitted when the
  user gave none — the client fills in its own local today. `category` is one
  of `salary` `business` `refund` `gift` (income) or `shopping` `food`
  `housing` `bills` `transport` `health` `fun` `other` (expense).
- Both carry no `matchTitle` and no id: they name nothing in `snapshot`, so
  neither the ownership gate nor the duplicate gate applies to them. There are
  no update or delete tools for either, and no shopping or money arrays in
  `snapshot` — the model only ever adds a row, it never reads or changes one.
- `create_image` also arrives in `actions`, and is the one that changes no
  storage: `{ "tool": "create_image", "arguments": { "prompt": "…",
  "shape": "square" } }`. The client is expected to call `POST /image` with
  those arguments **separately**, and to keep talking while it waits — see the
  timing note there. It carries no `matchTitle` and no id, because it names
  nothing in the snapshot.
- Every action that names an existing entry carries `matchTitle`, the title as
  it appears in the snapshot. The server rejects the action when the id and the
  title disagree, so a misidentified entry never reaches the device.
- Ids outside the snapshot are dropped server-side; the model is told and asks
  the user instead.
- `canSpeak` — whether `/voice/speak` is configured. When false the client
  shows the reply without audio.

Rate limit: 30/min and 500/day per caller.

### `GET /voice/speak?text=<text>`
Response `200`: `audio/mpeg` (the mp3 itself, with `Content-Length`).
- `text` max 900 chars — a spoken answer, not a document.
- `language` is **no longer part of this route**. A client still appending it
  is neither rejected nor affected by it. The voice model is chosen from the
  text itself: Hebrew script gets `eleven_v3`, the only model that speaks it;
  everything else gets the faster flash model.
- Returns audio a media player can stream directly; the client passes this URL
  to the player rather than buffering the body.
- `400` when speech is not configured on the server, or generation failed.
- Nothing is stored: the audio is generated per request and discarded.

Rate limit: 10/min per caller.

---

## Images

### `POST /image`
Request:
```json
{ "prompt": "a cat asleep on a windowsill", "shape": "square" }
```
- `prompt` required, 1–1000 chars, English. This is what gets drawn.
- `shape` one of `square` (default) · `portrait` · `landscape`, mapping to
  1024×1024, 1024×1536 and 1536×1024.

Response `200`:
```json
{ "image": "<base64 png>", "mimeType": "image/png" }
```
- Base64 rather than a URL, so the client owns the bytes and has nothing that
  expires. Measured: a 1024×1024 png is roughly **1.3 MB** before base64 adds a
  third on top. Write it to a file — it is far too large for a key-value store.
- **Measured generation time: about 35 seconds.** Do not await this inside a
  conversational turn; ask for it alongside and fill the result in when it
  lands.
- `400` when image generation is not configured on the server, or the model
  returned nothing.

Rate limit: 4/min and 30/day per caller — deliberately tighter than the rest,
because a picture costs orders of magnitude more than a chat turn and takes
long enough that a double tap is more likely than a genuine second request.

Unauthenticated and stateless: nothing is stored server-side.

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

- `2026-08-27` — **BREAKING** for any client that implemented it: the
  `create_note` tool is **removed** from the `actions` of `POST /voice/turn`,
  and `add_shopping_item` and `add_money_entry` take its place. The notes
  screen it fed no longer exists in the app, so a note the model filed had
  nowhere to be read; the two new tools feed the shopping list and the finance
  screen that replaced it. Same stateless shape as the tools around them: no
  id, no `matchTitle`, and no new arrays in `snapshot`. A client that ignores
  unknown tools degrades to doing nothing for these two rather than breaking.
  **Outside the frozen MVP v1.1 scope** (`CLAUDE.md` §1, which names shopping
  lists explicitly); built on an explicit request, same as `create_image`.

- `2026-08-17` — `POST /voice/turn` accepts an optional `profile`, the output
  of the new opening questionnaire. Sleep hours and the preferred gap between
  meetings now shape the times returned in `offer_times`; working hours,
  event types and standing commitments reach the model as guidance. Not
  breaking — the field is optional and omitting it gives exactly the previous
  behaviour. **Outside the frozen MVP v1.1 scope** (`CLAUDE.md` §1); built on
  an explicit request, same as `create_image` and `create_note`.
- `2026-08-16` — The interface ships in 25 languages, and `language` on
  `POST /voice/turn` is no longer a fixed enum: any two-letter ISO-639-1 code
  is accepted, and one the server has no name for greets in English instead of
  returning `400`. The enum tied a list living in the client to a server
  deploy — an app shipping a new interface language ahead of the server would
  have lost the whole turn, not just the greeting the code was for.
  `GET /voice/speak` no longer declares `language` at all; a client still
  appending it is unaffected. Not breaking: every previously valid request
  stays valid.
- `2026-08-15` — Added a `create_note` tool to the `actions` of
  `POST /voice/turn`, for filing free-text notes that are neither a task nor
  an event. No id, no `matchTitle`, no `update_note`/`delete_note`, and no
  `notes` array added to `snapshot` — the model only ever files a new one. Not
  breaking — a client that ignores an unknown tool in `actions` behaves as
  before. **Outside the frozen MVP v1.1 scope** (`CLAUDE.md` §1); built on an
  explicit request, same as `create_image`.
- `2026-08-13` — The voice assistant speaks every language: replies mirror the
  language of `text` on `POST /voice/turn`, and `language` there now sets only
  the opening greeting. On `GET /voice/speak` the `language` parameter is
  accepted but ignored — the voice model is picked from the text's script
  (Hebrew → `eleven_v3`, otherwise flash). Wire shapes are unchanged and old
  callers keep working, so not breaking; only the answering language moved,
  from "always `language`" to "the language spoken to her".
- `2026-08-13` — Added image generation: `POST /image`, and a `create_image`
  tool that arrives in the `actions` of `POST /voice/turn`. Stateless and
  unauthenticated like the rest of the assistant. Not breaking — a client that
  ignores an unknown tool in `actions` behaves as before. **Outside the frozen
  MVP v1.1 scope** (`CLAUDE.md` §1); built on an explicit request.
- `2026-07-23` — Initial contract (aligns with `SPEC_BACKEND_V1.2.md`).
- `2026-08-01` — The voice assistant answers in Hebrew by default:
  `language` on `POST /voice/turn` and `GET /voice/speak` now defaults to
  `he` instead of `en`. `POST /transcribe` accepts an optional `language`
  field (ISO-639-1) as a hint to the speech-to-text model; unrecognised
  values are ignored rather than forwarded. Not breaking — callers that send
  `language` are unaffected.
- `2026-07-30` — Added the voice assistant: `POST /voice/turn` and
  `GET /voice/speak`. Stateless and unauthenticated, like `POST /parse` — the
  client applies the returned `actions` to its own storage. Nothing in the
  existing contract changed.
