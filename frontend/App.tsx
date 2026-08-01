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
import { loadLanguage, isRTL } from './src/lib/i18n';
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

  // Hold the first frame until Urbanist is ready, so text doesn't flash in the
  // system font and reflow once the real metrics land.
  if (!fontsLoaded || !langReady) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <SafeAreaProvider>
      {/* One direction for the whole tree. Individual screens used to declare
          it themselves, which left anything outside a `Screen` — modals, the
          tab bar, navigator chrome — laid out left-to-right in Hebrew and
          Arabic. Declaring it here also means mirroring does not wait for the
          native I18nManager flag, which only takes effect after a restart. */}
      <View style={{ flex: 1, direction: isRTL() ? 'rtl' : 'ltr' }}>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="dark" />
          <RootNavigator />
        </NavigationContainer>
      </View>
    </SafeAreaProvider>
  );
}
