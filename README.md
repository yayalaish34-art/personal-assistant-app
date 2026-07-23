# Personal Assistant App — עוזר אישי עם יומן

אפליקציית מובייל (iOS / Android / Web) לניהול יומן אישי ולוח שנה, בנויה כמונורפו עם שני חלקים.

## ארכיטקטורה

```
app/
├── frontend/        React Native + Expo (SDK 54)
│   ├── App.tsx                   נקודת כניסה + NavigationContainer
│   ├── index.js                  registerRootComponent
│   └── src/
│       ├── navigation/           Tabs (היום/יומן/לוח שנה/הגדרות) + Stack (טופס מודאלי)
│       ├── screens/              TodayScreen, JournalScreen, CalendarScreen,
│       │                         SettingsScreen, EntryFormScreen
│       ├── components/ui.tsx     רכיבי UI משותפים (Card, Button, Field, ...)
│       ├── lib/api.ts            לקוח API (fetch) מול ה-Backend
│       ├── lib/storage.ts        עטיפת AsyncStorage (הגדרות, מונה רשומות)
│       └── theme.ts              צבעים, ריווח, רדיוסים
│
└── backend/         Express.js (Node) על פורט 5000
    └── src/
        ├── index.js              שרת + middleware + הרכבת ראוטרים
        ├── store.js              אחסון בזיכרון עם שמירה ל-data/db.json
        └── routes/
            ├── journal.js        GET/POST/DELETE /api/journal
            └── events.js         GET/POST/DELETE /api/events
```

### Frontend
- **React Native + Expo** — קוד אחד ל-iOS, Android ו-Web.
- **React Navigation** — ניווט Tabs + Stack.
- **AsyncStorage** — שמירה מקומית של הגדרות ומונה רשומות.

### Backend
- **Express.js** — שרת Node.js על פורט 5000, חושף REST API ל-journal ו-events.
- אחסון פשוט בזיכרון עם persistence לקובץ JSON (להחלפה ב-DB אמיתי בהמשך).

## הרצה

### 1. שרת (Backend)
```bash
cd backend
npm install      # פעם ראשונה
npm run dev      # רץ על http://localhost:5000
```
בדיקה: http://localhost:5000/api/health

### 2. אפליקציה (Frontend)
```bash
cd frontend
npm install      # פעם ראשונה
npm start        # פותח את Expo Dev Tools
```
- לחיצה על `w` — הרצה בדפדפן (Web).
- לחיצה על `a` / `i` — אמולטור Android / iOS.
- סריקת ה-QR עם **Expo Go** (חייב לתמוך ב-SDK 54) — הרצה במכשיר.

> **מכשיר פיזי:** `localhost` מצביע על הטלפון, לא על המחשב.
> היכנס להגדרות באפליקציה ושנה את *כתובת API* ל-IP של המחשב, למשל `http://192.168.1.10:5000`.

## API

| Method | Path                 | תיאור                    |
|--------|----------------------|--------------------------|
| GET    | `/api/health`        | בדיקת חיים               |
| GET    | `/api/journal`       | כל רשומות היומן          |
| POST   | `/api/journal`       | יצירת רשומה              |
| DELETE | `/api/journal/:id`   | מחיקת רשומה              |
| GET    | `/api/events`        | אירועים (`?date=YYYY-MM-DD` לסינון) |
| POST   | `/api/events`        | יצירת אירוע              |
| DELETE | `/api/events/:id`    | מחיקת אירוע              |
