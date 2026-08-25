import { DevSettings, I18nManager, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';

import type { Dict } from './types';
import { en } from './en';
import { he } from './he';
import { it } from './it';
import { es } from './es';
import { fr } from './fr';
import { ru } from './ru';
import { ar } from './ar';
import { bn } from './bn';
import { zh } from './zh';
import { nl } from './nl';
import { de } from './de';
import { el } from './el';
import { hi } from './hi';
import { id } from './id';
import { ja } from './ja';
import { ko } from './ko';
import { fa } from './fa';
import { pl } from './pl';
import { pt } from './pt';
import { ro } from './ro';
import { sv } from './sv';
import { th } from './th';
import { tr } from './tr';
import { uk } from './uk';
import { vi } from './vi';

export type { TranslationKey, Dict } from './types';

// Translations and text direction.
//
// Each language is its own file under this directory; this one holds the
// machinery and the table below. Adding a language is adding a file and a row.
//
// Hebrew, Arabic and Persian are right-to-left, which is a layout concern and
// not just a string one: React Native flips flex rows, text alignment, and
// writing direction only when I18nManager is told to. That flag is read once
// at startup by the native layer, so switching to or from an RTL language
// needs an app reload — see `setLanguage`.

/**
 * Every language the interface is available in.
 *
 * `tag` is the BCP-47 locale for `Intl`, and it is spelled out rather than
 * derived. It used to be built by uppercasing the code, which happens to be
 * right for `it-IT` and `fr-FR` and is wrong the moment the region differs
 * from the language — `ja-JA`, `hi-HI` and `uk-UK` are not locales, and
 * `Intl` quietly falls back to English formatting when handed one.
 *
 * Note this table governs the *interface* only. The voice assistant answers in
 * whatever language it is spoken to, listed here or not.
 */
export const LANGUAGES = {
  // The languages the app shipped with, kept first: these are the ones the
  // picker shows before it is expanded.
  en: { label: 'English', native: 'English', tag: 'en-US', rtl: false },
  he: { label: 'Hebrew', native: 'עברית', tag: 'he-IL', rtl: true },
  ar: { label: 'Arabic', native: 'العربية', tag: 'ar', rtl: true },
  es: { label: 'Spanish', native: 'Español', tag: 'es-ES', rtl: false },
  fr: { label: 'French', native: 'Français', tag: 'fr-FR', rtl: false },
  it: { label: 'Italian', native: 'Italiano', tag: 'it-IT', rtl: false },
  ru: { label: 'Russian', native: 'Русский', tag: 'ru-RU', rtl: false },

  // The rest, by English name.
  bn: { label: 'Bengali', native: 'বাংলা', tag: 'bn-BD', rtl: false },
  zh: { label: 'Chinese', native: '简体中文', tag: 'zh-CN', rtl: false },
  nl: { label: 'Dutch', native: 'Nederlands', tag: 'nl-NL', rtl: false },
  de: { label: 'German', native: 'Deutsch', tag: 'de-DE', rtl: false },
  el: { label: 'Greek', native: 'Ελληνικά', tag: 'el-GR', rtl: false },
  hi: { label: 'Hindi', native: 'हिन्दी', tag: 'hi-IN', rtl: false },
  id: { label: 'Indonesian', native: 'Bahasa Indonesia', tag: 'id-ID', rtl: false },
  ja: { label: 'Japanese', native: '日本語', tag: 'ja-JP', rtl: false },
  ko: { label: 'Korean', native: '한국어', tag: 'ko-KR', rtl: false },
  fa: { label: 'Persian', native: 'فارسی', tag: 'fa-IR', rtl: true },
  pl: { label: 'Polish', native: 'Polski', tag: 'pl-PL', rtl: false },
  pt: { label: 'Portuguese', native: 'Português', tag: 'pt-BR', rtl: false },
  ro: { label: 'Romanian', native: 'Română', tag: 'ro-RO', rtl: false },
  sv: { label: 'Swedish', native: 'Svenska', tag: 'sv-SE', rtl: false },
  th: { label: 'Thai', native: 'ไทย', tag: 'th-TH', rtl: false },
  tr: { label: 'Turkish', native: 'Türkçe', tag: 'tr-TR', rtl: false },
  uk: { label: 'Ukrainian', native: 'Українська', tag: 'uk-UA', rtl: false },
  vi: { label: 'Vietnamese', native: 'Tiếng Việt', tag: 'vi-VN', rtl: false },
} as const;

export type Language = keyof typeof LANGUAGES;

const STORAGE_KEY = '@pa/language';

const DICTS: Record<Language, Dict> = {
  en, he, ar, es, fr, it, ru,
  bn, zh, nl, de, el, hi, id, ja, ko, fa, pl, pt, ro, sv, th, tr, uk, vi,
};

/** Active language. Set synchronously at startup before the first render. */
let current: Language = 'en';

export function getLanguage(): Language {
  return current;
}

export function isRTL(): boolean {
  return LANGUAGES[current].rtl;
}

/**
 * `textAlign` for text that should hug the start of the line.
 *
 * Text direction is detected per string, and a string of digits — "12", "85%",
 * "9:00 AM" — has no right-to-left character in it, so it is taken for
 * left-to-right and aligns left even inside a mirrored screen. The number then
 * sits at the far edge from the label underneath it. Saying which edge is meant
 * puts the two back together.
 *
 * Call it while rendering, not from `StyleSheet.create`: stylesheets are built
 * when a module is first imported, which can be before the language is known.
 */
export function alignStart(): 'left' | 'right' {
  return isRTL() ? 'right' : 'left';
}

/**
 * Looks up a key, falling back to English and then to the key itself, so a
 * missing translation degrades to readable text rather than a blank label.
 * `{{name}}` placeholders are substituted from `vars`.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[current] as Record<string, string | undefined>;
  const source = en as Record<string, string | undefined>;
  const value = dict[key] ?? source[key] ?? key;
  if (!vars) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    name in vars ? String(vars[name]) : `{{${name}}}`,
  );
}

/** BCP-47 tag for Intl date and number formatting. */
export function locale(): string {
  return LANGUAGES[current].tag;
}

/** The device's language, when the app supports it. */
function deviceLanguage(): Language | null {
  const tag = Localization.getLocales()[0]?.languageCode;
  return tag && tag in LANGUAGES ? (tag as Language) : null;
}

/** Reads the stored choice, falling back to the device language, then English. */
export async function loadLanguage(): Promise<Language> {
  try {
    const saved = (await AsyncStorage.getItem(STORAGE_KEY)) as Language | null;
    current = saved && saved in LANGUAGES ? saved : (deviceLanguage() ?? 'en');
  } catch {
    current = 'en';
  }
  await applyDirection();
  return current;
}

// Set once we have already restarted trying to make the native flag stick, so
// a host app that refuses to go RTL (Expo Go's own manifest decides that, not
// ours) cannot put us in a reload loop.
const RELOAD_MARKER_KEY = '@pa/rtlReloadedFor';

// ── Telling the app the language moved ──────────────────────────────────────
//
// Nothing here re-renders on its own: `t()` is a plain function call and
// `current` is a module variable, so a component that has already rendered
// keeps the strings it rendered with. The app used to restart on every change,
// which made that moot. Without the restart, something has to say so.

type LanguageListener = () => void;
const listeners = new Set<LanguageListener>();

/** Subscribe to language changes. Returns the unsubscribe. */
export function subscribeToLanguage(fn: LanguageListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announceLanguage(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // A listener that throws is not a reason to leave the rest unnotified.
    }
  }
}

