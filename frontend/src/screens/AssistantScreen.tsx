import { useEffect, useMemo, useRef, useState } from 'react';
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
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path } from 'react-native-svg';
import { X, Mic, Undo2, RotateCcw, Send, Sparkles, CheckCheck } from 'lucide-react-native';

import { api } from '../lib/api';
import { useVoiceSession, type Line } from '../lib/useVoiceSession';
import type { RootStackParamList } from '../navigation';
import { spacing, font, VOICE } from '../theme';
import { t, locale, alignStart, isRTL } from '../lib/i18n';

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

/** The clock under a bubble. */
function stamp(at: number): string {
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(
    new Date(at),
  );
}

/**
 * Her answer, with the times in it set in bold.
 *
 * She is asked things like "how long until the meeting", and the answer is one
 * clock time buried in a sentence. Weighting it is the difference between
 * reading the reply and glancing at it. Only `HH:MM` is matched — a bare number
 * could be anything, and bolding "2" in "2 hours" would be noise.
 */
function Said({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const parts = useMemo(() => text.split(/(\d{1,2}:\d{2})/g), [text]);
  if (parts.length === 1) return <Text style={style}>{text}</Text>;
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        /^\d{1,2}:\d{2}$/.test(part) ? (
          <Text key={i} style={styles.saidStrong}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

// ── The sound of her listening ──────────────────────────────────────────────

/** One line of the waveform: a sine, fattest at the middle, gone at the edges. */
function wavePath(width: number, height: number, freq: number, amp: number, phase: number) {
  const mid = height / 2;
  const out: string[] = [];
  for (let x = 0; x <= width; x += 5) {
    const nx = (x - width / 2) / (width * 0.3);
    // A Gaussian envelope, so the sound appears to come out from behind the
    // orb rather than running edge to edge like a ruled line.
    const envelope = Math.exp(-nx * nx);
    const y = mid + Math.sin(x / freq + phase) * amp * envelope;
    out.push(`${x === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return out.join(' ');
}

const WAVE_HEIGHT = 190;

/** The layers, near ones first. Near follows the mic; far only breathes. */
const NEAR_LAYERS = [
  { freq: 26, amp: 34, phase: 0, opacity: 0.55, width: 1.6 },
  { freq: 17, amp: 24, phase: 1.1, opacity: 0.38, width: 1.2 },
  { freq: 35, amp: 46, phase: 2.2, opacity: 0.24, width: 1.1 },
];
const FAR_LAYERS = [
  { freq: 12, amp: 15, phase: 0.6, opacity: 0.22, width: 1 },
  { freq: 46, amp: 58, phase: 3.4, opacity: 0.13, width: 1 },
];

/**
 * The band of sound behind the orb.
 *
 * Two stacked groups rather than one, each scaled vertically on its own: the
 * near lines answer the microphone, the far ones only breathe. Moved as a
 * single slab it reads as a picture being stretched; at two rates it reads as
 * sound. Nothing here recomputes a path per frame — the amplitude is a native
 * transform, so this stays free while she is listening.
 */
function Waveform({ near, far, width }: { near: Animated.AnimatedInterpolation<number>; far: Animated.AnimatedInterpolation<number>; width: number }) {
  const paths = useMemo(
    () => ({
      near: NEAR_LAYERS.map((l) => ({ ...l, d: wavePath(width, WAVE_HEIGHT, l.freq, l.amp, l.phase) })),
      far: FAR_LAYERS.map((l) => ({ ...l, d: wavePath(width, WAVE_HEIGHT, l.freq, l.amp, l.phase) })),
    }),
    [width],
  );

  const group = (
    layers: typeof paths.near,
    scale: Animated.AnimatedInterpolation<number>,
    key: string,
  ) => (
    <Animated.View
      key={key}
      pointerEvents="none"
      style={[styles.waveLayer, { transform: [{ scaleY: scale }] }]}
    >
      <Svg width={width} height={WAVE_HEIGHT}>
        {layers.map((l) => (
          <Path
            key={l.d.length + l.freq}
            d={l.d}
            stroke={VOICE.wave}
            strokeOpacity={l.opacity}
            strokeWidth={l.width}
            fill="none"
          />
        ))}
      </Svg>
    </Animated.View>
  );

  return (
    <View pointerEvents="none" style={[styles.wave, { width, height: WAVE_HEIGHT }]}>
      {group(paths.far, far, 'far')}
      {group(paths.near, near, 'near')}
    </View>
  );
}

const ORBIT_BOX = 258;
const ORBIT_R = 104;

/** The dotted ring around the orb, and the motes riding it. */
function Orbit({ spin }: { spin: Animated.AnimatedInterpolation<string> }) {
  const motes = useMemo(
    () =>
      [0.1, 0.32, 0.55, 0.78, 0.93].map((turn) => {
        const angle = turn * Math.PI * 2;
        return {
          cx: ORBIT_BOX / 2 + Math.cos(angle) * (ORBIT_R + 16),
          cy: ORBIT_BOX / 2 + Math.sin(angle) * (ORBIT_R + 16),
          r: 1.6 + (turn % 0.3) * 6,
        };
      }),
    [],
  );

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.orbit, { transform: [{ rotate: spin }] }]}
    >
      <Svg width={ORBIT_BOX} height={ORBIT_BOX}>
        <Circle
          cx={ORBIT_BOX / 2}
          cy={ORBIT_BOX / 2}
          r={ORBIT_R}
          stroke={VOICE.orbit}
          strokeWidth={1.5}
          strokeDasharray="1.5 10"
          strokeLinecap="round"
          fill="none"
        />
        {motes.map((m, i) => (
          <Circle key={i} cx={m.cx} cy={m.cy} r={m.r} fill={VOICE.orbit} />
        ))}
      </Svg>
    </Animated.View>
  );
}

/**
 * The assistant, out loud.
 *
 * She opens the conversation, listens, does what she is asked, and answers.
 * The one control that matters is the orb: tap it to say you are finished
 * talking, or to cut in while she is speaking. Typing is there for a noisy
 * room, not as the way in.
 */
export default function AssistantScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
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

  const {
    state, lines, level, error, undoable,
    toggle, send, chooseTime, undoLast, startOver, restart, end,
  } =
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
  const spin = useRef(new Animated.Value(0)).current;

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

  // The ring turns once every twenty seconds — slow enough that you notice it
  // has moved rather than watching it move.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 20_000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

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

  const orbScale = Animated.add<number>(
    breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }),
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.16] }),
  );
  const haloScale = Animated.add<number>(
    breath.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1.08] }),
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.22] }),
  );
  const nearWave = Animated.add<number>(
    breath.interpolate({ inputRange: [0, 1], outputRange: [0.34, 0.46] }),
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 1.05] }),
  );
  const farWave = breath.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0.9] });
  const turn = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const deleted = undoable.filter((c) => c.destructive);

  // Who sits where is physical, not logical: outgoing on the right and hers on
  // the left is the shape of every chat, and mirroring it in Hebrew makes the
  // thread read as though the two of you had swapped sides.
  const rtl = isRTL();
  const mine = rtl ? ('flex-start' as const) : ('flex-end' as const);
  const hers = rtl ? ('flex-end' as const) : ('flex-start' as const);
  const herRow = rtl ? ('row-reverse' as const) : ('row' as const);
  const start = { textAlign: alignStart() } as const;

  /** The clock, and — on your own lines — the two ticks that say it landed. */
  const meta = (line: Line) =>
    line.at ? (
      <View style={styles.metaRow}>
        <Text style={styles.metaTime}>{stamp(line.at)}</Text>
        {line.role === 'user' ? (
          <CheckCheck color={VOICE.accent} size={14} strokeWidth={2.6} />
        ) : null}
      </View>
    ) : null;

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, spacing.md) + spacing.xs,
          paddingBottom: Math.max(insets.bottom, spacing.md),
          direction: rtl ? 'rtl' : 'ltr',
        },
      ]}
    >
      <LinearGradient colors={VOICE.page} style={StyleSheet.absoluteFill} />

      <View style={styles.headerRow}>
        <Pressable
          onPress={close}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <X color={VOICE.ink} size={22} strokeWidth={2.2} />
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
          <RotateCcw color={VOICE.ink} size={19} strokeWidth={2.2} />
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
              <View key={line.id} style={[styles.imageBubble, { alignSelf: hers }]}>
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
              <View
                key={line.id}
                style={[styles.herRow, { alignSelf: hers, flexDirection: herRow }]}
              >
                <View style={styles.spark}>
                  <Sparkles color={VOICE.accent} size={17} strokeWidth={2.2} />
                </View>
                <View style={[styles.herBubble, styles.drawingBubble]}>
                  <ActivityIndicator size="small" color={VOICE.accent} />
                  <Text style={styles.herText}>{t('voice.drawing')}</Text>
                </View>
              </View>
            );
          }

          const offer = line.offer;
          const showOffer = offer && offer.options.length > 0;

          if (line.role === 'user') {
            return (
              <View key={line.id} style={[styles.meBubble, { alignSelf: mine }]}>
                <Text style={[styles.meText, start]}>{line.text}</Text>
                {meta(line)}
              </View>
            );
          }

          return (
            <View
              key={line.id}
              style={[
                styles.herRow,
                { alignSelf: hers, flexDirection: herRow },
                showOffer && styles.herRowWide,
              ]}
            >
              <View style={styles.spark}>
                <Sparkles color={VOICE.accent} size={17} strokeWidth={2.2} />
              </View>
              <View style={[styles.herBubble, showOffer && styles.herBubbleWide]}>
                {line.text ? <Said text={line.text} style={[styles.herText, start]} /> : null}

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

                {meta(line)}
              </View>
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
          <Undo2 color={VOICE.accent} size={16} strokeWidth={2.4} />
          <Text style={styles.undoText} numberOfLines={1}>
            {t('voice.undo')} · {deleted.map((c) => c.title).join(', ')}
          </Text>
        </Pressable>
      ) : null}

      {/* ── The orb, in its own weather ── */}
      <View style={styles.stage}>
        <Waveform near={nearWave} far={farWave} width={width} />
        <Orbit spin={turn} />

        {VOICE.halo.map((tint, i) => (
          <Animated.View
            key={tint}
            pointerEvents="none"
            style={[
              styles.halo,
              {
                width: 230 - i * 34,
                height: 230 - i * 34,
                borderRadius: (230 - i * 34) / 2,
                backgroundColor: tint,
                transform: [{ scale: haloScale }],
              },
            ]}
          />
        ))}

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
              <Mic color={VOICE.accent} size={44} strokeWidth={2.1} />
            </View>
          </Animated.View>
        </Pressable>
      </View>

      <Text style={styles.caption}>{caption}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}

      {/* Talking is the point, but typing has to be there too — for a noisy
          room, a long title, or a name she keeps mishearing. Same thread. */}
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t('assistant.placeholder')}
          placeholderTextColor={VOICE.meta}
          style={[styles.composerInput, start]}
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
          <Send
            color={draft.trim() ? '#FFFFFF' : VOICE.accent}
            size={18}
            strokeWidth={2.2}
            // The plane points along the line of writing, whichever way that runs.
            style={rtl ? styles.sendGlyphRTL : undefined}
          />
        </Pressable>
      </View>

      {state === 'stopped' ? (
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            // Restarts the loop in place. This used to remount the screen,
            // which threw away the thread on screen and was the same motion
            // the user was already making by hand — leaving and coming back.
            restart();
          }}
          style={styles.restartBtn}
        >
          <Text style={styles.restartText}>{t('voice.restart')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The page's own margin. The waveform is the one thing allowed past it. */
const GUTTER = spacing.md + 4;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: VOICE.page[0] },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    marginBottom: spacing.xs,
  },
  iconBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: VOICE.chrome,
    shadowColor: '#3A2A6B',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  title: { fontSize: 23, ...font(700), color: VOICE.ink, letterSpacing: -0.3 },

  transcript: { flex: 1 },
  transcriptContent: { paddingHorizontal: GUTTER, paddingVertical: spacing.md, gap: 12 },

  // ── What she said ──
  herRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, maxWidth: '92%' },
  /** An offer needs the full column: four rows want one shared edge. */
  herRowWide: { width: '92%' },
  spark: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: VOICE.chrome,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3A2A6B',
    shadowOpacity: 0.09,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  herBubble: {
    flexShrink: 1,
    backgroundColor: VOICE.her,
    borderRadius: 24,
    borderBottomLeftRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  herBubbleWide: { flex: 1 },
  herText: { fontSize: 16, ...font(500), color: VOICE.ink, lineHeight: 24 },
  saidStrong: { ...font(700) },
  drawingBubble: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  // ── What you said ──
  meBubble: {
    maxWidth: '86%',
    backgroundColor: VOICE.me,
    borderRadius: 24,
    borderBottomRightRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: '#3A2A6B',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  meText: { fontSize: 16, ...font(500), color: VOICE.ink, lineHeight: 24 },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 4,
    marginTop: 4,
  },
  metaTime: { fontSize: 11, ...font(500), color: VOICE.meta, letterSpacing: 0.2 },

  imageBubble: {
    maxWidth: '88%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: VOICE.her,
  },
  // Square, because that is the shape asked for unless the user says otherwise,
  // and a fixed aspect keeps the thread from jumping as pictures load.
  image: { width: 240, aspectRatio: 1 },

  // ── Times to choose from ──
  offerStack: { gap: 8, alignSelf: 'stretch' },
  offerStackSpaced: { marginTop: 10 },
  offerRow: {
    height: 52,
    borderRadius: 16,
    backgroundColor: VOICE.chrome,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 10,
  },
  offerRowPressed: { opacity: 0.72 },
  offerRowTaken: { backgroundColor: VOICE.accent },
  offerRowSpent: { opacity: 0.4 },
  offerTime: {
    fontSize: 20,
    ...font(700),
    color: VOICE.ink,
    letterSpacing: -0.3,
    flexShrink: 0,
  },
  offerTimeTaken: { color: '#FFFFFF' },
  offerWhen: { flex: 1, fontSize: 14, ...font(600), color: VOICE.accent, textAlign: 'right' },
  offerWhenTaken: { color: 'rgba(255,255,255,0.78)' },

  undoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    backgroundColor: VOICE.chrome,
    borderRadius: 100,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: spacing.sm,
    shadowColor: '#3A2A6B',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  undoText: { fontSize: 14, ...font(600), color: VOICE.ink, flexShrink: 1 },

  // ── The orb ──
  stage: { height: 258, alignItems: 'center', justifyContent: 'center' },
  wave: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  waveLayer: { position: 'absolute' },
  orbit: { position: 'absolute', width: ORBIT_BOX, height: ORBIT_BOX, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute' },
  orbGlow: {
    // Her own light, in her own colour — the glow is the thing that says she
    // is awake, so it is a violet cast rather than the grey a neutral shadow
    // would put under the orb.
    shadowColor: VOICE.accent,
    shadowOpacity: 0.42,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
    borderRadius: 66,
  },
  orb: {
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },

  caption: { marginTop: spacing.sm, fontSize: 17, ...font(700), color: VOICE.ink, textAlign: 'center' },
  hint: { fontSize: 14, ...font(500), color: VOICE.meta, textAlign: 'center', marginTop: 2 },

  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: GUTTER,
    marginTop: spacing.md,
    backgroundColor: VOICE.chrome,
    borderRadius: 100,
    padding: 6,
    shadowColor: '#3A2A6B',
    shadowOpacity: 0.09,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  composerInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    ...font(500),
    color: VOICE.ink,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: VOICE.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Nothing to send yet: the tint of the button rather than a greyed copy. */
  sendBtnIdle: { backgroundColor: VOICE.her },
  sendGlyphRTL: { transform: [{ scaleX: -1 }] },

  restartBtn: {
    alignSelf: 'center',
    marginTop: spacing.sm,
    backgroundColor: VOICE.chrome,
    borderRadius: 100,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  restartText: { fontSize: 15, ...font(700), color: VOICE.accent },
});
