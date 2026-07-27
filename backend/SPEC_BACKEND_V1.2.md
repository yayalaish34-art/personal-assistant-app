# Backend Spec — Personal Assistant App (MVP v1.2)

מסמך זה מתאר את אפיון ה-Backend בלבד. הפרונט (React Native + Expo) מחוץ לסקופ.

---

## 1. שירותים

| שירות | תפקיד |
|---|---|
| Auth | אימות טוקני Google/Apple, הנפקת JWT, refresh |
| Users | פרופיל, שפה, מחיקת חשבון |
| Tasks | CRUD משימות |
| Events | CRUD אירועי יומן, שליפה לפי טווח תאריכים |
| Chat | ניהול שיחה, קריאה ל-LLM, פענוח כוונות, זרימת אישור |
| Speech | קבלת אודיו → STT |
| Notifications | רישום Push token, התראות לפני אירוע |

---

## 2. מודל נתונים

Soft delete בכל הטבלאות (נדרש לסנכרון נכון מול הלקוח). כל שינוי של `deleted_at` חייב לעדכן גם `updated_at`, אחרת רשומה מחוקה לא תעלה ב-`updatedSince`.

```
users
  id                          UUID PK
  provider                    ENUM('google','apple')
  provider_user_id            TEXT
  email                       TEXT
  name                        TEXT
  language                    ENUM('he','en') DEFAULT 'he'
  timezone                    TEXT                       -- IANA, למשל "Asia/Jerusalem"
  deletion_requested_at       TIMESTAMPTZ NULL           -- מחיקה מושהית 30 יום
  created_at                  TIMESTAMPTZ
  updated_at                  TIMESTAMPTZ
  deleted_at                  TIMESTAMPTZ NULL
  UNIQUE(provider, provider_user_id)

tasks
  id                          UUID PK                     -- נוצר בצד הלקוח
  user_id                     UUID FK
  title                       TEXT
  notes                       TEXT NULL
  due_at                      TIMESTAMPTZ NULL
  is_done                     BOOLEAN DEFAULT FALSE
  created_at                  TIMESTAMPTZ
  updated_at                  TIMESTAMPTZ
  deleted_at                  TIMESTAMPTZ NULL
  INDEX (user_id, due_at)
  INDEX (user_id, updated_at)                             -- לסנכרון

events
  id                          UUID PK                     -- נוצר בצד הלקוח
  user_id                     UUID FK
  title                       TEXT
  note                        TEXT NULL
  starts_at                   TIMESTAMPTZ                 -- UTC
  ends_at                     TIMESTAMPTZ                 -- UTC
  reminder_minutes_before     INT NULL                    -- NULL = ללא התראה
  created_at                  TIMESTAMPTZ
  updated_at                  TIMESTAMPTZ
  deleted_at                  TIMESTAMPTZ NULL
  INDEX (user_id, starts_at)
  INDEX (user_id, updated_at)                             -- לסנכרון

chat_messages
  id                          UUID PK
  user_id                     UUID FK
  role                        ENUM('user','assistant','tool')
  content                     TEXT
  tool_calls                  JSONB NULL                  -- על הודעות assistant
  tool_call_id                TEXT NULL                   -- על הודעות tool
  pending_action              JSONB NULL                  -- הצעה שממתינה לאישור
  created_at                  TIMESTAMPTZ
  INDEX (user_id, created_at DESC)

devices
  id                          UUID PK
  user_id                     UUID FK
  push_token                  TEXT
  platform                    ENUM('ios','android','web')
  last_seen_at                TIMESTAMPTZ
  created_at                  TIMESTAMPTZ
  UNIQUE(platform, push_token)
```

### אזורי זמן
- `starts_at` / `ends_at` / `due_at` נשמרים ב-UTC.
- ההצגה מבוצעת לפי `users.timezone`.
- **שינוי `users.timezone` לא מזיז אירועים קיימים** (החלטה סופית).

### מחוץ ל-MVP
- All-day events
- Recurring events
- שיתוף אירועים/משימות בין משתמשים
- קטגוריות / תגיות

---

## 3. API

