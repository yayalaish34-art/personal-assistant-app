/**
 * Where someone is, and what they spend.
 *
 * Country and currency are asked as one question because they are one answer
 * in practice — nobody in Israel wants shekels offered as a separate decision
 * — but they are stored separately, because they are not the same fact and
 * only one of them is used for formatting.
 *
 * The list is deliberately short. It covers the languages the interface ships
 * in plus the places this app is actually used, and ends in an explicit
 * "somewhere else" that keeps the currency question open rather than forcing a
 * wrong country onto someone.
 */

export interface Country {
  /** ISO 3166-1 alpha-2, and the key stored in the profile. */
  code: string;
  /** ISO 4217. What `Intl.NumberFormat` needs to place the symbol. */
  currency: string;
  /** Emoji flag, for the picker. Purely decorative. */
  flag: string;
}

export const COUNTRIES: Country[] = [
  { code: 'IL', currency: 'ILS', flag: '🇮🇱' },
  { code: 'US', currency: 'USD', flag: '🇺🇸' },
  { code: 'GB', currency: 'GBP', flag: '🇬🇧' },
  { code: 'DE', currency: 'EUR', flag: '🇩🇪' },
  { code: 'FR', currency: 'EUR', flag: '🇫🇷' },
  { code: 'ES', currency: 'EUR', flag: '🇪🇸' },
  { code: 'IT', currency: 'EUR', flag: '🇮🇹' },
  { code: 'NL', currency: 'EUR', flag: '🇳🇱' },
  { code: 'CA', currency: 'CAD', flag: '🇨🇦' },
  { code: 'AU', currency: 'AUD', flag: '🇦🇺' },
  { code: 'CH', currency: 'CHF', flag: '🇨🇭' },
  { code: 'RU', currency: 'RUB', flag: '🇷🇺' },
  { code: 'UA', currency: 'UAH', flag: '🇺🇦' },
  { code: 'TR', currency: 'TRY', flag: '🇹🇷' },
  { code: 'AE', currency: 'AED', flag: '🇦🇪' },
  { code: 'IN', currency: 'INR', flag: '🇮🇳' },
  { code: 'BR', currency: 'BRL', flag: '🇧🇷' },
  { code: 'JP', currency: 'JPY', flag: '🇯🇵' },
];

/** Currencies offered on their own, when the country is "somewhere else". */
export const CURRENCIES = [
  'ILS',
  'USD',
  'EUR',
  'GBP',
  'CHF',
  'CAD',
  'AUD',
  'RUB',
  'UAH',
  'TRY',
  'AED',
  'INR',
  'BRL',
  'JPY',
];

/**
 * A first guess from the device, so the question arrives pre-answered.
 *
 * The timezone is the only signal available without asking for a permission,
 * and `Asia/Jerusalem` narrows the country far better than the interface
 * language does — someone reading the app in English may well be in Tel Aviv.
 */
export function guessCountry(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    const city = tz.split('/').pop()?.toLowerCase() ?? '';
    const byCity: Record<string, string> = {
      jerusalem: 'IL',
      tel_aviv: 'IL',
      london: 'GB',
      'new york': 'US',
      new_york: 'US',
      los_angeles: 'US',
      chicago: 'US',
      denver: 'US',
      berlin: 'DE',
      paris: 'FR',
      madrid: 'ES',
      rome: 'IT',
      amsterdam: 'NL',
      toronto: 'CA',
      vancouver: 'CA',
      sydney: 'AU',
      melbourne: 'AU',
      zurich: 'CH',
      moscow: 'RU',
      kiev: 'UA',
      kyiv: 'UA',
      istanbul: 'TR',
      dubai: 'AE',
      kolkata: 'IN',
      calcutta: 'IN',
      sao_paulo: 'BR',
      tokyo: 'JP',
    };
    return byCity[city] ?? null;
  } catch {
    return null;
  }
}

/** The currency a country spends, or null when the code is unknown. */
export function currencyOf(countryCode: string | null): string | null {
  if (!countryCode) return null;
  return COUNTRIES.find((c) => c.code === countryCode)?.currency ?? null;
}

/**
 * An amount, in the user's own currency and their own locale.
 *
 * Falls back to a plain grouped number when no currency has been chosen or the
 * runtime rejects the code — a number with no symbol reads fine, whereas a
 * thrown error takes the screen with it. Hermes ships a real `Intl`, but this
 * is called on every row of the finance screen and is not worth risking.
 */
export function formatMoney(
  amount: number,
  currency: string | null,
  locale: string,
): string {
  try {
    if (currency) {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        // Whole units unless the amount genuinely has cents: a list of round
        // figures reads better without a column of ".00".
        minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(amount);
    }
  } catch {
    /* fall through to the plain number */
  }
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount);
  } catch {
    return String(Math.round(amount));
  }
}

/** Just the symbol, for a compact label beside a figure. */
export function currencySymbol(currency: string | null, locale: string): string {
  if (!currency) return '';
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}
