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
import IntroScreen from './src/screens/IntroScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import { loadLanguage, isRTL, getLanguage, subscribeToLanguage } from './src/lib/i18n';
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

  /**
   * The language the tree is currently rendered in.
   *
   * It is state, and it is also the root's `key`, which is the whole point:
   * `t()` is a plain function reading a module variable, so a component that
   * has already rendered keeps the strings it rendered with. Changing the key
   * throws the tree away and builds it again, so every string, every
   * `alignStart()`, and the root's own `direction` are read fresh.
   *
   * This is what replaced restarting the app. It is a far cheaper way to get
   * the same guarantee, and it does not lose whatever the person was in the
   * middle of.
   */
  const [renderLang, setRenderLang] = useState(getLanguage());
  useEffect(() => subscribeToLanguage(() => setRenderLang(getLanguage())), []);
  /**
   * The animated opening, shown once per cold start. Deliberately not stored:
   * it is the app's front door, not a tutorial — a launch without it feels
   * like walking in through a wall.
   */
  const [introDone, setIntroDone] = useState(false);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    loadLanguage().finally(() => setLangReady(true));
    storage
      .isOnboarded()
      // In development the questionnaire opens every launch. It is the thing
      // being worked on, and answering it once would otherwise hide it behind
      // a stored flag that needs the app deleted to clear. A release build
      // keeps the real behaviour: asked once, never again.
      .then((seen) => setOnboarded(__DEV__ ? false : seen))
      // Unreadable storage is not a reason to trap someone in onboarding
      // forever; assume they have seen it and let them into the app.
      .catch(() => setOnboarded(!__DEV__));
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
      <View key={renderLang} style={{ flex: 1, direction: isRTL() ? 'rtl' : 'ltr' }}>
        <StatusBar style="dark" />
        {/* The questionnaire sits outside the navigator: it is not somewhere
            you can navigate to or back out of, it is what happens before the
            app exists. Picking a right-to-left language inside it can restart
            the whole surface, which is survivable precisely because language
            is asked first and nothing else has been answered yet. */}
        {!introDone ? (
          <IntroScreen onDone={() => setIntroDone(true)} />
        ) : onboarded ? (
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