כל endpoint (למעט `/auth/*`) דורש `Authorization: Bearer <access_token>`. סינון משאבים מבוצע לפי `user_id` מהטוקן בלבד — לעולם לא מפרמטר שנשלח מהלקוח.

### Auth
```
POST   /auth/google             { idToken }         → { user, accessToken, refreshToken }
POST   /auth/apple              { idToken }         → { user, accessToken, refreshToken }
POST   /auth/refresh            { refreshToken }    → { accessToken, refreshToken }
POST   /auth/logout             { pushToken? }      → 204   # מוחק את ה-device
```

### Users
```
GET    /me                                          → { user }
PATCH  /me                      { name?, language?, timezone? }
DELETE /me                                          → 202   # מסמן deletion_requested_at
```

### Tasks
```
GET    /tasks?updatedSince=<ISO>                    # כולל deleted_at != NULL
POST   /tasks                   { id, title, notes?, due_at? }   # idempotent על id
PATCH  /tasks/:id               { title?, notes?, due_at?, is_done? }
DELETE /tasks/:id                                   # soft
```

### Events
```
GET    /events?updatedSince=<ISO>                   # כולל deleted_at != NULL
POST   /events                  { id, title, note?, starts_at, ends_at?, reminder_minutes_before? }
PATCH  /events/:id              { title?, note?, starts_at?, ends_at?, reminder_minutes_before? }
DELETE /events/:id                                  # soft
```

### Agenda
```
GET    /agenda?date=YYYY-MM-DD                      → { events: [...], tasks: [...] }
GET    /agenda?from=YYYY-MM-DD&to=YYYY-MM-DD        → { events: [...], tasks: [...] }
```
> `/agenda` מחליף את `GET /events?from=&to=` — קריאה אחת מחזירה גם אירועים וגם משימות עם `due_at` בטווח.

### Chat
```
POST   /chat/message            { text, confirmMessageId? }
                                → { assistantMessage, pendingAction? }
GET    /chat/history?cursor=<id>&limit=<n>          → { messages: [...], nextCursor }
```
- שליחה רגילה: `text` בלבד.
- אישור פעולה: `confirmMessageId` = ה-`id` של הודעת ה-assistant שהציעה את ה-`pending_action`. השרת מבצע את הפעולה, מוחק את `pending_action`, ומחזיר את התוצאה כהודעת `tool`.

### Speech
```
POST   /speech/transcribe       multipart: audio (file), language? → { text }
```
- פורמטים: `m4a`, `webm`, `mp3`, `wav`.
- מקסימום 25MB.
- האודיו נשלח ל-Whisper ב-stream ישיר; לא נשמר לדיסק ולא נשמר לאחר התמלול.

### Devices
```
POST   /devices                 { push_token, platform }  # upsert לפי (platform, push_token)
```

---

## 4. סנכרון

**Pull:** הלקוח שולח `GET /tasks?updatedSince=<last_sync>` ו-`GET /events?updatedSince=<last_sync>`.
- התגובה כוללת גם רשומות מחוקות (`deleted_at != NULL`) — הלקוח מזהה לפי השדה ומוחק אצלו.
- הזמן שהשרת מחזיר (`Date` header או שדה `serverTime` בתגובה) הוא ה-cursor הבא.

**Push:** הלקוח שולח `POST /tasks` / `POST /events` / `PATCH` / `DELETE`.
- `id` (UUID) נוצר בצד הלקוח → מאפשר יצירה offline.
- `POST` idempotent על `id`:
  - `id` חדש → 201.
  - `id` קיים של אותו משתמש עם תוכן זהה → 200.
  - `id` קיים של משתמש אחר → 409.
- Conflict resolution: **last-write-wins לפי `updated_at`** של הלקוח (הלקוח שולח `updated_at`, השרת בוחר בגדול מבין השניים).

---

## 5. זרימת הצ׳אט

```
[Text / STT] → POST /chat/message → LLM (system prompt + history + tools)
                                          ↓
                       ┌──────────────────┴──────────────────┐
                       ↓                                     ↓
              תשובת טקסט רגילה                     tool_call הצעה
                       ↓                                     ↓
                    החזרה                    שמירת pending_action + החזרת כרטיס אישור
                                                             ↓
                                             המשתמש שולח confirmMessageId
                                                             ↓
                                       ownership check → ביצוע → תוצאה כ-role='tool'
```

