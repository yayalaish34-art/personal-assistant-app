import type { ShoppingItem } from './api';

// What the trolley is likely to come to.
//
// This is an estimate and is always shown as one. Nobody's prices are in here
// — there is no price API, no shop and no network call — only typical Israeli
// supermarket prices for ordinary things, in shekels, which is enough to tell
// a 60₪ trolley from a 600₪ one before reaching the till.
//
// Two things keep it honest:
//   - Unknown products are excluded, with an explicit count of missing prices.
//     Estimates are opt-in and never prefill actual checkout expenses.
//   - The whole table is scaled by a factor the app learns (see `priceFactor`)
//     from what shops actually cost the user, so a table written in 2026 for
//     one country drifts towards the truth of whoever is holding the phone.

/** Typical shelf price in ILS: per item, or per kg/litre where sold that way. */
const PRICE_GUESS: [RegExp, number][] = [
  // Match the drink before its fruit.
  [/\b(?:grape|orange|apple)\s+juice\b|מיץ\s+(?:ענבים|תפוזים|תפוחים)/i, 10],
  // ── Produce (per kg, mostly) ──
  [/\btomato|עגבני/i, 8],
  [/\bcucumber|מלפפונ/i, 7],
  [/\bavocado|אבוקדו/i, 15],
  [/\bapple|תפוחים|תפוח עץ|תפוחי עץ/i, 12],
  [/\bbanana|בננ/i, 10],
  [/\b(orange|clementine|tangerine)|תפוז|קלמנטינ/i, 9],
  [/\b(lemons?|limes?)\b|לימונ/i, 12],
  [/\bgrape|ענבים/i, 18],
  [/\bstrawberr|תות/i, 20],
  [/\b(watermelon|melon)|אבטיח|מלונ/i, 25],
  [/\bpepper|פלפל/i, 12],
  [/\bcarrot|גזר/i, 6],
  [/\bonion|בצל/i, 6],
  [/\bgarlic|שום/i, 15],
  [/\bpotato|תפוא|תפוחי אדמה/i, 7],
  [/\b(lettuce|salad|cabbage|spinach)|חסה|כרוב|תרד|סלט/i, 10],
  [/\bbroccoli|ברוקולי/i, 14],
  [/\bmushroom|פטריו/i, 16],
  [/\b(parsley|basil|coriander|mint|herbs)|פטרוזיליה|בזיליקום|כוסברה|נענע/i, 5],

  // ── Dairy and eggs ──
  [/\bmilk|חלב/i, 7],
  [/\byogh?urt|יוגורט/i, 5],
  [/\b(cheese|cottage|feta)|גבינ|קוטג/i, 14],
  [/\bice.?cream|גלידה/i, 25],
  [/\b(butter|cream)|חמאה|שמנת/i, 9],
  [/\beggs?\b|ביצ/i, 15],

  // ── Meat and fish (per kg) ──
  [/\b(chicken|turkey)|עוף|הודו|שניצל|פרגית/i, 35],
  [/\b(salmon|fish|tuna)|סלמון|טונה|דגים|דג/i, 70],
  [/\b(meat|beef|steak|mince|lamb|veal)|בשר|סטייק|אנטריקוט/i, 90],
  [/\b(sausage|salami|hot dog)|נקניק/i, 30],
  [/\b(shrimp|prawn|seafood)|שרימפס|פירות ים/i, 80],

  // ── Bakery ──
  [/\b(bread|pitt?a|challah|rolls?|buns?)\b|לחמ|לחם|פית|חלה|חלות/i, 10],
  [/\bcroissant|קרואסונ/i, 8],
  [/\b(cake|cookie|biscuit|pastry)|עוגה|עוגיו|מאפה/i, 20],

  // ── Cupboard ──
  [/\brice|אורז/i, 12],
  [/\b(pasta|spaghetti|noodle)|פסטה|ספגטי|אטריות/i, 8],
  [/\b(olive oil|olives)|שמן זית|זיתים/i, 35],
  [/\bflour|קמח/i, 8],
  [/\bsugar|סוכר/i, 7],
  [/\bsalt\b|מלח/i, 5],
  [/\b(honey|jam)|דבש|ריבה/i, 22],
  [/\bchocolate|שוקולד/i, 8],
  [/\b(cereal|granola|oats)|דגני בוקר|גרנולה|קוואקר/i, 20],
  [/\b(nuts|almond|peanut)|אגוזים|שקדים|בוטנים/i, 35],
  [/\b(hummus|tahini|falafel)|חומוס|טחינה|פלאפל/i, 12],
  [/\b(beans|lentils|chickpeas|tinned|canned)|שעועית|עדשים|שימורים/i, 8],

  // ── Drinks ──
  [/\bcoffee|קפה/i, 30],
  [/\btea\b|(?:^|\s)תה(?:\s|$)/i, 18],
  [/\bwater|(?:^|\s)מים(?:\s|$)/i, 12],
  [/\bjuice|מיץ|מיצ/i, 10],
  [/\bwine|יין|יינ/i, 45],
  [/\bbeer|בירה/i, 8],
  [/\b(soda|cola|coke|fizzy)|קולה|סודה|מוגז/i, 9],

  // ── Cleaning and the house ──
  [/\b(toilet paper|tissue|napkin|kitchen roll)|נייר טואלט|ממחטות|מגבונים|מפיות/i, 25],
  [/\b(shampoo|conditioner)|שמפו|מרכך שיער/i, 22],
  [/\b(laundry|detergent|fabric softener)|כביסה|מרכך/i, 28],
  [/\b(soaps?\b|shower gel|hand wash)|סבונ/i, 14],
  [/\b(washing.?up|dish|sponge|cleaner|bleach)|כלים|ספוג|מנקה|אקונומיקה/i, 12],
  [/\b(bin bag|bin liner|rubbish|trash)|שקיות זבל|זבל/i, 15],
  [/\b(batter(y|ies)|bulb)|סוללות|נורה/i, 25],

  // ── Pharmacy ──
  [/\b(toothpaste|toothbrush)|משחת שיניים|מברשת שיניים/i, 18],
  [/\b(medicine|pills?\b|vitamin|painkiller|paracetamol|ibuprofen)|תרופ|ויטמינ|כדורים|אקמול|נורופן/i, 30],
  [/\b(plaster|bandage|first aid)|פלסטר|תחבושת/i, 15],
  [/\b(deodorant|razor|shaving)|דאודורנט|גילוח/i, 20],
  [/\b(nappy|nappies|diaper|baby)|חיתולים|תינוק/i, 55],
  [/\bflowers|פרחים/i, 50],
];

