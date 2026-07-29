import AsyncStorage from '@react-native-async-storage/async-storage';

// Local preferences. Task and event data lives in lib/api.ts, which is also
// AsyncStorage-backed — this file only holds settings.

const KEYS = {
  settings: '@pa/settings',
  entryCount: '@pa/entryCount',
} as const;

export type Settings = {
  displayName: string;
  notifications: boolean;
};

export const defaultSettings: Settings = {
  displayName: '',
  notifications: true,
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

  async getEntryCount(): Promise<number> {
    return getJSON<number>(KEYS.entryCount, 0);
  },
  async bumpEntryCount(): Promise<number> {
    const next = (await getJSON<number>(KEYS.entryCount, 0)) + 1;
    await setJSON(KEYS.entryCount, next);
    return next;
  },
};