### System prompt
חייב לכלול:
- תאריך + שעה נוכחיים ב-UTC וב-timezone של המשתמש.
- שם המשתמש, שפה מועדפת (`language`).
- הנחיה: **אין ביצוע אוטומטי**. כל mutation מחייב `pending_action` שהמשתמש יאשר.

### Tools ב-V1
```
create_task(title, due_at?)
update_task(id, title?, due_at?, notes?)
complete_task(id)
list_tasks(range: 'today'|'week'|'overdue'|'all')
create_event(title, starts_at, ends_at?, note?, reminder_minutes_before?)
list_events(from, to)
```
- כל tool מוגדר עם Zod schema (input + output).
- `create_event` — אם `ends_at` חסר → 60 דקות default.
- התנגשות בין אירועים: מותרת ללא חסימה (MVP).
- **Ownership check:** כל mutation מאמת ש-`resource.user_id == token.user_id` לפני ביצוע — גם אם ה-LLM הזה `id`.

### Concurrency
Serialization per-user על `POST /chat/message` (mutex בזיכרון) — מונע tool executions מקבילים על אותו משתמש.

---

## 6. התראות

- שדה `reminder_minutes_before` על event (NULL = ללא).
- **תזמון:** `pg-boss` (Postgres-backed queue) — אין תלות ב-Redis.
- יצירת event עם reminder → יצירת job עם `sendAfter`.
- עדכון event → עדכון job (זמן חדש / הוספה / ביטול).
- מחיקת event → ביטול job.
- שליחה: Expo Push דרך `expo-server-sdk`.

---

## 7. אבטחה

- **JWT:** access token 15min, refresh 30d, rotation on refresh.
- **סינון לפי `user_id` מהטוקן בלבד** — לעולם לא מפרמטר URL/body.
- **Rate limiting:**
  - `POST /chat/message` — 30/דקה, 500/יום למשתמש.
  - `POST /speech/transcribe` — 10/דקה למשתמש.
  - `/auth/*` — 20/דקה לפי IP.
- **אודיו:** מחיקה מיידית לאחר תמלול (streaming, ללא כתיבה לדיסק).
- **הצפנה במנוחה:** תלוי בסביבת ה-DB (RDS encryption / disk).
- **הצפנה בתעבורה:** HTTPS בלבד ב-production.
- **סודות:** `.env` מקומי, secret manager ב-production.
- Middleware: `helmet`, `cors` מוגבל לדומיינים ידועים.

---

## 8. מחיקת חשבון

1. `DELETE /me` → `deletion_requested_at = NOW()`, sessions מנותקים (refresh tokens בטלים).
2. Job יומי (`purgeDeletedUsers`) מוחק סופית מי ש-`deletion_requested_at < NOW() - 30 days`. המחיקה כוללת: tasks, events, chat_messages, devices, users.
3. כניסה מחדש בתקופת ההמתנה → מבטלת ומאפסת `deletion_requested_at`.

---

## 9. Stack

- **Node.js + TypeScript** על **Express**.
- **PostgreSQL 16** + **Prisma** ORM.
- **OpenAI SDK** — Chat (GPT) + Whisper.
- **Expo Server SDK** — Push notifications.
- **pg-boss** — job queue (Postgres-native).
- **Zod** — validation ולוגי tool schemas.
- **jsonwebtoken** — JWT.
- **pino** — logging.
- **Vitest + Supertest** — tests.

---

## 10. משתני סביבה

```
DATABASE_URL
JWT_SECRET
JWT_REFRESH_SECRET
GOOGLE_CLIENT_ID
APPLE_CLIENT_ID
OPENAI_API_KEY
EXPO_ACCESS_TOKEN
PORT                (default 5000)
NODE_ENV
LOG_LEVEL           (default 'info')
```

כל המשתנים נטענים דרך `config.ts` עם `zod.parse(process.env)` — כשל fail-fast בעליית השרת אם חסר או לא תקין.
