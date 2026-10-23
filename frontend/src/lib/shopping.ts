import type { ShoppingCategory, ShoppingItem } from './api';

// What the shopping list knows about the things on it, apart from the screen:
// the picture and the aisle a name implies, how a typed line splits into
// items, and what the history of ticks says is about to run out.

/**
 * The little picture at the start of a row, and the aisle it lives in, guessed
 * from what the thing is.
 *
 * A list is scanned, not read, and a picture is found faster than a word. An
 * English word has to start a word, so "rice" is not found in "price", and
 * one that would run on into another thing ("egg" into "eggplant") is held at
 * its end too. Hebrew has no `\b`, so its words are listed as typed, cut
 * before a final letter (לחמ, not לחם) so the plural matches as well. The
 * first match wins, so the particular is listed above the general: chicken
 * before meat, ice cream before cream, shampoo before the softener in the
 * laundry aisle.
 *
 * The aisle rides along so a line typed into the quick add lands under its
 * heading without anyone opening the sheet — the same guess that picks the
 * picture already knows where the thing is shelved.
 */
const ITEM_GUESS: [RegExp, string, ShoppingCategory][] = [
  // ── Produce ──
  [/\btomato|עגבני/i, '🍅', 'produce'],
  [/\bcucumber|מלפפונ/i, '🥒', 'produce'],
  [/\bavocado|אבוקדו/i, '🥑', 'produce'],
  [/\bapple|תפוחים|תפוח עץ|תפוחי עץ/i, '🍎', 'produce'],
  [/\bbanana|בננ/i, '🍌', 'produce'],
  [/\b(orange|clementine|tangerine)|תפוז|קלמנטינ/i, '🍊', 'produce'],
  [/\b(lemons?|limes?)\b|לימונ/i, '🍋', 'produce'],
  [/\bgrape|ענבים/i, '🍇', 'produce'],
  [/\bstrawberr|תות/i, '🍓', 'produce'],
  [/\b(watermelon|melon)|אבטיח|מלונ/i, '🍉', 'produce'],
  [/\bpepper|פלפל/i, '🫑', 'produce'],
  [/\bcarrot|גזר/i, '🥕', 'produce'],
  [/\bonion|בצל/i, '🧅', 'produce'],
  [/\bgarlic|שום/i, '🧄', 'produce'],
  [/\bpotato|תפוא|תפוחי אדמה/i, '🥔', 'produce'],
  [/\b(lettuce|salad|cabbage|spinach)|חסה|כרוב|תרד|סלט/i, '🥬', 'produce'],
  [/\bbroccoli|ברוקולי/i, '🥦', 'produce'],
  [/\bmushroom|פטריו/i, '🍄', 'produce'],
  [/\b(parsley|basil|coriander|mint|herbs)|פטרוזיליה|בזיליקום|כוסברה|נענע/i, '🌿', 'produce'],

  // ── Dairy and eggs ──
  [/\bmilk|חלב/i, '🥛', 'dairy'],
  [/\byogh?urt|יוגורט/i, '🍶', 'dairy'],
  [/\b(cheese|cottage|feta)|גבינ|קוטג/i, '🧀', 'dairy'],
  [/\bice.?cream|גלידה/i, '🍦', 'dairy'],
  [/\b(butter|cream)|חמאה|שמנת/i, '🧈', 'dairy'],
  [/\beggs?\b|ביצ/i, '🥚', 'dairy'],

  // ── Meat and fish ──
  [/\b(chicken|turkey)|עוף|הודו|שניצל|פרגית/i, '🍗', 'meat'],
  [/\b(salmon|fish|tuna)|סלמון|טונה|דגים|דג/i, '🐟', 'meat'],
  [/\b(meat|beef|steak|mince|lamb|veal)|בשר|סטייק|אנטריקוט/i, '🥩', 'meat'],
  [/\b(sausage|salami|hot dog)|נקניק/i, '🌭', 'meat'],
  [/\b(shrimp|prawn|seafood)|שרימפס|פירות ים/i, '🦐', 'meat'],

  // ── Bakery ──
  [/\b(bread|pitt?a|challah|rolls?|buns?)\b|לחמ|לחם|פית|חלה|חלות/i, '🍞', 'bakery'],
  [/\bcroissant|קרואסונ/i, '🥐', 'bakery'],
  [/\b(cake|cookie|biscuit|pastry)|עוגה|עוגיו|מאפה/i, '🍰', 'bakery'],

  // ── Cupboard ──
  [/\brice|אורז/i, '🍚', 'other'],
  [/\b(pasta|spaghetti|noodle)|פסטה|ספגטי|אטריות/i, '🍝', 'other'],
  [/\b(olive oil|olives)|שמן זית|זיתים/i, '🫒', 'other'],
  [/\bflour|קמח/i, '🌾', 'other'],
  [/\bsugar|סוכר/i, '🍬', 'other'],
  [/\bsalt\b|מלח/i, '🧂', 'other'],
  [/\b(honey|jam)|דבש|ריבה/i, '🍯', 'other'],
  [/\bchocolate|שוקולד/i, '🍫', 'other'],
  [/\b(cereal|granola|oats)|דגני בוקר|גרנולה|קוואקר/i, '🥣', 'other'],
  [/\b(nuts|almond|peanut)|אגוזים|שקדים|בוטנים/i, '🥜', 'other'],
  [/\b(hummus|tahini|falafel)|חומוס|טחינה|פלאפל/i, '🧆', 'other'],
  [/\b(beans|lentils|chickpeas|tinned|canned)|שעועית|עדשים|שימורים/i, '🫘', 'other'],

  // ── Drinks ──
  [/\bcoffee|קפה/i, '☕', 'other'],
  // Two short Hebrew words that also sit inside longer ones, so they are held
  // to a word of their own by the spaces around them.
  [/\btea\b|(?:^|\s)תה(?:\s|$)/i, '🍵', 'other'],
  [/\bwater|(?:^|\s)מים(?:\s|$)/i, '💧', 'other'],
  [/\bjuice|מיץ|מיצ/i, '🧃', 'other'],
  [/\bwine|יין|יינ/i, '🍷', 'other'],
  [/\bbeer|בירה/i, '🍺', 'other'],
  [/\b(soda|cola|coke|fizzy)|קולה|סודה|מוגז/i, '🥤', 'other'],

  // ── Cleaning and the house ──
  [/\b(toilet paper|tissue|napkin|kitchen roll)|נייר טואלט|ממחטות|מגבונים|מפיות/i, '🧻', 'cleaning'],
  [/\b(shampoo|conditioner)|שמפו|מרכך שיער/i, '🧴', 'pharmacy'],
  [/\b(laundry|detergent|fabric softener)|כביסה|מרכך/i, '🧴', 'cleaning'],
  [/\b(soaps?\b|shower gel|hand wash)|סבונ/i, '🧼', 'pharmacy'],
  [/\b(washing.?up|dish|sponge|cleaner|bleach)|כלים|ספוג|מנקה|אקונומיקה/i, '🧽', 'cleaning'],
  [/\b(bin bag|bin liner|rubbish|trash)|שקיות זבל|זבל/i, '🗑️', 'cleaning'],
  [/\b(batter(y|ies)|bulb)|סוללות|נורה/i, '🔋', 'other'],

  // ── Pharmacy ──
  [/\b(toothpaste|toothbrush)|משחת שיניים|מברשת שיניים/i, '🪥', 'pharmacy'],
  [/\b(medicine|pills?\b|vitamin|painkiller|paracetamol|ibuprofen)|תרופ|ויטמינ|כדורים|אקמול|נורופן/i, '💊', 'pharmacy'],
  [/\b(plaster|bandage|first aid)|פלסטר|תחבושת/i, '🩹', 'pharmacy'],
  [/\b(deodorant|razor|shaving)|דאודורנט|גילוח/i, '🧴', 'pharmacy'],
  [/\b(nappy|nappies|diaper|baby)|חיתולים|תינוק/i, '🍼', 'pharmacy'],
  [/\bflowers|פרחים/i, '💐', 'other'],
];

