import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { applyScheme, colors, currentScheme, type Scheme } from '../theme';

// Light or dark, chosen in Settings and remembered on the device.
//
// Built like the language setting in lib/i18n: the tokens in theme.ts are
// rewritten in place, and App.tsx subscribes and remounts the tree so every
// screen renders again with them. Loaded before the first frame, so the app
// never opens in one scheme and flips to the other.

const STORAGE_KEY = '@pa/appearance';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Keeps the browser's own chrome — scrollbars, the page behind the app — in step. */
function paintDocument(): void {
  if (Platform.OS !== 'web') return;
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.documentElement) return;
  doc.documentElement.style.colorScheme = currentScheme();
  doc.body.style.backgroundColor = colors.bg;
}

/** Reads the saved choice and applies it. Dark when nothing was saved. */
export async function loadAppearance(): Promise<Scheme> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') applyScheme(saved);
  } catch {
    /* unreadable storage: stay dark */
  }
  paintDocument();
  return currentScheme();
}

/** The scheme in force. */
export function getAppearance(): Scheme {
  return currentScheme();
}

/** Applies a scheme, tells the app to redraw, and remembers it. */
export async function setAppearance(next: Scheme): Promise<void> {
  if (next === currentScheme()) return;
  applyScheme(next);
  paintDocument();
  listeners.forEach((fn) => fn());
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* the choice still applies for this session */
  }
}

export function subscribeToAppearance(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
