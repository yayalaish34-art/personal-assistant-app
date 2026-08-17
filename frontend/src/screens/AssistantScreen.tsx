import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  StyleSheet,
  Animated,
  Easing,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { X, Mic, Undo2, RotateCcw, Send } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api } from '../lib/api';
import { useVoiceSession } from '../lib/useVoiceSession';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, TILES, TILE_INK } from '../theme';
import { t, locale, alignStart } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Assistant'>;

const MINUTE = 60_000;

/**
 * "09:30–10:30". The range rather than a single time, so a tile answers "does
 * it fit" without a duration label beside it.
 *
 * Wrapped in isolates: a clock range is left-to-right whatever the paragraph
 * around it is doing, and without them the two halves swap in Hebrew.
 */
function clockRange(iso: string, durationMinutes: number): string {
  const fmt = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' });
  const start = new Date(iso);
  const end = new Date(start.getTime() + durationMinutes * MINUTE);
  return `⁦${fmt.format(start)}–${fmt.format(end)}⁩`;
}

/**
 * Which day it lands on, in the reader's own language.
 *
 * Today needs no label — the time alone is unambiguous — but the column would
 * go ragged without one, so it takes the weekday like the rest. Everything is
 * formatted by Intl rather than translated by hand: seven languages of
 * "tomorrow evening" is seven chances to get it wrong.
 */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.round(
    (new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000,
  );
  return days < 7
    ? d.toLocaleDateString(locale(), { weekday: 'long' })
    : d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
}

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

  const { state, lines, level, error, undoable, toggle, send, chooseTime, undoLast, startOver, end } =
    useVoiceSession({ userName: name || undefined });
  const [draft, setDraft] = useState('');

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    send(text);
  };

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
        {/* The thread carries across visits, so there has to be a way to drop
            it and begin again. */}
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            startOver();
            navigation.replace('Assistant');
          }}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={t('voice.newChat')}
        >
          <RotateCcw color={colors.text} size={19} />
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        showsVerticalScrollIndicator={false}
      >
        {lines.map((line) => {
          // A picture is its own bubble: the frame is the message, so the
          // padding and the background that carry text would only box it in.
          if (line.imageUri) {
            return (
              <View key={line.id} style={styles.imageBubble}>
                <Image
                  source={{ uri: line.imageUri }}
                  style={styles.image}
                  resizeMode="cover"
                  accessibilityRole="image"
                  accessibilityLabel={t('voice.drawing')}
                />
              </View>
            );
          }

          if (line.drawing) {
            return (
              <View key={line.id} style={[styles.herBubble, styles.drawingBubble]}>
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.herText}>{t('voice.drawing')}</Text>
              </View>
            );
          }

          const offer = line.offer;
          const showOffer = offer && offer.options.length > 0;

          return (
            <View
              key={line.id}
              style={[
                line.role === 'user' ? styles.userBubble : styles.herBubble,
                showOffer && styles.offerBubble,
              ]}
            >
              {line.text ? (
                <Text style={line.role === 'user' ? styles.userText : styles.herText}>
                  {line.text}
                </Text>
              ) : null}

              {/* The times sit inside her own bubble rather than in a card of
                  their own: this is the end of what she said, not a form the
                  app put in the way. */}
              {showOffer ? (
                <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
                  {offer.options.map((iso) => {
                    const taken = line.chosen === iso;
                    const spent = Boolean(line.chosen) && !taken;
                    return (
                      <Pressable
                        key={iso}
                        onPress={() => chooseTime(line.id, iso)}
                        disabled={Boolean(line.chosen)}
                        style={({ pressed }) => [
                          styles.offerRow,
                          taken && styles.offerRowTaken,
                          spent && styles.offerRowSpent,
                          pressed && styles.offerRowPressed,
                        ]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: taken, disabled: Boolean(line.chosen) }}
                        accessibilityLabel={`${offer.title} — ${clockRange(iso, offer.durationMinutes)}, ${whenLabel(iso)}`}
                      >
                        <Text
                          style={[styles.offerTime, taken && styles.offerTimeTaken]}
                          numberOfLines={1}
                        >
                          {clockRange(iso, offer.durationMinutes)}
                        </Text>
                        <Text
                          style={[styles.offerWhen, taken && styles.offerWhenTaken]}
                          numberOfLines={1}
                        >
                          {whenLabel(iso)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          );
        })}
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

        {/* Talking is the point, but typing has to be there too — for a noisy
            room, a long title, or a name she keeps mishearing. Same thread. */}
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('assistant.placeholder')}
            placeholderTextColor={colors.textMuted}
            style={styles.composerInput}
            returnKeyType="send"
            onSubmitEditing={submitDraft}
            editable={state !== 'unavailable' || error === 'microphone'}
          />
          <Pressable
            onPress={submitDraft}
            disabled={!draft.trim()}
            style={[styles.sendBtn, !draft.trim() && styles.sendBtnIdle]}
            accessibilityRole="button"
            accessibilityLabel={t('assistant.send')}
          >
            <Send color={colors.primaryText} size={18} />
          </Pressable>
        </View>

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
  // Fixed rather than max width, so every offer lines up under a short
  // sentence and the four rows share one edge.
  offerBubble: { width: '88%' },
  offerStack: { gap: 8, alignSelf: 'stretch' },
  offerStackSpaced: { marginTop: 10 },
  offerRow: {
    height: 52,
    borderRadius: 14,
    backgroundColor: TILES.blue,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 10,
  },
  offerRowPressed: { opacity: 0.72 },
  // Near-black is already this app's "selected"; a faded pastel reads as broken.
  offerRowTaken: { backgroundColor: colors.primary },
  offerRowSpent: { opacity: 0.4 },
  offerTime: {
    fontSize: 20,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.3,
    flexShrink: 0,
  },
  offerTimeTaken: { color: colors.primaryText },
  offerWhen: { flex: 1, fontSize: 14, ...font(600), color: TILE_INK.blue, textAlign: 'right' },
  offerWhenTaken: { color: 'rgba(255,255,255,0.75)' },

  imageBubble: {
    alignSelf: 'flex-start',
    maxWidth: '88%',
    borderRadius: 22,
    borderStartStartRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
  },
  // Square, because that is the shape asked for unless the user says otherwise,
  // and a fixed aspect keeps the thread from jumping as pictures load.
  image: { width: 240, aspectRatio: 1 },
  drawingBubble: { flexDirection: 'row', alignItems: 'center', gap: 10 },

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
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'stretch',
    marginTop: spacing.md,
  },
  composerInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 100,
    paddingHorizontal: 18,
    paddingVertical: 14,
    fontSize: 15,
    ...font(400),
    color: colors.text,
  },
  sendBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnIdle: { opacity: 0.35 },
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
