import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { PALETTES, type Palette, type ThemeMode } from '../theme';

// Runtime theme selection.
//
// Unlike the language, this needs no app restart: nothing here depends on a
// native flag read once at startup, so flipping the mode re-renders the tree
// and every screen picks up the new palette.
//
// Screens consume it as:
//   const { palette: c } = useTheme();
//   const styles = useMemo(() => makeStyles(c), [c]);
//
// The useMemo matters — makeStyles calls StyleSheet.create, and rebuilding it
// on every render would allocate a new stylesheet each time.

const STORAGE_KEY = '@pa/theme';

/** Dark is the default: it is the design being matched. */
const DEFAULT_MODE: ThemeMode = 'dark';

type ThemeContextValue = {
  mode: ThemeMode;
  palette: Palette;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  mode: DEFAULT_MODE,
  palette: PALETTES[DEFAULT_MODE],
  setMode: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);

  // Read the saved choice once. Rendering starts on the default rather than
  // waiting, so a slow storage read cannot hold up the first frame; the swap
  // is a re-render, not a restart.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (active && (saved === 'light' || saved === 'dark')) {
          setModeState(saved);
        }
      } catch {
        /* keep the default */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    // Fire-and-forget: the UI has already switched, and a failed write only
    // means the choice is not remembered next launch.
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  const value = useMemo(
    () => ({ mode, palette: PALETTES[mode], setMode, toggle }),
    [mode, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