/**
 * Roughly what one shekel is in other currencies.
 *
 * Deliberately coarse and never refreshed: this is not a converter, it only
 * keeps the estimate in the right order of magnitude for someone shopping
 * outside Israel, and the learned factor corrects the rest. Anything not
 * listed has no estimate, rather than being treated as shekels.
 */
const PER_ILS: Record<string, number> = {
  ILS: 1,
  USD: 0.27,
  EUR: 0.25,
  GBP: 0.21,
  CHF: 0.24,
  CAD: 0.37,
  AUD: 0.41,
  RUB: 25,
  UAH: 11,
  TRY: 9,
  AED: 1,
  INR: 23,
  BRL: 1.5,
  JPY: 40,
};

/** The shelf price of one unit of a thing, in ILS. */
export function unitPrice(item: Pick<ShoppingItem, 'name' | 'category'>): number | null {
  const name = item.name.toLowerCase();
  const hit = PRICE_GUESS.find(([re]) => re.test(name));
  if (hit) return hit[1];
  return null;
}

/** Whether the name was recognised, as opposed to priced by its aisle. */
export function isPriced(item: Pick<ShoppingItem, 'name'>): boolean {
  const name = item.name.toLowerCase();
  return PRICE_GUESS.some(([re]) => re.test(name));
}

