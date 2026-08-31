import AsyncStorage from '@react-native-async-storage/async-storage';

// Local preferences. Task and event data lives in lib/api.ts, which is also
// AsyncStorage-backed — this file only holds settings.

const KEYS = {
  settings: '@pa/settings',
  entryCount: '@pa/entryCount',
  profile: '@pa/profile',
  onboarded: '@pa/onboarded',
} as const;

export type Settings = {
  displayName: string;
  notifications: boolean;
};

export const defaultSettings: Settings = {
  displayName: '',
  notifications: true,
};

/** The kinds of thing a diary is made of. Keys, not labels — they are translated. */
export const EVENT_TYPES = [
  'work',
  'study',
  'family',
  'health',
  'sport',
  'social',
  'errands',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Asked once, only to tailor the sleep recommendation shown alongside the
 * sleep-hours question. Never required — `unspecified` is a full answer, not
 * a placeholder for one, and nothing else in the app reads this field.
 */
export type Gender = 'male' | 'female' | 'unspecified';

/**
 * What the opening questionnaire learns about someone.
 *
 * This is not decoration: it rides along with every voice turn and is what
 * stops her offering a meeting at two in the morning or back-to-back with
 * something else. Hours are local wall-clock, 0–23, because that is the only
 * form in which "I work until six" means anything.
 */
export type Profile = {
  /** ISO 3166-1 alpha-2, or null when they chose "somewhere else". */
  country: string | null;
  /** ISO 4217. What the finance screen formats every amount with. */
  currency: string | null;
  workStartHour: number;
  workEndHour: number;
  /** Asleep from → to. Crosses midnight when `sleepStartHour > sleepEndHour`. */
  sleepStartHour: number;
  sleepEndHour: number;
  gender: Gender;
  /** Minutes she keeps clear either side of a meeting. */
  bufferMinutes: number;
  eventTypes: EventType[];
  /** Whatever repeats and cannot move, in the user's own words. */
  fixedCommitments: string;
};

export const defaultProfile: Profile = {
  country: null,
  currency: null,
  workStartHour: 9,
  workEndHour: 18,
  sleepStartHour: 23,
  sleepEndHour: 7,
  gender: 'unspecified',
  bufferMinutes: 15,
  eventTypes: ['work'],
  fixedCommitments: '',
};

async function getJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function setJSON<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort; a failed preference write shouldn't break the screen.
  }
}

export const storage = {
  // Merged over the defaults so a key added later is still populated for
  // installs that saved settings before it existed.
  async getSettings(): Promise<Settings> {
    return {
      ...defaultSettings,
      ...(await getJSON<Partial<Settings>>(KEYS.settings, {})),
    };
  },
  saveSettings: (s: Settings) => setJSON(KEYS.settings, s),

  // Merged over the defaults for the same reason as settings, and because a
  // profile saved by a build with fewer questions must still answer all of
  // them — an unset buffer reading as `undefined` would reach the slot finder
  // as NaN and quietly widen every gap it checks.
  async getProfile(): Promise<Profile> {
    return {
      ...defaultProfile,
      ...(await getJSON<Partial<Profile>>(KEYS.profile, {})),
    };
  },
  saveProfile: (p: Profile) => setJSON(KEYS.profile, p),

  /** Whether the opening questionnaire has been through once. */
  async isOnboarded(): Promise<boolean> {
    return getJSON<boolean>(KEYS.onboarded, false);
  },
  setOnboarded: (done: boolean) => setJSON(KEYS.onboarded, done),

  async getEntryCount(): Promise<number> {
    return getJSON<number>(KEYS.entryCount, 0);
  },
  async bumpEntryCount(): Promise<number> {
    const next = (await getJSON<number>(KEYS.entryCount, 0)) + 1;
    await setJSON(KEYS.entryCount, next);
    return next;
  },
};
