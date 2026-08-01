import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Animated,
  Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { X, Mic, Undo2 } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api } from '../lib/api';
import { useVoiceSession } from '../lib/useVoiceSession';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, TILES } from '../theme';
import { t } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Assistant'>;

/**
 * The assistant, out loud.
 *
 * She opens the conversation, listens, does what she is asked, and answers —
 * there is nothing to type here, by design. The one control is the orb: tap it
 * to say you are finished talking, or to cut in while she is speaking.
 */
export default function AssistantScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState<string>('');
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let active = true;
    void api.getMe().then(({ user }) => {
      if (active) setName(user.name ?? '');
    });
    return () => {
      active = false;
    };
  }, []);

  const { state, lines, level, error, undoable, toggle, undoLast, end } = useVoiceSession({
    userName: name || undefined,
  });

  // ── The orb: a slow breath, plus the mic level while she listens ──
  const breath = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);

  useEffect(() => {
    Animated.timing(pulse, {
      toValue: state === 'listening' ? level : state === 'speaking' ? 0.55 : 0,
      duration: 120,
      useNativeDriver: true,
    }).start();
  }, [level, state, pulse]);

  useEffect(() => {
    // Keep the newest line in view as the conversation grows.
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [lines.length]);

  const close = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    end();
    navigation.goBack();
  };

  const caption =
    state === 'listening'
      ? t('voice.listening')
      : state === 'thinking'
        ? t('voice.thinking')
        : state === 'speaking'
          ? t('voice.speaking')
          : state === 'unavailable'
            ? error === 'microphone'
              ? t('voice.micDenied')
              : t('voice.unavailable')
            : state === 'stopped'
              ? t('voice.ended')
              : t('voice.starting');

  const hint =
    state === 'listening'
      ? t('voice.tapToStop')
      : state === 'speaking'
        ? t('voice.tapToInterrupt')
        : state === 'starting' || state === 'thinking'
          ? t('voice.hint')
          : '';

  const orbScale = Animated.add(
    breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }),
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }),
  );

  const deleted = undoable.filter((c) => c.destructive);

  return (
    <Screen clearTabBar={false}>
      <View style={styles.headerRow}>
        <Pressable onPress={close} style={styles.iconBtn} accessibilityRole="button">
          <X color={colors.text} size={22} />
        </Pressable>
        <Text style={styles.title}>{t('voice.title')}</Text>
        {/* Balances the close button so the title stays centred. */}
        <View style={styles.iconBtn} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        showsVerticalScrollIndicator={false}
      >
        {lines.map((line) => (
          <View
            key={line.id}
            style={[line.role === 'user' ? styles.userBubble : styles.herBubble]}
          >
            <Text style={line.role === 'user' ? styles.userText : styles.herText}>
              {line.text}
            </Text>
          </View>
        ))}
      </ScrollView>

      {deleted.length > 0 ? (
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            undoLast();
          }}
          style={styles.undoBar}
          accessibilityRole="button"
        >
          <Undo2 color={colors.text} size={16} />
          <Text style={styles.undoText} numberOfLines={1}>
            {t('voice.undo')} · {deleted.map((c) => c.title).join(', ')}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.stage}>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            toggle();
          }}
          disabled={state === 'unavailable'}
          accessibilityRole="button"
          accessibilityLabel={caption}
        >
          <Animated.View style={[styles.orbGlow, { transform: [{ scale: orbScale }] }]}>
            <View style={styles.orb}>
              <Mic color={colors.primaryText} size={44} />
            </View>
          </Animated.View>
        </Pressable>

        <Text style={styles.caption}>{caption}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}

        {state === 'stopped' ? (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              // The session runs for the life of the screen, so starting over
              // means mounting a fresh one.
              navigation.replace('Assistant');
            }}
            style={styles.restartBtn}
          >
            <Text style={styles.restartText}>{t('voice.restart')}</Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  title: { fontSize: 18, ...font(600), color: colors.text },

  transcript: { flex: 1 },
  transcriptContent: { paddingVertical: spacing.md, gap: spacing.sm },
  herBubble: {
    alignSelf: 'flex-start',
    maxWidth: '88%',
    backgroundColor: colors.surface,
    borderRadius: 22,
    borderStartStartRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  herText: { fontSize: 16, ...font(500), color: colors.text, lineHeight: 23 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    backgroundColor: TILES.green,
    borderRadius: 22,
    borderEndEndRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  userText: { fontSize: 16, ...font(400), color: colors.text, lineHeight: 23 },

  undoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: 100,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: spacing.sm,
  },
  undoText: { fontSize: 14, ...font(600), color: colors.text, flexShrink: 1 },

  stage: { alignItems: 'center', paddingBottom: spacing.lg, gap: 6 },
  orbGlow: {
    shadowColor: '#14150F',
    shadowOpacity: 0.25,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
    borderRadius: 80,
  },
  orb: {
    width: 148,
    height: 148,
    borderRadius: 80,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: { marginTop: spacing.md, fontSize: 17, ...font(600), color: colors.text },
  hint: { fontSize: 14, ...font(400), color: colors.textMuted, textAlign: 'center' },
  restartBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 100,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  restartText: { fontSize: 15, ...font(600), color: colors.primary },
});