/**
 * Restarts the JS surface. The native RTL flag is read when a surface starts,
 * so flipping it only shows up after a reload.
 *
 * Returns false when it cannot restart by itself and the user has to do it.
 */
function reloadApp(): boolean {
  if (Platform.OS === 'web') {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc) return false;
    loc.reload();
    return true;
  }
  // DevSettings.reload only exists while the dev client is attached, which is
  // the case in Expo Go and in a debug build. A release build has to be
  // restarted by hand (expo-updates is not a dependency here).
  if (__DEV__ && typeof DevSettings?.reload === 'function') {
    DevSettings.reload();
    return true;
  }
  return false;
}

/**
 * Tells React Native which way to lay out.
 *
 * Two mechanisms, because neither covers every case on its own:
 *
 *  - The native I18nManager flag. This is the one that mirrors *everything*,
 *    including native views and the old architecture, but the native side
 *    reads it when a surface starts, so it needs a reload to take hold — and
 *    on Android it is ignored entirely unless the host app's manifest sets
 *    `android:supportsRtl`, which Expo Go decides for us.
 *  - The `direction` style, applied at the root in App.tsx. Yoga honours it
 *    per subtree with no restart, so it covers the case above — but only on
 *    the new architecture (the old Android renderer has no such prop) and on
 *    web, where the `dir` attribute below does the same job.
 *
 * Returns true when it kicked off a reload, so the caller knows not to also
 * ask the user to restart.
 */
async function applyDirection(): Promise<boolean> {
  const rtl = LANGUAGES[current].rtl;

  if (Platform.OS === 'web') {
    // react-native-web ships I18nManager as a no-op stub: allowRTL and
    // forceRTL return immediately and isRTL is hardcoded false, so calling
    // them flips nothing. The browser mirrors layout from the document's
    // `dir` attribute instead, which also gives flex rows, text alignment,
    // and logical properties the right direction for free.
    const doc = (globalThis as { document?: Document }).document;
    if (doc?.documentElement) {
      doc.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr');
      doc.documentElement.setAttribute('lang', current);
    }
    return false;
  }

  // Allowed, but not forced, and never restarted for.
  //
  // `forceRTL` writes a native flag that is only read when a surface starts,
  // so honouring it meant restarting the app on every change of direction.
  // Two things made that unnecessary. The root declares `direction` itself,
  // and on the new architecture Yoga mirrors the whole subtree from it with no
  // restart at all. And the flag frequently would not stick in the first place
  // — inside Expo Go it is Expo Go's own manifest that decides direction, not
  // ours — so the restart was often paid for and bought nothing.
  //
  // The guard that went with it keyed on the language code rather than on the
  // direction, which is why switching between two left-to-right languages
  // restarted too: the code differed, so the guard read it as a new attempt.
  I18nManager.allowRTL(rtl);
  try {
    await AsyncStorage.removeItem(RELOAD_MARKER_KEY);
  } catch {
    /* a leftover marker from an older build is harmless */
  }
  return false;
}

/**
 * Saves the choice and applies it.
 *
 * Returns true when the app has to be restarted by hand for the new direction
 * to show — React Native cannot flip an already-rendered tree, so the text
 * would translate while the layout stayed mirrored the old way. When the
 * restart could be done for us, this returns false and the app is already on
 * its way back up.
 */
export async function setLanguage(next: Language): Promise<boolean> {
  current = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* the in-memory value still applies for this session */
  }
  await applyDirection();
  // Whoever is listening re-reads `current` and re-renders; nobody is asked to
  // restart anything. Kept returning a boolean so the callers' "you have to
  // restart by hand" path survives if a platform ever needs it again.
  announceLanguage();
  return false;
}
