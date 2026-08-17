import { en } from './en';

/** Every key the app can ask for, derived from English. */
export type TranslationKey = keyof typeof en;

/**
 * One language's translations.
 *
 * Partial on purpose. A key nobody has translated yet falls back to the
 * English string at runtime, so a dictionary that is behind is safe to ship —
 * but a key that is not in English *at all* is a typo or a stale copy, and
 * `Partial<Record<TranslationKey, …>>` makes that a build error rather than a
 * label that silently renders as its own identifier.
 */
export type Dict = Partial<Record<TranslationKey, string>>;
