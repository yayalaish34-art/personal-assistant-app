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
import OnboardingScreen from './src/screens/OnboardingScreen';
import { loadLanguage, isRTL } from './src/lib/i18n';
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
  // The language must resolve before the first render: I18nManager sets the
  // layout direction, and a tree already mounted left-to-right will not flip.
  //
  // `loadLanguage` falls back to the device's own language, which is what lets
  // the questionnaire ask "choose your language" in a language the reader
  // already understands — the first question arrives pre-answered with a good
  // guess rather than in English for everybody.
  const [langReady, setLangReady] = useState(false);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    loadLanguage().finally(() => setLangReady(true));
    storage
      .isOnboarded()
      .then(setOnboarded)
      // Unreadable storage is not a reason to trap someone in onboarding
      // forever; assume they have seen it and let them into the app.
      .catch(() => setOnboarded(true));
  }, []);

  const [fontsLoaded] = useFonts({
    Urbanist_400Regular,
    Urbanist_500Medium,
    Urbanist_600SemiBold,
    Urbanist_700Bold,
  });

  // Hold the first frame until Urbanist is ready, so text doesn't flash in the
  // system font and reflow once the real metrics land.
  if (!fontsLoaded || !langReady || onboarded === null) {
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
        <StatusBar style="dark" />
        {/* The questionnaire sits outside the navigator: it is not somewhere
            you can navigate to or back out of, it is what happens before the
            app exists. Picking a right-to-left language inside it can restart
            the whole surface, which is survivable precisely because language
            is asked first and nothing else has been answered yet. */}
        {onboarded ? (
          <NavigationContainer theme={navTheme}>
            <RootNavigator />
          </NavigationContainer>
        ) : (
          <OnboardingScreen onDone={() => setOnboarded(true)} />
        )}
      </View>
    </SafeAreaProvider>
  );
}
