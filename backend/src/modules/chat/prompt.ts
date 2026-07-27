/**
 * prompt.ts — Pure system-prompt builder for the chat module.
 * No LLM calls, no HTTP, no DB.
 */

export interface PromptContext {
  userName: string;
  language: 'he' | 'en';
  timezone: string; // IANA timezone string
  now?: Date; // injectable for testing; defaults to new Date()
}

/**
 * Formats the user-local time using Intl.DateTimeFormat.
 * Returns { formatted, effectiveTz, fallback } where `fallback` is true
 * when the provided timezone was invalid and UTC was used instead.
 */
function formatLocalTime(
  now: Date,
  timezone: string,
  language: 'he' | 'en',
): { formatted: string; effectiveTz: string; fallback: boolean } {
  const locale = language === 'he' ? 'he-IL' : 'en-US';
  try {
    const formatted = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(now);
    return { formatted, effectiveTz: timezone, fallback: false };
  } catch {
    // Invalid IANA timezone — fall back to UTC
    const formatted = new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(now);
    return { formatted, effectiveTz: 'UTC', fallback: true };
  }
}

/**
 * Builds the system prompt for the personal assistant LLM.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const now = ctx.now ?? new Date();
  const { language, timezone, userName } = ctx;

  const utcTime = now.toISOString();
  const { formatted: localTime, effectiveTz, fallback: tzFallback } = formatLocalTime(now, timezone, language);

  if (language === 'he') {
    const lines: string[] = [
      // 1. Role framing
      'אתה העוזר האישי של המשתמש.',
      '',
      // 2. Current time (both forms, always)
      `זמן UTC: ${utcTime}`,
      `שעה מקומית: ${localTime}`,
      ...(tzFallback
        ? [`(Timezone "${timezone}" is invalid; falling back to UTC for local time.)`]
        : []),
      '',
      // 3. Timezone
      `אזור זמן של המשתמש: ${effectiveTz}`,
      '',
      // 4. User name and language
      `שם המשתמש: ${userName}`,
      'שפת המשתמש: עברית',
      '',
      // 5. Confirmation rule (CLAUDE.md §2.1)
      'כלל אישור (חובה): לפני ביצוע כל פעולה שמשנה נתונים, הצע את הפעולה באמצעות קריאת כלי (tool call). השרת יהפוך את הקריאה לכרטיס אישור ממתין; רק לאחר שהמשתמש מאשר תבוצע הפעולה. אם המשתמש דוחה — אשר שקיבלת ועצור.',
      '',
      // 6. Ownership rule (CLAUDE.md §2.2)
      'כלל בעלות: השתמש רק ב-id-ים שראית בשיחה הנוכחית. אל תמציא id של משימה או אירוע. אם אין לך id — שאל את המשתמש או השתמש בקריאת כלי לרשימה.',
      '',
      // 7. Timezone rule
      'כלל זמן: כאשר המשתמש אומר זמן יחסי ("מחר ב-10"), פרש אותו לפי אזור הזמן של המשתמש.',
      '',
      // 8. Event defaults
      'ברירת מחדל לאירוע: אם המשתמש יוצר אירוע ללא שעת סיום, ברירת המחדל היא 60 דקות.',
      '',
      // 9. Response style
      'סגנון תשובה: השב בשפת המשתמש (עברית או אנגלית), בקצרה, ללא אמוג\'ים אלא אם המשתמש השתמש בהם ראשון.',
    ];
    return lines.join('\n');
  } else {
    const lines: string[] = [
      // 1. Role framing
      'You are the user\'s personal assistant.',
      '',
      // 2. Current time (both forms, always)
      `UTC time: ${utcTime}`,
      `User local time: ${localTime}`,
      ...(tzFallback
        ? [`(Timezone "${timezone}" is invalid; falling back to UTC for local time.)`]
        : []),
      '',
      // 3. Timezone
      `User timezone: ${effectiveTz}`,
      '',
      // 4. User name and language
      `User name: ${userName}`,
      'User preferred language: English',
      '',
      // 5. Confirmation rule (CLAUDE.md §2.1)
      'Confirmation rule (critical): Never execute an action directly. For every action that changes data, propose the action via a tool call. The server converts your tool call into a pending confirmation card; only after the user confirms does the action run. If the user rejects, acknowledge and stop.',
      '',
      // 6. Ownership rule (CLAUDE.md §2.2)
      'Ownership rule: Only reference ids you have seen in the current conversation. Do not invent task or event ids. If you don\'t have an id, ask the user or use a list-tools call to find one.',
      '',
      // 7. Timezone rule
      'Timezone rule: Whenever the user says a relative time ("tomorrow at 10"), resolve it in their timezone.',
      '',
      // 8. Event defaults
      'Event defaults: If the user creates an event without an end time, default to 60 minutes.',
      '',
      // 9. Response style
      'Response style: Reply in the user\'s language (Hebrew or English), concise, no emojis unless the user uses them first.',
    ];
    return lines.join('\n');
  }
}
