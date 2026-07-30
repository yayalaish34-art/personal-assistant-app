import { useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Animated, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Mic, Square } from 'lucide-react-native';

import { transcribe } from '../lib/assistant';
import { ACCENT_GRADIENT } from '../theme';

/**
 * Record → transcribe button.
 *
 * expo-audio calls `requireNativeModule('ExpoAudio')` in its own module body,
 * so it only resolves in a build that bundles the native module — a
 * development or production build, not Expo Go. It is required lazily and
 * guarded so that, if it ever loads somewhere without the native side, the
 * button explains itself instead of taking down the screen.
 */
type AudioApi = typeof import('expo-audio');

type Recorder = {
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  uri: string | null;
};

let cached: AudioApi | null | undefined;
function getAudio(): AudioApi | null {
  if (cached !== undefined) return cached;
  try {
    const load = require as (id: string) => AudioApi;
    cached = load('expo-audio');
  } catch {
    cached = null;
  }
  return cached;
}

export function MicButton({
  disabled,
  onRecordingChange,
  onTranscribing,
  onTranscribed,
  onError,
}: {
  disabled?: boolean;
  onRecordingChange?: (recording: boolean) => void;
  onTranscribing?: (busy: boolean) => void;
  onTranscribed: (text: string) => void | Promise<void>;
  onError?: (e: unknown) => void;
}) {
  const recorderRef = useRef<Recorder | null>(null);
  const [recording, setRecording] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    onRecordingChange?.(recording);
  }, [recording, onRecordingChange]);

  // Pulsing ring so it's obvious the mic is live.
  useEffect(() => {
    if (!recording) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [recording, pulse]);

  const start = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const audio = getAudio();
    if (!audio) {
      Alert.alert(
        'Recording unavailable',
        'This build does not include the audio module. Type your request instead.',
      );
      return;
    }
    try {
      const { granted } = await audio.AudioModule.requestRecordingPermissionsAsync();
      if (!granted) {
        Alert.alert('Microphone needed', 'Allow microphone access to talk to your assistant.');
        return;
      }
      await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      const Ctor = (audio as unknown as {
        AudioRecorder?: new (options: unknown) => Recorder;
      }).AudioRecorder;
      if (typeof Ctor !== 'function') {
        throw new Error('The audio module loaded without a recorder.');
      }

      const rec = new Ctor(audio.RecordingPresets.HIGH_QUALITY);
      recorderRef.current = rec;
      await rec.prepareToRecordAsync();
      rec.record();
      setRecording(true);
    } catch (e) {
      Alert.alert('Couldn’t start recording', (e as Error).message);
    }
  };

  const stop = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRecording(false);
    onTranscribing?.(true);
    try {
      const rec = recorderRef.current;
      if (!rec) throw new Error('No recording in progress.');
      await rec.stop();
      const uri = rec.uri;
      if (!uri) throw new Error('No audio was captured.');

      // The recording is posted straight through; the server streams it to the
      // speech-to-text provider and keeps nothing.
      const text = await transcribe(uri);
      if (!text.trim()) {
        Alert.alert('Nothing heard', 'Try again and speak a little louder.');
        return;
      }
      await onTranscribed(text);
    } catch (e) {
      if (onError) onError(e);
      else Alert.alert('Transcription failed', (e as Error).message);
    } finally {
      recorderRef.current = null;
      onTranscribing?.(false);
    }
  };

  return (
    <Pressable onPress={recording ? stop : start} disabled={disabled}>
      <View>
        {recording ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.pulseRing,
              {
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                transform: [
                  { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) },
                ],
              },
            ]}
          />
        ) : null}
        <LinearGradient
          colors={
            recording
              ? (['#F0797C', '#E5484D'] as unknown as [string, string])
              : (ACCENT_GRADIENT.colors as unknown as [string, string])
          }
          start={ACCENT_GRADIENT.start}
          end={ACCENT_GRADIENT.end}
          style={styles.micBtn}
        >
          {recording ? (
            <Square color="#fff" size={17} fill="#fff" />
          ) : (
            <Mic color="#fff" size={21} />
          )}
        </LinearGradient>
      </View>
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
    shadowColor: ACCENT_GRADIENT.colors[1],
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
  },
  pulseRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#E5484D',
  },
});
