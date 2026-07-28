import { useCallback, useEffect, useState } from 'react';
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
import SignInScreen from './src/screens/SignInScreen';
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

  // null = still reading storage, so neither branch is rendered yet.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const checkSession = useCallback(async () => {
    const session = await storage.getSession();
    setSignedIn(Boolean(session?.accessToken));
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Hold the first frame until Urbanist is ready, so text doesn't flash in the
  // system font and reflow once the real metrics land.
  if (!fontsLoaded || signedIn === null) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navTheme}>
        <StatusBar style="dark" />
        {signedIn ? (
          <RootNavigator onSignedOut={() => setSignedIn(false)} />
        ) : (
          <SignInScreen onSignedIn={() => setSignedIn(true)} />
        )}
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
