/**
 * How long a thing in the diary actually takes.
 *
 * An hour is the right default for "meeting with the accountant". It is the
 * wrong default for a wedding, and wrong in a way that produces nonsense: a
 * wedding starting at 20:30 leaves the evening "free from 21:30", so the
 * assistant cheerfully offers to send someone shopping in the middle of it.
 *
 * Two things are being decided here, and they are not the same:
 *
 *   - `minutes` — how much of the clock the thing occupies.
 *   - `closesEvening` — whether anything *after* it that same evening is
 *     realistic. A wedding is over at some point, but nobody does the weekly
 *     shop afterwards. This is what stops "technically free at 01:00" being
 *     offered as an answer.
 *
 * Matching is on the title, in the languages the app ships its own interface
 * in. It is deliberately a table rather than a judgement the model makes: the
 * same wedding must block the same hours every time it is asked about, and a
 * model asked to estimate gives four hours one turn and six the next.
 *
 * A title that matches nothing keeps the ordinary one-hour default. That is the
 * safe direction to be wrong in — an unrecognised event blocks too little
 * rather than silently swallowing someone's whole week.
 */

export interface Occasion {
  /** What to assume it lasts when the event carries no end time. */
  minutes: number;
  /** Whether the rest of that evening is realistically spoken for. */
  closesEvening: boolean;
  /** Names the rule, for the sentence she says and for the tests. */
  kind: string;
}

/** The ordinary case, and what `create_event` already assumes. */
export const DEFAULT_MINUTES = 60;

interface Rule extends Occasion {
  /** Matched case-insensitively against the title. */
  words: string[];
}

/**
 * Order matters: the first rule that matches wins, so the more specific
 * patterns are listed before the general ones. "flight" before "trip".
 */
const RULES: Rule[] = [
  {
    kind: 'wedding',
    minutes: 300,
    closesEvening: true,
    words: ['wedding', 'חתונה', 'חינה', 'حفل زفاف', 'زفاف', 'boda', 'mariage', 'matrimonio', 'hochzeit', 'свадьба'],
  },
  {
    kind: 'barMitzvah',
    minutes: 240,
    closesEvening: true,
    words: ['bar mitzvah', 'bat mitzvah', 'בר מצווה', 'בת מצווה', 'ברית', 'בריתה'],
  },
  {
    kind: 'funeral',
    minutes: 180,
    closesEvening: true,
    words: ['funeral', 'shiva', 'לוויה', 'הלוויה', 'שבעה', 'אזכרה', 'جنازة'],
  },
  {
    kind: 'flight',
    minutes: 240,
    closesEvening: true,
    words: ['flight', 'טיסה', 'رحلة طيران', 'vuelo', 'vol ', 'volo', 'flug', 'рейс'],
  },
  {
    kind: 'show',
    // A concert or a play plus getting there and home again.
    minutes: 180,
    closesEvening: true,
    words: [
      'concert', 'show', 'theatre', 'theater', 'opera', 'gig',
      'הופעה', 'קונצרט', 'תיאטרון', 'הצגה', 'מופע',
      'حفلة', 'مسرح', 'concierto', 'spectacle', 'concerto', 'konzert', 'концерт',
    ],
  },
  {
    kind: 'party',
    minutes: 240,
    closesEvening: true,
    words: [
      'party', 'birthday', 'anniversary',
      'מסיבה', 'יום הולדת', 'יומולדת', 'אירוע',
      'حفلة عيد', 'fiesta', 'fête', 'festa', 'feier', 'вечеринка',
    ],
  },
  {
    kind: 'dinner',
    // Long enough that the evening is spent, but not a whole night out.
    minutes: 150,
    closesEvening: true,
    words: [
      'dinner', 'ארוחת ערב', 'ארוחה משפחתית', 'שישי משפחתי', 'ליל הסדר', 'סדר',
      'cena', 'dîner', 'abendessen', 'ужин', 'عشاء',
    ],
  },
  {
    kind: 'movie',
    minutes: 150,
    closesEvening: true,
    words: ['movie', 'cinema', 'film', 'סרט', 'קולנוע', 'película', 'кино'],
  },
  {
    kind: 'appointment',
    // Medical and similar: longer than an hour in practice because of waiting,
    // but it does not write off the evening.
    minutes: 90,
    closesEvening: false,
    words: [
      'surgery', 'operation', 'hospital', 'ניתוח', 'בית חולים', 'בדיקה',
      'مستشفى', 'cirugía', 'chirurgie', 'операция',
    ],
  },
];

/**
 * What kind of thing this title describes, if the table knows.
 *
 * Returns null rather than a default so callers can tell "no rule applied"
 * from "the rule says an hour" — the sentence she says differs.
 */
export function classify(title: string): Occasion | null {
  const t = title.trim().toLowerCase();
  if (!t) return null;
  for (const rule of RULES) {
    if (rule.words.some((w) => t.includes(w))) {
      return { minutes: rule.minutes, closesEvening: rule.closesEvening, kind: rule.kind };
    }
  }
  return null;
}

/**
 * How long to treat an event as occupying.
 *
 * A real end time always wins — someone who said when it finishes has already
 * answered this question, and second-guessing them with a table would move
 * their own meeting. The table only fills in what was left blank.
 */
export function occupiedMinutes(title: string, hasExplicitEnd: boolean): number {
  if (hasExplicitEnd) return DEFAULT_MINUTES; // caller uses the real end instead
  return classify(title)?.minutes ?? DEFAULT_MINUTES;
}
