# Personal Assistant App — עוזר אישי

> **English summary:** A Hebrew-first personal assistant with a chat interface, tasks, and calendar. This repository contains a production-ready Node/TypeScript backend (Phases 0–5 complete) and a React Native + Expo frontend (not touched in this iteration; may drift from the new backend contract).

---

## מה זה

עוזר אישי מבוסס צ׳אט לניהול משימות ולוח שנה. המשתמש מדבר (טקסט או קול), ה-LLM מפרש כוונה ומציע פעולה, המשתמש מאשר, והפעולה מבוצעת. ה-Backend בנוי על Node.js + TypeScript + PostgreSQL.

---

## מבנה הרפו

```
personal-assistant-app/
├── backend/      Node.js + TypeScript + Express + PostgreSQL — זה מה שנבנה כאן
└── frontend/     React Native + Expo (SDK 54) — לא נגע בזה בשלב זה
```

> **שים לב:** ה-Frontend עלול לא להיות מסונכרן עם חוזה ה-API החדש. יש להתאים אותו בנפרד מול `backend/API_CONTRACT.md`.

---

## דרישות מוקדמות

- **Node.js 22+** — נדרש לתמיכה ב-`--env-file` המובנה (נטמע ב-Node 20.6 אך מומלץ 22)
- **Docker Desktop** — לאתחול Postgres מקומי
- **git**

---

## הרצה מקומית

### 1. כניסה לתיקיית ה-Backend וסביבת עבודה

```bash
cd backend
cp .env.example .env
```

פתח את `.env` ומלא:

- `JWT_SECRET` ו-`JWT_REFRESH_SECRET` — צור כל אחד עם:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
- `OPENAI_API_KEY` — נדרש לצ׳אט ולתמלול קול
- `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID` — נדרש לאימות (ניתן לדלג אם לא בודקים auth)
- `EXPO_ACCESS_TOKEN` — נדרש לשליחת push notifications

### 2. הפעלת ה-DB

```bash
docker compose up -d
```

המתן עד שהסטטוס `(healthy)` — לרוב כ-60 שניות. בדוק עם `docker compose ps`.

### 3. התקנת תלויות

```bash
npm install
```

### 4. הרצת מיגרציות

```bash
npx prisma migrate deploy
```

(לסביבת פיתוח טרייה לגמרי: `npx prisma migrate dev`)

### 5. הרצת השרת

```bash
npm run dev
```

השרת מאזין על `http://localhost:5000`. בדוק: `GET /health`.

### 6. הרצת הטסטים

```bash
npm test
```

---

## מסמכים מרכזיים

| קובץ | תוכן |
|---|---|
| `backend/SPEC_MVP_V1.1.md` | מפרט המוצר — חזון, משתמש יעד, משטחי ה-Frontend |
| `backend/SPEC_BACKEND_V1.2.md` | מפרט טכני — מודל נתונים, API, אבטחה, stack |
| `backend/API_CONTRACT.md` | חוזה ה-Wire עם ה-Frontend — כל endpoint, שדה, status code ו-enum |
| `backend/CLAUDE.md` | הנחיות לסוכן AI — אינווריאנטים, בחירת מודל, הרשאות קבצים |