/**
 * How many units a written quantity means.
 *
 * "3" is three of them. "500g" is half of whatever a kilo costs, and "2kg" is
 * two — weights and volumes are read against the kilo or litre the table is
 * priced in. Anything unreadable is one, and the whole thing is capped: a
 * typo of "100" bread should not put a thousand shekels on the screen.
 */
export function quantityFactor(quantity: string | null | undefined): number {
  if (!quantity) return 1;
  const q = quantity.trim().toLowerCase().replace(',', '.');
  const num = Number(q.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(num) || num <= 0) return 1;

  // Whole units first: a kilo or a litre is one of what the table prices, so
  // "1.5kg" is one and a half of it. Hebrew is matched without `\b`, which
  // only knows ASCII — `\bגרם\b` never matches, and "500 גרם" was counted as
  // five hundred kilos of cheese.
  if (/\b(kg|kilo|kilos)\b|ק"ג|קג|קילו/.test(q)) return Math.min(20, num);
  if (/\b(l|lt|litres?|liters?)\b|ליטר/.test(q)) return Math.min(20, num);
  // Grams and millilitres are a fraction of it.
  if (/\b(g|gr|grams?)\b|גרם|ג'/.test(q)) return Math.min(20, num / 1000);
  if (/\bml\b|מ"ל/.test(q)) return Math.min(20, num / 1000);
  return Math.min(50, num);
}

/**
 * Things sold by the box, where a large count is the contents rather than the
 * boxes. "Eggs x12" is one carton, not twelve of them — and the table prices
 * the carton, because "eggs" on its own means a carton too.
 */
const PACKS: [RegExp, number][] = [[/\beggs?\b|ביצ/i, 12]];

/** How many of the priced unit a row is, packs accounted for. */
function unitsOf(item: Pick<ShoppingItem, 'name' | 'quantity'>): number {
  const factor = quantityFactor(item.quantity);
  const pack = PACKS.find(([re]) => re.test(item.name.toLowerCase()));
  // Below half a box the count is boxes ("2 eggs" is nobody's shopping list).
  return pack && factor >= pack[1] / 2 ? factor / pack[1] : factor;
}

export type CartEstimate = {
  /** In the user's currency, already scaled by the learned factor. */
  total: number;
  /** How many rows were counted. */
  items: number;
  /** Rows excluded because the product or currency has no estimate. */
  guessed: number;
};

/**
 * What a set of rows is likely to cost.
 *
 * `factor` is the learned correction (see `priceFactor`); `currency` decides
 * which money the answer is in.
 */
export function estimateCart(
  items: Pick<ShoppingItem, 'name' | 'category' | 'quantity'>[],
  currency: string | null,
  factor = 1,
): CartEstimate {
  const rate = currency ? PER_ILS[currency] : undefined;
  if (!rate) return { total: 0, items: items.length, guessed: items.length };
  let total = 0;
  let guessed = 0;
  for (const item of items) {
    const price = unitPrice(item);
    if (price === null) guessed += 1;
    else total += price * unitsOf(item);
  }
  return { total: total * rate * factor, items: items.length, guessed };
}

/** How far a learned factor may stray from the table, either way. */
const FACTOR_MIN = 0.4;
const FACTOR_MAX = 2.5;
/** How much one shop moves the factor. Low, so one odd receipt cannot own it. */
const LEARN_RATE = 0.35;

/**
 * The factor after a shop that actually cost `paid` where the table said
 * `estimated`. Returns the factor unchanged when there is nothing to learn.
 */
export function learnFactor(factor: number, estimated: number, paid: number): number {
  if (!(estimated > 0) || !(paid > 0)) return factor;
  const ratio = (paid / estimated) * factor;
  const next = factor * (1 - LEARN_RATE) + ratio * LEARN_RATE;
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, Math.round(next * 100) / 100));
}