/** When the name says nothing, the aisle does. */
const CATEGORY_EMOJI: Record<ShoppingCategory, string> = {
  produce: '🥬',
  dairy: '🧀',
  meat: '🍗',
  bakery: '🥖',
  cleaning: '🧽',
  pharmacy: '💊',
  other: '🛒',
};

/** Neither a word nor an aisle to go on — it is still something to buy. */
const ANY_ITEM = '🛒';

export function itemEmoji(item: Pick<ShoppingItem, 'name' | 'category'>): string {
  const name = item.name.toLowerCase();
  const hit = ITEM_GUESS.find(([re]) => re.test(name));
  if (hit) return hit[1];
  return item.category ? CATEGORY_EMOJI[item.category] : ANY_ITEM;
}

/** The aisle a name implies, or null when it implies none. */
export function guessCategory(name: string): ShoppingCategory | null {
  const lower = name.toLowerCase();
  return ITEM_GUESS.find(([re]) => re.test(lower))?.[2] ?? null;
}

/** Names compared as a person reads them: case, spacing and a trailing s aside. */
export function sameItem(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

// ── Reading a typed line ─────────────────────────────────────────────────────

/** Number words said before a thing, as people type them. */
const NUMBER_WORDS: Record<string, string> = {
  שני: '2',
  שתי: '2',
  שניים: '2',
  שתיים: '2',
  שלוש: '3',
  שלושה: '3',
  ארבע: '4',
  ארבעה: '4',
  חמש: '5',
  חמישה: '5',
  שש: '6',
  שישה: '6',
  עשר: '10',
  עשרה: '10',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  ten: '10',
  dozen: '12',
  תריסר: '12',
};

/** Units that belong with the number rather than the name. */
const UNIT =
  '(?:kg|kilo|kilos|g|gr|grams?|l|lt|litres?|liters?|ml|packs?|pcs|x|ק"ג|קג|קילו|גרם|ג\'|ליטר|ליטרים|מ"ל|יח\'|יחידות|יחידה|חבילות|חבילה|שקיות|שקית|בקבוקים|בקבוק|קופסאות|קופסה)';

const LEADING = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})?\\s+(.+)$`, 'i');
const TRAILING = new RegExp(`^(.+?)\\s+(?:x\\s*|×\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})?$`, 'i');
const TIMES = /^(.+?)\s*[x×]\s*(\d+)$/i;

export type ParsedItem = {
  name: string;
  quantity: string | null;
  note: string | null;
  category: ShoppingCategory | null;
};

/**
 * One piece of a typed line: "2 milk", "cheese 500g", "eggs x12",
 * "שתי חלות", "coffee (the dark roast)".
 *
 * A number that is part of the name — "3%" milk, "7up" — stays in the name,
 * because the number patterns demand a space and nothing after the unit.
 */
function parsePiece(raw: string): ParsedItem | null {
  let text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return null;

  let note: string | null = null;
  const bracket = text.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (bracket) {
    text = bracket[1].trim();
    note = bracket[2].trim() || null;
  }

  let name = text;
  let quantity: string | null = null;

  const words = text.split(' ');
  const spoken = NUMBER_WORDS[words[0]?.toLocaleLowerCase() ?? ''];
  let m: RegExpMatchArray | null;
  if (spoken && words.length > 1) {
    quantity = spoken;
    name = words.slice(1).join(' ');
  } else if ((m = text.match(TIMES))) {
    name = m[1];
    quantity = m[2];
  } else if ((m = text.match(LEADING))) {
    quantity = m[2] && m[2].toLowerCase() !== 'x' ? `${m[1]} ${m[2]}` : m[1];
    name = m[3];
  } else if ((m = text.match(TRAILING))) {
    quantity = m[3] ? `${m[2]} ${m[3]}` : m[2];
    name = m[1];
  }

  name = name.trim();
  if (!name) return null;
  return { name, quantity, note, category: guessCategory(name) };
}

/**
 * A line from the quick add, split into the things on it.
 *
 * Commas, semicolons and new lines separate items — "milk, 2 bread, eggs x12"
 * is three rows. " and " / " + " do too in English. Hebrew's "ו" is not split
 * on: it starts too many words that are one thing.
 */
export function parseQuickAdd(line: string): ParsedItem[] {
  return line
    .split(/[,;\n،]+|\s+\+\s+|\s+and\s+/i)
    .map(parsePiece)
    .filter((p): p is ParsedItem => p !== null);
}

// ── What the ticks say ───────────────────────────────────────────────────────

/** One thing's buying history. */
export type HistoryEntry = {
  /** As last written, for showing. */
  name: string;
  category: ShoppingCategory | null;
  /** When it was ticked, newest last, capped. */
  times: string[];
};

export type ShoppingHistory = Record<string, HistoryEntry>;

/** How many ticks a thing remembers — enough for a rhythm, not a ledger. */
export const HISTORY_CAP = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Suggestion = {
  name: string;
  category: ShoppingCategory | null;
  count: number;
  /** Past its usual gap since it was last bought: probably running low. */
  due: boolean;
  /** Days between buys, when there is a rhythm to read. */
  everyDays: number | null;
};

/**
 * What to offer under the quick add: things bought before and not on the list
 * now, the ones that are probably running out first, then the most bought.
 *
 * "Running out" is read off the rhythm: two or more ticks give an average gap,
 * and a thing whose last tick is that far behind is due. Two ticks on the
 * same afternoon are one shop, so gaps under a day are not a rhythm.
 */
export function suggestionsFrom(
  history: ShoppingHistory,
  onList: ShoppingItem[],
  now = Date.now(),
  limit = 10,
): Suggestion[] {
  const open = new Set(onList.filter((i) => !i.isBought).map((i) => normalizeName(i.name)));

  const out: Suggestion[] = [];
  for (const [key, h] of Object.entries(history)) {
    if (open.has(key) || h.times.length === 0) continue;
    const stamps = h.times.map((s) => new Date(s).getTime()).filter((n) => !Number.isNaN(n));
    if (stamps.length === 0) continue;
    stamps.sort((a, b) => a - b);

    let everyDays: number | null = null;
    let due = false;
    if (stamps.length >= 2) {
      const span = stamps[stamps.length - 1] - stamps[0];
      const avg = span / (stamps.length - 1);
      if (avg >= DAY_MS) {
        everyDays = Math.round(avg / DAY_MS);
        due = now - stamps[stamps.length - 1] >= avg * 0.9;
      }
    }
    out.push({ name: h.name, category: h.category, count: stamps.length, due, everyDays });
  }

  return out
    .sort((a, b) => Number(b.due) - Number(a.due) || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The list as plain text, for sending to whoever is going to the shop. */
export function listAsText(
  title: string,
  items: ShoppingItem[],
  aisleName: (c: ShoppingCategory | 'none') => string,
  order: readonly ShoppingCategory[],
): string {
  const open = items.filter((i) => !i.isBought);
  const lines: string[] = [`🛒 ${title}`];
  const keys: (ShoppingCategory | 'none')[] = [...order, 'none'];
  for (const key of keys) {
    const rows = open.filter((i) => (i.category ?? 'none') === key);
    if (!rows.length) continue;
    lines.push('', aisleName(key));
    for (const r of rows) {
      const extra = [r.quantity, r.note].filter(Boolean).join(' · ');
      lines.push(`☐ ${r.name}${extra ? ` — ${extra}` : ''}`);
    }
  }
  return lines.join('\n');
}
