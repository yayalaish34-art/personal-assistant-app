/**
 * errand-classifier.ts — map a task title to the kind of place that would
 * fulfil it. "לקנות מתנה לרונית" → `mall`, "לקנות חלב" → `supermarket`.
 *
 * The signal is used by the opportunity path: if a user has a free window
 * AND an errand on the task list AND a matching place within reach, the
 * assistant can make a specific offer ("Dizengoff Center is 3 minutes
 * away — want to pick up the gift now?").
 *
 * Rules are tested in order; the first match wins, so put specific rules
 * (gift, prescription) BEFORE general ones (shopping, store).
 */

export interface ErrandMatch {
  /** A category key from CATEGORY_OSM_TAGS in `places-index.ts`. */
  category: string;
  /** A short label of what this task is about — used in the nudge text. */
  keyword: string;
}

interface Rule {
  pattern: RegExp;
  category: string;
  keyword: string;
}

/**
 * Hebrew uses no word boundaries the way `\b` understands, so each rule
 * carries its own boundary — a Latin `\b` on the English side and a
 * negative lookahead/behind on the Hebrew side where needed.
 */
const RULES: Rule[] = [
  // Gifts — specific, strong signal for "mall".
  { pattern: /(מתנה|מתנות|gift|present)/i, category: 'mall', keyword: 'gift' },

  // Pharmacy / medicine.
  { pattern: /(תרופה|תרופות|מרשם|קופת.?חולים|pharmacy|medicine|prescription|drugstore)/i, category: 'pharmacy', keyword: 'pharmacy' },

  // Fuel.
  { pattern: /(תדלוק|לתדלק|דלק\s|gas station|fuel|petrol)/i, category: 'gas_station', keyword: 'fuel' },

  // Post office / package pickup.
  { pattern: /(דואר|חבילה|post office|mailbox|package|parcel)/i, category: 'post_office', keyword: 'post' },

  // Dry cleaning — must beat generic "clothes" because clothes is broader.
  { pattern: /(ניקוי יבש|מכבסה|dry cleaner|dry clean|laundry)/i, category: 'clothes', keyword: 'cleaner' },

  // Haircut / barber.
  { pattern: /(תספורת|מספרה|haircut|hair cut|hairdresser|barber)/i, category: 'hairdresser', keyword: 'haircut' },

  // Dentist (must beat generic "doctor").
  { pattern: /(שיניים|רופא.?שיניים|dentist)/i, category: 'dentist', keyword: 'dentist' },

  // Doctor / clinic.
  { pattern: /(רופא|מרפאה|בדיקה רפואית|doctor|clinic|appointment)/i, category: 'doctor', keyword: 'doctor' },

  // Bakery (bread / cake / specific pastry words).
  { pattern: /(מאפייה|חלה|עוגה|קרואסון|bakery|pastry|cake)/i, category: 'bakery', keyword: 'bakery' },

  // ATM / cash.
  { pattern: /(כספומט|למשוך כסף|למשוך מזומן|atm|withdraw cash)/i, category: 'atm', keyword: 'atm' },

  // Bank branch (not ATM).
  { pattern: /(סניף הבנק|בנק\b|bank branch)/i, category: 'bank', keyword: 'bank' },

  // Grocery / supermarket.
  { pattern: /(מכולת|קניות שבועיות|חלב|לחם|ביצים|grocery|supermarket|milk|bread|eggs)/i, category: 'supermarket', keyword: 'grocery' },

  // Clothes (general, after the dry-cleaning rule).
  { pattern: /(חליפה|שמלה|חולצה|מכנסיים|נעליים|בגדים|clothes|shirt|dress|pants|shoes)/i, category: 'clothes', keyword: 'clothes' },

  // Books.
  { pattern: /(ספרים|חנות ספרים|book shop|bookstore|books)/i, category: 'books', keyword: 'books' },

  // Phone / electronics.
  { pattern: /(חנות סלולר|phone shop|mobile shop|smartphone)/i, category: 'mobile_phone', keyword: 'phone' },
];

/** Return the first category this title matches, or null if none applies. */
export function classifyErrand(title: string): ErrandMatch | null {
  const t = title.trim();
  if (!t) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(t)) return { category: rule.category, keyword: rule.keyword };
  }
  return null;
}
