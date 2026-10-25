import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  View,
  Text,
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
import { Entrance, PopIn, Pressable, animateLayout } from '../components/motion';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path } from 'react-native-svg';
import { X, Mic, Undo2, RotateCcw, Send, Sparkles, CheckCheck, Check, Clock, ArrowUpRight, ArrowDownLeft, Sun, Cloud, CloudRain, CloudLightning, Snowflake, CloudSun, Wind, CloudFog, TrendingUp, TrendingDown, Minus, Star, CalendarDays, ListTodo, ShoppingCart, Wallet, MapPin, Navigation, CalendarClock } from 'lucide-react-native';

import { Glow, LitDisc } from '../components/ui';
import { api } from '../lib/api';
import { useVoiceSession, type Line } from '../lib/useVoiceSession';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, NIGHT, VOICE, themed } from '../theme';
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

// ── Lines arriving ──────────────────────────────────────────────────────────

/** The beat between lines that land together, like a thread restored on open. */
const ARRIVAL_STEP_MS = 60;
/**
 * How many lines of a batch take a beat each. The thread scrolls to its end,
 * so these are the ones in view; the rest land at once above them, out of
 * sight, rather than holding the newest back for a second or more.
 */
const ARRIVAL_STAGGERED = 6;

/**
 * A line of the thread, rising in as it is added.
 *
 * Keyed by the line's id where it is used, so it mounts once per line: a time
 * being taken, a drawing turning into its picture, the screen re-rendering
 * several times a second while she listens — none of that plays it again.
 *
 * The delay is kept from the first render. The screen passes a fresh one every
 * render, and a delay that changed under a running spring would stop it and
 * start it over.
 */
