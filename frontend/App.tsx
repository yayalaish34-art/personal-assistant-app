import { useEffect, useMemo, useState } from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';
import {
  useFonts,
  Urbanist_400Regular,
  Urbanist_500Medium,
  Urbanist_600SemiBold,
  Urbanist_700Bold,
} from '@expo-google-fonts/urbanist';

import RootNavigator from './src/navigation';
import { loadLanguage } from './src/lib/i18n';
import { ThemeProvider, useTheme } from './src/lib/theme';

/**
 * Everything below the providers, so it can read the active theme. Splitting
 * this out is what lets the navigation container and status bar follow the
 * palette — a component cannot consume a context its own parent provides.
 */
function Root() {
  const { mode, palette } = useTheme();

  // The language must resolve before the first render: I18nManager sets the
  // layout direction, and a tree already mounted left-to-right will not flip.
  const [langReady, setLangReady] = useState(false);
  useEffect(() => {
    loadLanguage().finally(() => setLangReady(true));
  }, []);

  const [fontsLoaded] = useFonts({
    Urbanist_400Regular,
    Urbanist_500Medium,
    Urbanist_600SemiBold,
    Urbanist_700Bold,
  });

  const navTheme = useMemo(() => {
    const base = mode === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: palette.bg,
        card: palette.surface,
        text: palette.text,
        border: palette.border,
        primary: palette.primary,
      },
    };
  }, [mode, palette]);

  // Hold the first frame until Urbanist is ready, so text doesn't flash in the
  // system font and reflow once the real metrics land.
  if (!fontsLoaded || !langReady) {
    return <View style={{ flex: 1, backgroundColor: palette.bg }} />;
  }

  return (
    <NavigationContainer theme={navTheme}>
      {/* Light glyphs on the dark ground, dark on the light one. */}
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Root />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
