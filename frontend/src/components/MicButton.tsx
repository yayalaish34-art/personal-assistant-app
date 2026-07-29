import { Pressable, StyleSheet, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Mic } from 'lucide-react-native';

import { colors, ACCENT_GRADIENT } from '../theme';

/**
 * Microphone button.
 *
 * Recording is disabled for now. expo-audio calls
 * `requireNativeModule('ExpoAudio')` at its own module top level, and that
 * native module does not exist in Expo Go — so merely reaching the import
 * throws during startup and the app never renders. Guarding the require was
 * not enough to keep it out of the startup path reliably, so the dependency is
 * not referenced at all here.
 *
 * To enable voice: add expo-audio back, re-add its config plugin to app.json,
 * and run a development build (`npx expo run:android`). Expo Go cannot load it.
 */
export function MicButton({ disabled }: { disabled?: boolean }) {
  const explain = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert(
      'Voice needs a development build',
      'Expo Go cannot load the audio module. Type your request instead — the assistant works the same either way.',
    );
  };

  return (
    <Pressable onPress={explain} disabled={disabled}>
      <LinearGradient
        colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
        start={ACCENT_GRADIENT.start}
        end={ACCENT_GRADIENT.end}
        style={[styles.micBtn, styles.micBtnMuted]}
      >
        <Mic color="#fff" size={21} />
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  micBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
  },
  // Dimmed so it reads as unavailable rather than broken.
  micBtnMuted: { opacity: 0.55 },
});