function Arrival({ delay, children }: { delay: number; children: ReactNode }) {
  const [wait] = useState(delay);
  return (
    <Entrance delay={wait} from={16}>
      {children}
    </Entrance>
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

const WAVE_HEIGHT = 120;

/** The layers, near ones first. Near follows the mic; far only breathes. */
const NEAR_LAYERS = [
  { freq: 26, amp: 22, phase: 0, opacity: 0.55, width: 1.6 },
  { freq: 17, amp: 16, phase: 1.1, opacity: 0.38, width: 1.2 },
  { freq: 35, amp: 28, phase: 2.2, opacity: 0.24, width: 1.1 },
];
const FAR_LAYERS = [
  { freq: 12, amp: 10, phase: 0.6, opacity: 0.22, width: 1 },
  { freq: 46, amp: 34, phase: 3.4, opacity: 0.13, width: 1 },
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

const ORBIT_BOX = 172;
const ORBIT_R = 70;

/** The dotted ring around the orb, and the motes riding it. */
function Orbit({ spin }: { spin: Animated.AnimatedInterpolation<string> }) {
  const motes = useMemo(
    () =>
      [0.1, 0.32, 0.55, 0.78, 0.93].map((turn) => {
        const angle = turn * Math.PI * 2;
        return {
          cx: ORBIT_BOX / 2 + Math.cos(angle) * (ORBIT_R + 10),
          cy: ORBIT_BOX / 2 + Math.sin(angle) * (ORBIT_R + 10),
          r: 1.4 + (turn % 0.3) * 4,
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
    toggle, send, chooseTime, chooseCard, checkItem, settleDebt, undoLast, startOver, restart, end,
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

  // The lines already on screen. Anything not in here is arriving in this
  // render; it is recorded once it has been committed, so a render that is
  // thrown away does not count a line as seen.
  const shown = useRef(new Set<string>());
  useEffect(() => {
    lines.forEach((l) => shown.current.add(l.id));
  }, [lines]);
  const arriving = lines.reduce((n, l) => (shown.current.has(l.id) ? n : n + 1), 0);
  let nth = 0;
  /** A line's wait: its place among the last few of the lines landing with it. */
  const arrivalDelay = (id: string) => {
    if (shown.current.has(id)) return 0;
    const i = nth++;
    return Math.max(0, i - Math.max(0, arriving - ARRIVAL_STAGGERED)) * ARRIVAL_STEP_MS;
  };

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

  const weatherIcon = (icon: string, size = 20) => {
    const c = VOICE.accent;
    switch (icon) {
      case 'sun': return <Sun color={c} size={size} />;
      case 'cloud': return <Cloud color={c} size={size} />;
      case 'rain': return <CloudRain color={c} size={size} />;
      case 'storm': return <CloudLightning color={c} size={size} />;
      case 'snow': return <Snowflake color={c} size={size} />;
      case 'partly_cloudy': return <CloudSun color={c} size={size} />;
      case 'wind': return <Wind color={c} size={size} />;
      case 'fog': return <CloudFog color={c} size={size} />;
      default: return <Sun color={c} size={size} />;
    }
  };

  const trendIcon = (trend?: string) => {
    const size = 14;
    switch (trend) {
      case 'up': return <TrendingUp color="#4ade80" size={size} />;
      case 'down': return <TrendingDown color="#f87171" size={size} />;
      default: return <Minus color={VOICE.meta} size={size} />;
    }
  };

  /**
   * The clock, and — on your own lines — the two ticks that say it landed.
   *
   * On your blue both are plain white. Size already says the clock is the
   * lesser line, and anything dimmer than white falls under 4.5:1 there.
   */
  const meta = (line: Line) => {
    if (!line.at) return null;
    const own = line.role === 'user';
    return (
      <View style={styles.metaRow}>
        <Text style={[styles.metaTime, own && styles.metaTimeOwn]}>{stamp(line.at)}</Text>
        {own ? <CheckCheck color={colors.primaryText} size={14} strokeWidth={2.6} /> : null}
      </View>
    );
  };

  /**
   * Her mark beside a line. It pops as the line rises, so each thing she says
   * is visibly signed as it lands rather than arriving already stamped.
   */
  const spark = (
    <PopIn from={0.5}>
      <LitDisc colors={VOICE.accentGradient} style={styles.spark}>
        <Sparkles color={NIGHT.glyph} size={17} strokeWidth={2.2} />
      </LitDisc>
    </PopIn>
  );

  /** One line of the thread, without its arrival. */
  const bubble = (line: Line) => {
    // A picture is its own bubble: the frame is the message, so the
    // padding and the background that carry text would only box it in.
    // It springs in where the placeholder was: the line has long since
    // arrived, and the picture turning up is the news.
    if (line.imageUri) {
      return (
        <PopIn from={0.9} style={[styles.imageBubble, { alignSelf: hers }]}>
          <Image
            source={{ uri: line.imageUri }}
            style={styles.image}
            resizeMode="cover"
            accessibilityRole="image"
            accessibilityLabel={t('voice.drawing')}
          />
        </PopIn>
      );
    }

    if (line.drawing) {
      return (
        <View style={[styles.herRow, { alignSelf: hers, flexDirection: herRow }]}>
          {spark}
          <View style={[styles.herBubble, styles.drawingBubble]}>
            <ActivityIndicator size="small" color={VOICE.accent} />
            <Text style={styles.herText}>{t('voice.drawing')}</Text>
          </View>
        </View>
      );
    }

    const offer = line.offer;
    const showOffer = offer && offer.options.length > 0;
    const showCards = line.cards && line.cards.items.length > 0;
    const hasVisual = showOffer || showCards || line.checklist || line.confirmation || line.budget || line.timeline || line.debtSummary || line.weather || line.summary;

    if (line.role === 'user') {
      return (
        <View style={[styles.meBubble, { alignSelf: mine }]}>
          <Text style={[styles.meText, start]}>{line.text}</Text>
          {meta(line)}
        </View>
      );
    }

    return (
      <View
        style={[
          styles.herRow,
          { alignSelf: hers, flexDirection: herRow },
          hasVisual && styles.herRowWide,
        ]}
      >
        {spark}
        <View style={[styles.herBubble, hasVisual && styles.herBubbleWide]}>
          {line.text ? <Said text={line.text} style={[styles.herText, start]} /> : null}

          {showOffer ? (
            <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
              {offer.options.map((iso, i) => {
                const taken = line.chosen === iso;
                const spent = Boolean(line.chosen) && !taken;
                return (
                  <Entrance key={iso} delay={140 + i * 45} from={12}>
                    <Pressable
                      onPress={() => chooseTime(line.id, iso)}
                      disabled={Boolean(line.chosen)}
                      style={({ pressed }) => [
                        styles.offerRow,
                        spent && styles.offerRowSpent,
                        pressed && styles.offerRowPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: taken, disabled: Boolean(line.chosen) }}
                      accessibilityLabel={`${offer.title} — ${clockRange(iso, offer.durationMinutes)}, ${whenLabel(iso)}`}
                    >
                      {taken ? <PopIn from={0.9} style={[StyleSheet.absoluteFill, styles.offerTakenFill]} /> : null}
                      <Text
                        style={[styles.offerTime, taken && styles.offerTimeTaken]}
                        numberOfLines={1}
                      >
                        {clockRange(iso, offer.durationMinutes)}
                      </Text>
                      <Text
                        style={[
                          styles.offerWhen,
                          { textAlign: rtl ? 'left' : 'right' },
                          taken && styles.offerWhenTaken,
                        ]}
                        numberOfLines={1}
                      >
                        {whenLabel(iso)}
                      </Text>
                    </Pressable>
                  </Entrance>
                );
              })}
            </View>
          ) : null}

          {showCards ? (
            <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
              {line.cards!.title ? (
                <Text style={[styles.cardTitle, start]}>{line.cards!.title}</Text>
              ) : null}
              {line.cards!.items.map((card, i) => {
                const taken = line.chosenCard === card.label;
                const spent = Boolean(line.chosenCard) && !taken;
                const selectable = line.cards!.selectable;
                return (
                  <Entrance key={card.label} delay={140 + i * 55} from={12}>
                    <Pressable
                      onPress={() => selectable && chooseCard(line.id, card.label)}
                      disabled={!selectable || Boolean(line.chosenCard)}
                      style={({ pressed }) => [
                        styles.cardRow,
                        spent && styles.offerRowSpent,
                        pressed && selectable && styles.offerRowPressed,
                      ]}
                      accessibilityRole={selectable ? 'button' : 'text'}
                      accessibilityState={selectable ? { selected: taken, disabled: Boolean(line.chosenCard) } : undefined}
                      accessibilityLabel={card.detail ? `${card.label}: ${card.detail}` : card.label}
                    >
                      {taken ? <PopIn from={0.9} style={[StyleSheet.absoluteFill, styles.cardTakenFill]} /> : null}
                      <Text
                        style={[styles.cardLabel, start, taken && styles.offerTimeTaken]}
                        numberOfLines={2}
                      >
                        {card.label}
                      </Text>
                      {card.detail ? (
                        <Text
                          style={[styles.cardDetail, start, taken && styles.cardDetailTaken]}
                          numberOfLines={3}
                        >
                          {card.detail}
                        </Text>
                      ) : null}
                    </Pressable>
                  </Entrance>
                );
              })}
            </View>
          ) : null}

          {line.checklist ? (
            <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
              {line.checklist.title ? (
                <Text style={[styles.cardTitle, start]}>{line.checklist.title}</Text>
              ) : null}
              {line.checklist.items.map((item, i) => (
                <Entrance key={item.id} delay={140 + i * 40} from={12}>
                  <Pressable
                    onPress={() => !item.checked && checkItem(line.id, item.id)}
                    disabled={item.checked}
                    style={({ pressed }) => [
                      styles.checkRow,
                      pressed && !item.checked && styles.offerRowPressed,
                    ]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: item.checked }}
                    accessibilityLabel={item.label}
                  >
                    <View style={[styles.checkBox, item.checked && styles.checkBoxDone]}>
                      {item.checked ? <Check color={VOICE.ink} size={14} strokeWidth={2.5} /> : null}
                    </View>
                    <View style={styles.checkContent}>
                      <Text
                        style={[styles.cardLabel, start, item.checked && styles.checkLabelDone]}
                        numberOfLines={2}
                      >
                        {item.label}
                      </Text>
                      {item.detail ? (
                        <Text style={[styles.cardDetail, start]} numberOfLines={1}>
                          {item.detail}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                </Entrance>
              ))}
            </View>
          ) : null}

          {line.confirmation ? (
            <Entrance delay={100} from={12}>
              <View style={[styles.confirmCard, line.text ? styles.offerStackSpaced : null]}>
                <View style={styles.confirmHeader}>
                  <View style={styles.confirmIcon}>
                    <Check color={VOICE.ink} size={16} strokeWidth={2.5} />
                  </View>
                  <Text style={[styles.confirmTitle, start]}>{line.confirmation.title}</Text>
                </View>
                {line.confirmation.fields.map((f) => (
                  <View key={f.label} style={styles.confirmField}>
                    <Text style={[styles.confirmFieldLabel, start]}>{f.label}</Text>
                    <Text style={[styles.confirmFieldValue, start]}>{f.value}</Text>
                  </View>
                ))}
              </View>
            </Entrance>
          ) : null}

          {line.budget ? (
            <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
              {line.budget.title ? (
                <Text style={[styles.cardTitle, start]}>{line.budget.title}</Text>
              ) : null}
              {line.budget.categories.map((cat, i) => {
                const pct = Math.min(cat.spent / cat.limit, 1);
                const over = cat.spent > cat.limit;
                return (
                  <Entrance key={cat.name} delay={140 + i * 50} from={12}>
                    <View style={styles.budgetRow}>
                      <View style={styles.budgetHeader}>
                        <Text style={[styles.budgetCat, start]} numberOfLines={1}>{cat.name}</Text>
                        <Text style={[styles.budgetAmounts, over && styles.budgetOver]}>
                          {Math.round(cat.spent)} / {Math.round(cat.limit)}
                        </Text>
                      </View>
                      <View style={styles.budgetTrack}>
                        <View
                          style={[
                            styles.budgetFill,
                            { width: `${pct * 100}%` },
                            over && styles.budgetFillOver,
                          ]}
                        />
                      </View>
                    </View>
                  </Entrance>
                );
              })}
            </View>
          ) : null}

          {line.timeline ? (
            <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
              {line.timeline.title ? (
                <Text style={[styles.cardTitle, start]}>{line.timeline.title}</Text>
              ) : null}
              {line.timeline.events.map((ev, i) => (
                <Entrance key={`${ev.start}-${i}`} delay={140 + i * 50} from={12}>
                  <View style={styles.timelineRow}>
                    <View style={styles.timelineDot} />
                    <Text style={styles.timelineTime}>{ev.start}{ev.end ? `–${ev.end}` : ''}</Text>
                    <Text style={[styles.timelineTitle, start]} numberOfLines={2}>{ev.title}</Text>
                  </View>
                </Entrance>
              ))}
            </View>
          ) : null}

          {line.debtSummary && line.debtSummary.debts.length > 0 ? (
            <View style={[styles.offerStack, line.text ? styles.offerStackSpaced : null]}>
              {line.debtSummary.title ? (
                <Text style={[styles.cardTitle, start]}>{line.debtSummary.title}</Text>
              ) : null}
              {line.debtSummary.debts.map((debt, i) => (
                <Entrance key={debt.id} delay={140 + i * 55} from={12}>
                  <View style={styles.debtRow}>
                    <View style={styles.debtInfo}>
                      <View style={styles.debtDirection}>
                        {debt.direction === 'owed' ? (
                          <ArrowDownLeft color={VOICE.accent} size={16} strokeWidth={2.2} />
                        ) : (
                          <ArrowUpRight color="#e67e73" size={16} strokeWidth={2.2} />
                        )}
                      </View>
                      <View style={styles.debtText}>
                        <Text style={[styles.cardLabel, start]} numberOfLines={1}>{debt.person}</Text>
                        <Text style={[styles.debtAmount, start]}>
                          {Math.round(debt.amount)}
                          {debt.description ? ` · ${debt.description}` : ''}
                        </Text>
                      </View>
                    </View>
                    <Pressable
                      onPress={() => settleDebt(line.id, debt.id)}
                      style={({ pressed }) => [styles.debtSettle, pressed && styles.offerRowPressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Settle ${debt.person}`}
                    >
                      <CheckCheck color={VOICE.accent} size={16} strokeWidth={2.2} />
                    </Pressable>
                  </View>
                </Entrance>
              ))}
            </View>
          ) : null}

          {line.weather && line.weather.days.length > 0 ? (
            <View style={[styles.visualBlock, line.text ? styles.offerStackSpaced : null]}>
              {line.weather.location ? (
                <Text style={[styles.cardTitle, start]}>{line.weather.location}</Text>
              ) : null}
              {line.weather.days.map((day, i) => (
                <Entrance key={day.day} delay={120 + i * 60} from={8}>
                  <View style={styles.weatherRow}>
                    {weatherIcon(day.icon, 24)}
                    <View style={styles.weatherInfo}>
                      <Text style={styles.weatherDay}>{day.day}</Text>
                      {day.description ? (
                        <Text style={styles.weatherDesc}>{day.description}</Text>
                      ) : null}
                    </View>
                    <Text style={styles.weatherTemp}>{Math.round(day.high)}° / {Math.round(day.low)}°</Text>
                  </View>
                </Entrance>
              ))}
            </View>
          ) : null}

          {line.summary ? (
            <View style={[styles.visualBlock, line.text ? styles.offerStackSpaced : null]}>
              <Text style={[styles.cardTitle, start]}>{line.summary.title}</Text>
              {line.summary.stats && line.summary.stats.length > 0 ? (
                <View style={styles.statsGrid}>
                  {line.summary.stats.map((s, i) => (
                    <Entrance key={s.label} delay={120 + i * 60} from={8}>
                      <View style={styles.statCard}>
                        <View style={styles.statHeader}>
                          <Text style={styles.statLabel}>{s.label}</Text>
                          {s.trend ? trendIcon(s.trend) : null}
                        </View>
                        <Text style={styles.statValue}>{s.value}</Text>
                      </View>
                    </Entrance>
                  ))}
                </View>
              ) : null}
              {line.summary.highlights && line.summary.highlights.length > 0 ? (
                <View style={styles.highlightList}>
                  {line.summary.highlights.map((h, i) => (
                    <Entrance key={i} delay={200 + i * 60} from={8}>
                      <View style={styles.highlightRow}>
                        <Star color={VOICE.accent} size={14} fill={VOICE.accent} />
                        <Text style={styles.highlightText}>{h}</Text>
                      </View>
                    </Entrance>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {line.quickActions ? (
            <View style={[styles.chipRow, line.text ? styles.offerStackSpaced : null]}>
              {line.quickActions.actions.map((a, i) => (
                <Entrance key={a.label} delay={200 + i * 60} from={8}>
                  <Pressable
                    onPress={() => send(a.label)}
                    style={({ pressed }) => [styles.chip, pressed && styles.offerRowPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={a.label}
                  >
                    <Text style={styles.chipText}>{a.label}</Text>
                  </Pressable>
                </Entrance>
              ))}
            </View>
          ) : null}

          {meta(line)}
        </View>
      </View>
    );
  };

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
      <Glow />

      {/* The page builds top to bottom as the sheet comes up: the header, the
          orb, what she is doing, the composer. Not with `PageReveal`, as the
          form has: that plays every entrance inside it again when the page
          comes back into view, and here that would be the whole thread. The
          lines rise in on their own, as they arrive. */}
      <Entrance delay={0} from={12} style={styles.headerRow}>
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
            it and begin again. No layout animation on the clear: the screen
            is replaced, and one configured here would also fade in every view
            of the new one under its own entrances. */}
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
      </Entrance>

      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        showsVerticalScrollIndicator={false}
      >
        {lines.length === 0 ? (
          <Entrance delay={180} from={14}>
            <Text style={styles.canDoTitle}>{t('voice.canDo')}</Text>
            <View style={styles.capGrid}>
              {([
                { key: 'schedule', Glyph: CalendarDays },
                { key: 'tasks', Glyph: ListTodo },
                { key: 'shopping', Glyph: ShoppingCart },
                { key: 'money', Glyph: Wallet },
                { key: 'nearby', Glyph: MapPin },
                { key: 'travel', Glyph: Navigation },
                { key: 'freeTime', Glyph: CalendarClock },
                { key: 'weather', Glyph: Sun },
              ] as const).map(({ key, Glyph }) => (
                <View key={key} style={styles.capChip}>
                  <Glyph color={VOICE.accent} size={16} strokeWidth={2} />
                  <Text style={styles.capText}>{t(`voice.cap.${key}`)}</Text>
                </View>
              ))}
            </View>
          </Entrance>
        ) : null}
        {lines.map((line) => (
          // Full width, so the bubble inside still sits to its side and its
          // percentage widths still measure the column.
          <Arrival key={line.id} delay={arrivalDelay(line.id)}>
            {bubble(line)}
          </Arrival>
        ))}
      </ScrollView>

      {deleted.length > 0 ? (
        <PopIn from={0.85}>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              // The bar goes, and the thread closes over the room it took.
              animateLayout();
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
        </PopIn>
      ) : null}

      {/* ── The orb, in its own weather ── */}
      <Entrance delay={70} from={20} style={styles.stage}>
        <Waveform near={nearWave} far={farWave} width={width} />
        <Orbit spin={turn} />

        {VOICE.halo.map((tint, i) => (
          <Animated.View
            key={tint}
            pointerEvents="none"
            style={[
              styles.halo,
              {
                width: 160 - i * 22,
                height: 160 - i * 22,
                borderRadius: (160 - i * 22) / 2,
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
            {/* The mic button from the bar, grown: the same sweep at the same
                angle, with the same dark ink on it. */}
            <LinearGradient
              colors={VOICE.accentGradient}
              start={{ x: 0.1, y: 0.1 }}
              end={{ x: 0.9, y: 0.95 }}
              style={styles.orb}
            >
              <Mic color={NIGHT.glyph} size={32} strokeWidth={2.2} />
            </LinearGradient>
          </Animated.View>
        </Pressable>
      </Entrance>

      <Entrance delay={105} from={14}>
        {/* Keyed by what it says, so a change of state rises in rather than
            swapping in place: the words move when she does. */}
        <Entrance key={caption} from={8}>
          <Text style={styles.caption}>{caption}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </Entrance>
      </Entrance>

      {/* Talking is the point, but typing has to be there too — for a noisy
          room, a long title, or a name she keeps mishearing. Same thread. */}
      <Entrance delay={140} from={16}>
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('assistant.placeholder')}
            placeholderTextColor={VOICE.meta}
            selectionColor={NIGHT.blue[0]}
            style={[styles.composerInput, start]}
            returnKeyType="send"
            onSubmitEditing={submitDraft}
            editable={state !== 'unavailable' || error === 'microphone'}
          />
          <Pressable
            onPress={submitDraft}
            disabled={!draft.trim()}
            style={styles.sendBtn}
            accessibilityRole="button"
            accessibilityLabel={t('assistant.send')}
          >
            {/* Lights up as the first letter goes in: the blue springs in under
                the plane rather than switching on. */}
            {draft.trim() ? <PopIn from={0.5} style={[StyleSheet.absoluteFill, styles.sendFill]} /> : null}
            {/* The plane points along the line of writing, whichever way that
                runs. The flip is on this View and not on the glyph itself: on
                web the transform lands on the <svg> element, whose origin is its
                top-left corner, and the plane flies out of the button. The View
                also keeps the plane over the fill there — a positioned fill
                paints over a bare svg that follows it. */}
            <View style={rtl ? styles.sendGlyphRTL : undefined}>
              <Send
                color={draft.trim() ? colors.primaryText : VOICE.accent}
                size={18}
                strokeWidth={2.2}
              />
            </View>
          </Pressable>
        </View>
      </Entrance>

      {state === 'stopped' ? (
        <PopIn from={0.8}>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              // The button goes and the page settles down over where it was.
              animateLayout();
              // Restarts the loop in place. This used to remount the screen,
              // which threw away the thread on screen and was the same motion
              // the user was already making by hand — leaving and coming back.
              restart();
            }}
            style={styles.restartBtn}
          >
            <Text style={styles.restartText}>{t('voice.restart')}</Text>
          </Pressable>
        </PopIn>
      ) : null}
    </View>
  );
}

/** The page's own margin. The waveform is the one thing allowed past it. */
const GUTTER = spacing.md + 4;

/**
 * The edge of a glass shape, as on Home. Glass takes no shadow — on the dark
 * there is nothing for one to fall on — so the hairline is what holds it.
 */
const edge = {
  borderWidth: StyleSheet.hairlineWidth,
  // A getter, so a sheet rebuilt for the other scheme reads the line in force.
  get borderColor() {
    return NIGHT.line;
  },
};

const styles = themed(() =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: VOICE.page[0] },

    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: GUTTER,
      marginBottom: spacing.xs,
    },
    /** The same glass disc as the bell on Home. */
    iconBtn: {
      ...edge,
      backgroundColor: VOICE.chrome,
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { fontSize: 23, ...font(700), color: VOICE.ink, letterSpacing: -0.3 },

    transcript: { flex: 1 },
    transcriptContent: { paddingHorizontal: GUTTER, paddingVertical: spacing.md, gap: 12 },

    // ── What she said ──
    herRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, maxWidth: '92%' },
    /** An offer needs the full column: four rows want one shared edge. */
    herRowWide: { width: '92%' },
    /**
     * Her mark beside each line: the orb in small, glowing the orb's blue rather
     * than the disc's own last stop, so every line of hers is signed by the thing
     * you talk to.
     */
    spark: { shadowColor: VOICE.accentGradient[1] },
    herBubble: {
      ...edge,
      backgroundColor: VOICE.her,
      flexShrink: 1,
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
    // The app's blue, flat rather than the lit gradient: white body text on the
    // gradient's top stop is under 3:1, and this is text you read, not a label.
    meBubble: {
      maxWidth: '86%',
      backgroundColor: VOICE.me,
      borderRadius: 24,
      borderBottomRightRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    meText: { fontSize: 16, ...font(500), color: colors.primaryText, lineHeight: 24 },

    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-end',
      gap: 4,
      marginTop: 4,
    },
    metaTime: { fontSize: 11, ...font(500), color: VOICE.meta, letterSpacing: 0.2 },
    metaTimeOwn: { color: colors.primaryText },

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
    visualBlock: { gap: 4, alignSelf: 'stretch' },
    /** The quieter fill inside a card, since these sit inside her bubble. */
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
    /** The one you took is in your own blue: picking it was your side of the talk. */
    offerTakenFill: { borderRadius: 16, backgroundColor: VOICE.me },
    offerRowSpent: { opacity: 0.4 },
    offerTime: {
      fontSize: 20,
      ...font(700),
      color: VOICE.ink,
      letterSpacing: -0.3,
      flexShrink: 0,
    },
    offerTimeTaken: { color: colors.primaryText },
    offerWhen: { flex: 1, fontSize: 14, ...font(600), color: VOICE.accent },
    // Full white, not a dimmed one: on the blue, anything less is under 4.5:1,
    // and the size step to the time already makes this the quieter of the two.
    offerWhenTaken: { color: colors.primaryText },

    // ── Structured cards ──
    cardTitle: {
      fontSize: 14,
      ...font(700),
      color: VOICE.accent,
      marginBottom: 2,
    },
    cardRow: {
      borderRadius: 16,
      backgroundColor: VOICE.chrome,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 2,
    },
    cardLabel: { fontSize: 16, ...font(700), color: VOICE.ink, lineHeight: 22 },
    cardDetail: { fontSize: 14, ...font(500), color: VOICE.meta, lineHeight: 20 },
    cardTakenFill: { borderRadius: 16, backgroundColor: VOICE.me },
    cardDetailTaken: { color: colors.primaryText, opacity: 0.8 },

    // ── Checklist ──
    checkRow: {
      borderRadius: 16,
      backgroundColor: VOICE.chrome,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    checkBox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: VOICE.meta,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkBoxDone: {
      borderColor: VOICE.accent,
      backgroundColor: VOICE.accent,
    },
    checkContent: { flex: 1, gap: 1 },
    checkLabelDone: { textDecorationLine: 'line-through', opacity: 0.5 },

    // ── Confirmation card ──
    confirmCard: {
      borderRadius: 16,
      backgroundColor: VOICE.chrome,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 8,
      borderLeftWidth: 3,
      borderLeftColor: VOICE.accent,
    },
    confirmHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    confirmIcon: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: VOICE.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    confirmTitle: { fontSize: 16, ...font(700), color: VOICE.ink, flex: 1, lineHeight: 22 },
    confirmField: { flexDirection: 'row', gap: 8, paddingLeft: 32 },
    confirmFieldLabel: { fontSize: 14, ...font(600), color: VOICE.meta, minWidth: 60 },
    confirmFieldValue: { fontSize: 14, ...font(500), color: VOICE.ink, flex: 1 },

    // ── Budget gauges ──
    budgetRow: {
      borderRadius: 16,
      backgroundColor: VOICE.chrome,
      paddingHorizontal: 14,
      paddingVertical: 10,
      gap: 6,
    },
    budgetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    budgetCat: { fontSize: 15, ...font(600), color: VOICE.ink, flex: 1 },
    budgetAmounts: { fontSize: 13, ...font(600), color: VOICE.meta },
    budgetOver: { color: '#e67e73' },
    budgetTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: `${VOICE.meta}30`,
      overflow: 'hidden' as const,
    },
    budgetFill: {
      height: 6,
      borderRadius: 3,
      backgroundColor: VOICE.accent,
    },
    budgetFillOver: { backgroundColor: '#e67e73' },

    // ── Day timeline ──
    timelineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 6,
      paddingHorizontal: 4,
    },
    timelineDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: VOICE.accent,
    },
    timelineTime: { fontSize: 14, ...font(700), color: VOICE.meta, minWidth: 76 },
    timelineTitle: { fontSize: 15, ...font(500), color: VOICE.ink, flex: 1 },

    // ── Debt cards ──
    debtRow: {
      borderRadius: 16,
      backgroundColor: VOICE.chrome,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    debtInfo: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
    debtDirection: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: `${VOICE.meta}20`,
      alignItems: 'center',
      justifyContent: 'center',
    },
    debtText: { flex: 1, gap: 1 },
    debtAmount: { fontSize: 13, ...font(600), color: VOICE.meta },
    debtSettle: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: `${VOICE.accent}20`,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── Quick action chips ──
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      alignSelf: 'stretch',
    },
    chip: {
      ...edge,
      backgroundColor: VOICE.chrome,
      borderRadius: 100,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    chipText: { fontSize: 14, ...font(600), color: VOICE.accent },

    // ── Capabilities (empty state) ──
    canDoTitle: {
      fontSize: 15,
      ...font(600),
      color: VOICE.meta,
      textAlign: 'center',
      marginBottom: 12,
      marginTop: 24,
    },
    capGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      justifyContent: 'center',
      paddingHorizontal: 12,
    },
    capChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: VOICE.chrome,
      borderRadius: 100,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    capText: { fontSize: 13, ...font(500), color: VOICE.ink },

    // ── Weather ──
    weatherRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
      paddingHorizontal: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: 'rgba(255,255,255,0.08)',
    },
    weatherInfo: { flex: 1 },
    weatherDay: { fontSize: 15, ...font(600), color: VOICE.ink },
    weatherDesc: { fontSize: 12, ...font(400), color: VOICE.meta, marginTop: 1 },
    weatherTemp: { fontSize: 16, ...font(700), color: VOICE.ink },

    // ── Summary ──
    statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    statCard: {
      ...edge,
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderRadius: 12,
      padding: 12,
      minWidth: 100,
      flex: 1,
    },
    statHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    statLabel: { fontSize: 12, ...font(500), color: VOICE.meta },
    statValue: { fontSize: 20, ...font(700), color: VOICE.ink, marginTop: 4 },
    highlightList: { marginTop: 10, gap: 6 },
    highlightRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    highlightText: { fontSize: 14, ...font(400), color: VOICE.ink, flex: 1 },

    undoBar: {
      ...edge,
      backgroundColor: VOICE.chrome,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'center',
      borderRadius: 100,
      paddingHorizontal: 16,
      paddingVertical: 10,
      marginBottom: spacing.sm,
    },
    undoText: { fontSize: 14, ...font(600), color: VOICE.ink, flexShrink: 1 },

    // ── The orb ──
    stage: { height: 172, alignItems: 'center', justifyContent: 'center' },
    wave: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
    waveLayer: { position: 'absolute' },
    orbit: { position: 'absolute', width: ORBIT_BOX, height: ORBIT_BOX, alignItems: 'center', justifyContent: 'center' },
    halo: { position: 'absolute' },
    orbGlow: {
      // Her own light — the glow is the thing that says she is awake. It is the
      // blue the mic button in the bar glows, and on the dark it is light rather
      // than shadow, so it pools close around the orb instead of dropping below.
      shadowColor: VOICE.accentGradient[1],
      shadowOpacity: 0.5,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
      borderRadius: 44,
      backgroundColor: VOICE.accentGradient[1],
    },
    orb: {
      width: 88,
      height: 88,
      borderRadius: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },

    caption: { marginTop: spacing.xs, fontSize: 16, ...font(700), color: VOICE.ink, textAlign: 'center' },
    hint: { fontSize: 14, ...font(500), color: VOICE.meta, textAlign: 'center', marginTop: 2 },

    /** A field as `Field` draws one — the quiet opaque fill and a hairline — in a pill. */
    composer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: GUTTER,
      marginTop: spacing.md,
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 100,
      padding: 6,
    },
    composerInput: {
      flex: 1,
      // The browser's own focus ring is a hard rectangle inside the pill.
      // Dropping it is normally a sin; here the field *is* the whole pill, which
      // carries its own edge, and the caret says where the typing goes.
      outlineWidth: 0,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      ...font(500),
      color: VOICE.ink,
    },
    /** Nothing to send yet: a glass disc with the glyph lit, rather than a greyed copy. */
    sendBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: VOICE.chrome,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /**
     * Something to send: your blue, as what it sends lands in a bubble of the
     * same colour. A fill of its own so it can spring in; opaque, so the glass
     * under it changes nothing once it has.
     */
    sendFill: { borderRadius: 22, backgroundColor: VOICE.me },
    sendGlyphRTL: { transform: [{ scaleX: -1 }] },

    restartBtn: {
      ...edge,
      backgroundColor: VOICE.chrome,
      alignSelf: 'center',
      marginTop: spacing.sm,
      borderRadius: 100,
      paddingHorizontal: 22,
      paddingVertical: 12,
    },
    restartText: { fontSize: 15, ...font(700), color: VOICE.accent },
  }),
);
