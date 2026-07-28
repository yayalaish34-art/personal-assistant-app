import AsyncStorage from '@react-native-async-storage/async-storage';

// Thin typed wrapper around AsyncStorage for local device data
// (settings, auth tokens, cached data).
const KEYS = {
  settings: '@pa/settings',
  entryCount: '@pa/entryCount',
  auth: '@pa/auth',
} as const;

export type Settings = {
  displayName: string;
  apiBaseUrl: string;
  notifications: boolean;
};

export const defaultSettings: Settings = {
  displayName: '',
  apiBaseUrl: 'http://localhost:5000',
  notifications: true,
};

/** Tokens from POST /auth/google|apple, plus the user row it returned. */
export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    language: string;
    timezone: string;
  };
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
    // best-effort; ignore write failures on the skeleton
  }
}

export const storage = {
  getSettings: () => getJSON<Settings>(KEYS.settings, defaultSettings),
  saveSettings: (s: Settings) => setJSON(KEYS.settings, s),

  getSession: () => getJSON<AuthSession | null>(KEYS.auth, null),
  saveSession: (s: AuthSession) => setJSON(KEYS.auth, s),
  async clearSession(): Promise<void> {
    try {
      await AsyncStorage.removeItem(KEYS.auth);
    } catch {
      /* best-effort */
    }
  },

  async getEntryCount(): Promise<number> {
    return getJSON<number>(KEYS.entryCount, 0);
  },
  async bumpEntryCount(): Promise<number> {
    const next = (await getJSON<number>(KEYS.entryCount, 0)) + 1;
    await setJSON(KEYS.entryCount, next);
    return next;
  },
};
