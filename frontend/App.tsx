import { useEffect, useState } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
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
import { api } from './src/lib/api';
import { storage } from './src/lib/storage';
import { colors } from './src/theme';

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: '#FFFFFF',
    text: colors.text,
    border: colors.border,
    primary: colors.primary,
  },
};

export default function App() {
  const [fontsLoaded] = useFonts({
    Urbanist_400Regular,
    Urbanist_500Medium,
    Urbanist_600SemiBold,
    Urbanist_700Bold,
  });

  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      // Every data endpoint is behind authMiddleware and scopes rows by the
      // token's user, so a session is required even with no sign-in screen.
      // Sign in silently as the local dev user; the refresh token lasts 30
      // days and the API client rotates it on 401.
      try {
        const existing = await storage.getSession();
        if (!existing?.accessToken) {
          const { user, accessToken, refreshToken } = await api.signInAsDevUser();
          await storage.saveSession({
            accessToken,
            refreshToken,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              language: user.language,
              timezone: user.timezone,
            },
          });
        }
      } catch {
        // Server unreachable — render anyway. Each screen surfaces its own
        // connection error rather than blocking the whole app behind a splash.
      }
      if (active) setReady(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Hold the first frame until Urbanist is ready, so text doesn't flash in the
  // system font and reflow once the real metrics land.
  if (!fontsLoaded || !ready) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navTheme}>
        <StatusBar style="dark" />
        <RootNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
