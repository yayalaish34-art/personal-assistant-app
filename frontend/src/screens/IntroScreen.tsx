import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';
import { ArrowRight } from 'lucide-react-native';

import {
  Entrance,
  useFloat,
  useBreathe,
  useReducedMotion,
  Pressable,
} from '../components/motion';
import { Glow, SweepText } from '../components/ui';
import { colors, spacing, font, IRIDESCENT, NIGHT, themed } from '../theme';
import { t, isRTL } from '../lib/i18n';

// The opening moment, shown once per launch while the app is warm behind it.
//
// A collage of the app's own shapes — the blob, a glass pill, a bar chart, a
// wave — each arriving on its own beat and then breathing in place, over the
// headline and a Start button. It is Home's night: the dark page and its glow,
// glass for the shapes that hold something, and the lit colours only on what is
// held — the sweep on the blob and the wave, the timeline's blocks for the
// bars, the app's blue on the one button.

const AnimatedPath = Animated.createAnimatedComponent(Path);

// ── The wave, precomputed once ──────────────────────────────────────────────
// A polyline dense enough to read as a curve. The same points drive three
// things: the path itself, its measured length (for the draw-on dash), and the
// x/y tracks the dot rides along.

const WAVE_W = 240;
const WAVE_H = 96;
const WAVE_PTS = Array.from({ length: 41 }, (_, i) => {
  const p = i / 40;
  return {
    x: 12 + p * (WAVE_W - 24),
    y: WAVE_H / 2 - Math.sin(p * Math.PI * 2.1 + 0.4) * 24,
  };
});
const WAVE_PATH = WAVE_PTS.map((pt, i) => `${i ? 'L' : 'M'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(
  ' ',
);
const WAVE_LEN = WAVE_PTS.reduce(
  (len, pt, i) => (i ? len + Math.hypot(pt.x - WAVE_PTS[i - 1].x, pt.y - WAVE_PTS[i - 1].y) : 0),
  0,
);
const WAVE_T = WAVE_PTS.map((_, i) => i / 40);

// ── Small animated pieces ───────────────────────────────────────────────────

/** One bar of the mini chart: grows up from the baseline, then breathes. */
function Bar({
  height,
  fill,
  delay,
}: {
  height: number;
  /** Top stop first: the bar is lit from above, like Home's blocks. */
  fill: readonly [string, string];
  delay: number;
}) {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    // Standing at full height, for someone who has asked for less motion.
    if (reduce) {
      v.setValue(1);
      return;
    }
    const anim = Animated.sequence([
      Animated.delay(delay),
      Animated.spring(v, { toValue: 1, friction: 6, tension: 50, useNativeDriver: true }),
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: 0.88,
            duration: 1500,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 1,
            duration: 1500,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      ),
    ]);
    anim.start();
    return () => anim.stop();
  }, [delay, reduce, v]);

  return (
    <View style={{ height: 78, justifyContent: 'flex-end' }}>
      <Animated.View
        style={{
          width: 11,
          height,
          transform: [
            // Scaling happens about the centre; this translate pins the foot
            // of the bar to the baseline so it grows upward like a bar should.
            { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [height / 2, 0] }) },
            { scaleY: v },
          ],
        }}
      >
        <LinearGradient colors={fill} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.barFill} />
      </Animated.View>
    </View>
  );
}

/** The wave drawing itself on, with a dot riding back and forth along it. */
function Wave() {
  const reduce = useReducedMotion();
  const draw = useRef(new Animated.Value(reduce ? 1 : 0)).current; // JS-driven: SVG props
  const travel = useRef(new Animated.Value(0)).current; // native: transforms
  useEffect(() => {
    // Drawn whole, with the dot resting at its start.
    if (reduce) {
      draw.setValue(1);
      travel.setValue(0);
      return;
    }
    Animated.timing(draw, {
      toValue: 1,
      delay: 650,
      duration: 1300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    const ride = Animated.sequence([
      Animated.delay(1900),
      Animated.loop(
        Animated.sequence([
          Animated.timing(travel, {
            toValue: 1,
            duration: 3200,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(travel, {
            toValue: 0,
            duration: 3200,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    ]);
    ride.start();
    return () => ride.stop();
  }, [draw, reduce, travel]);

  return (
    <View style={{ width: WAVE_W, height: WAVE_H }}>
      <Svg width={WAVE_W} height={WAVE_H}>
        <Defs>
          {/* The sweep itself, lit: on the dark the tints it used to be drawn
              in are a whisper, and a line that thin would vanish. */}
          <SvgGradient id="wave" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={IRIDESCENT[0]} />
            <Stop offset="0.5" stopColor={IRIDESCENT[1]} />
            <Stop offset="1" stopColor={IRIDESCENT[2]} />
          </SvgGradient>
        </Defs>
        <AnimatedPath
          d={WAVE_PATH}
          stroke="url(#wave)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray={`${WAVE_LEN} ${WAVE_LEN}`}
          strokeDashoffset={draw.interpolate({ inputRange: [0, 1], outputRange: [WAVE_LEN, 0] })}
        />
      </Svg>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.waveDot,
          {
            opacity: draw,
            transform: [
              { translateX: travel.interpolate({ inputRange: WAVE_T, outputRange: WAVE_PTS.map((p) => p.x - 8) }) },
              { translateY: travel.interpolate({ inputRange: WAVE_T, outputRange: WAVE_PTS.map((p) => p.y - 8) }) },
            ],
          },
        ]}
      >
        <View style={styles.waveDotCore} />
      </Animated.View>
    </View>
  );
}

/**
 * A light sweep across the glass pill, so it reads as glass, not print. Faint:
 * over the dark, the band it was on paper would read as a flash.
 */
function Shimmer() {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // At 0 the band waits outside the pill's clip, so standing still is unseen.
    if (reduce) {
      v.setValue(0);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(1100),
        Animated.timing(v, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [reduce, v]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          transform: [
            { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [-140, 240] }) },
            { rotate: '18deg' },
          ],
        },
      ]}
    >
      <LinearGradient
        colors={['rgba(255,255,255,0)', NIGHT.sheen, 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.shimmerBand}
      />
    </Animated.View>
  );
}

/** How lit a mote is once it has arrived. */
const DRIFT_OPACITY = 0.6;

/**
 * A loose lit mote drifting near the collage, in one of the sweep's stops.
 *
 * It pops into being on its own beat, the one its drift starts on. Everything
 * else here arrives, and a mote already standing there before the blob had come
 * in would be the one thing on the page that did not.
 */
function Drift({
  color,
  size,
  delay,
  style,
}: {
  color: string;
  size: number;
  delay: number;
  style: object;
}) {
  const reduce = useReducedMotion();
  const float = useFloat(9, 2400, delay);
  const arrive = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) {
      arrive.setValue(1);
      return;
    }
    // `PopIn`'s spring, held back to the mote's beat.
    const anim = Animated.spring(arrive, {
      toValue: 1,
      delay,
      friction: 5,
      tension: 140,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [arrive, delay, reduce]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.drift,
        style,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        {
          opacity: arrive.interpolate({
            inputRange: [0, 0.6],
            outputRange: [0, DRIFT_OPACITY],
            extrapolate: 'clamp',
          }),
          transform: [{ translateY: float }, { scale: arrive }],
        },
      ]}
    />
  );
}

// ── The headline ────────────────────────────────────────────────────────────

/** Home's headline keeps a word space at this fraction of the type size. */
const HEADLINE_SIZE = 38;
const WORD_GAP = Math.round(HEADLINE_SIZE * 0.24);

const wordsOf = (key: string) => t(key).split(/\s+/).filter(Boolean);

/** When the headline's first word starts to arrive, in ms. */
const HEADLINE_AT = 500;
/** From the first word arriving to the last, however many a translation has. */
const HEADLINE_SPAN = 280;

/**
 * The headline with its accent word painted in the sweep, the way Home paints
 * its name, and everything else in white.
 *
 * Word by word rather than one Text: a gradient cannot live inside a Text, so
 * the accent is an element of its own — and once it is, the words either side
 * have to be elements too, or the line could only break around the accent
 * instead of between any two words the way a sentence does. The gap stands in
 * for the space. The row wraps and mirrors with the page, so in a right-to-left
 * language the words run from the right in the same order with nothing here
 * knowing about it.
 *
 * Being separate elements, the words also arrive one after another, in reading
 * order. The beat between them shortens for a translation with more words, so
 * a longer sentence still lands together with Start rather than well after it.
 *
 * Read out as the one sentence it was when it was one Text.
 */
function Headline() {
  const before = wordsOf('intro.l1');
  const after = [...wordsOf('intro.l2'), ...wordsOf('intro.l3')];
  const sentence = [...before, t('intro.accent'), ...after].join(' ');

  const count = before.length + 1 + after.length;
  const beat = Math.min(45, HEADLINE_SPAN / Math.max(count - 1, 1));
  const at = (i: number) => HEADLINE_AT + i * beat;

  return (
    <View style={styles.headline} accessible accessibilityLabel={sentence}>
      {before.map((w, i) => (
        <Entrance key={`b${i}`} delay={at(i)} from={20}>
          <Text style={styles.headlineText}>{w}</Text>
        </Entrance>
      ))}
      <Entrance delay={at(before.length)} from={20}>
        <SweepText style={styles.headlineText}>{t('intro.accent')}</SweepText>
      </Entrance>
      {after.map((w, i) => (
        <Entrance key={`a${i}`} delay={at(before.length + 1 + i)} from={20}>
          <Text style={styles.headlineText}>{w}</Text>
        </Entrance>
      ))}
    </View>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────

const BAR_HEIGHTS = [34, 60, 44, 74, 52, 28];

export default function IntroScreen({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const [leaving, setLeaving] = useState(false);

  const blobFloat = useFloat(5, 2600, 0);
  const pillFloat = useFloat(7, 3000, 400);
  const barsFloat = useFloat(4, 2800, 800);
  const waveFloat = useFloat(5, 3200, 1200);
  const pulse = useBreathe(1, 1.045, 1400, 1400);

  // The whole screen slides away as one piece when Start is pressed, so the
  // app appears to have been waiting underneath rather than loading after.
  const exit = useRef(new Animated.Value(0)).current;
  /**
   * Belt and braces. The animation callback is the way in, but this screen is
   * the only thing standing between a cold start and the app, so it must not
   * be able to trap anyone if that callback is never called at all.
   */
  const escape = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Both the callback and the timer call this; only the first one counts. */
  const handedOver = useRef(false);
  const finish = () => {
    if (handedOver.current) return;
    handedOver.current = true;
    if (escape.current) clearTimeout(escape.current);
    onDone();
  };
  useEffect(() => () => {
    if (escape.current) clearTimeout(escape.current);
  }, []);

  const start = () => {
    if (leaving) return;
    setLeaving(true);
    escape.current = setTimeout(finish, 600);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Animated.timing(exit, {
      toValue: 1,
      duration: 280,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
      // Unconditionally, not `if (finished)`. This callback is the only thing
      // that lets the app in, and `leaving` has already disabled the button by
      // the time it runs — so an animation that is interrupted rather than
      // completed (a busy JS thread, a backgrounded app) used to strand the
      // user on this screen for good, with no error anywhere to explain it.
    }).start(() => finish());
  };

  return (
    <Animated.View
      style={[
        styles.screen,
        {
          paddingTop: insets.top + spacing.lg,
          paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.md,
          opacity: exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          transform: [
            { translateY: exit.interpolate({ inputRange: [0, 1], outputRange: [0, -36] }) },
          ],
        },
      ]}
    >
      {/* Inside the sliding view, so the glow leaves with the rest of it. */}
      <Glow />

      {/* ── The collage ── */}
      <View>
        <Drift color={IRIDESCENT[2]} size={10} delay={300} style={{ top: -4, insetInlineStart: '55%' }} />
        <Drift color={IRIDESCENT[1]} size={8} delay={900} style={{ top: 150, insetInlineStart: -2 }} />
        <Drift color={IRIDESCENT[0]} size={9} delay={1500} style={{ top: 300, insetInlineEnd: 6 }} />

        <View style={styles.collageRow}>
          {/* The blob with a bite taken out of it — the logo's gesture, lit in
              the sweep, and glowing the way Home's discs do. */}
          <Entrance delay={0} style={{ flex: 1 }}>
            <Animated.View style={[styles.blobGlow, { transform: [{ translateY: blobFloat }] }]}>
              <LinearGradient
                colors={IRIDESCENT}
                start={{ x: 0.15, y: 0 }}
                end={{ x: 0.85, y: 1 }}
                style={styles.blob}
              >
                <View style={styles.blobHole} />
              </LinearGradient>
            </Animated.View>
          </Entrance>

          {/* The glass pill. */}
          <Entrance delay={120} style={{ flex: 1 }}>
            <Animated.View style={{ transform: [{ translateY: pillFloat }] }}>
              <View style={styles.glassPillClip}>
                <LinearGradient
                  // The sweep's blue and green (IRIDESCENT[1], [0]) at a
                  // whisper, clear between them so the glass shows through.
                  colors={[
                    'rgba(143, 199, 255, 0.16)',
                    'rgba(255, 255, 255, 0)',
                    'rgba(168, 217, 140, 0.12)',
                  ]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.glassPill}
                />
                <Shimmer />
                {/* The edge goes on top: under a clip, the fill would cover it. */}
                <View pointerEvents="none" style={styles.glassPillEdge} />
              </View>
            </Animated.View>
          </Entrance>
        </View>

        {/* The bar chart, growing bar by bar, in the blocks Home's timeline
            draws the day with, cycled in the same order. */}
        <Entrance delay={240} style={styles.barCardWrap}>
          <Animated.View style={[styles.barCard, { transform: [{ translateY: barsFloat }] }]}>
            {BAR_HEIGHTS.map((h, i) => (
              <Bar
                key={i}
                height={h}
                fill={NIGHT.blocks[i % NIGHT.blocks.length]}
                delay={420 + i * 90}
              />
            ))}
          </Animated.View>
        </Entrance>

        {/* The wave, drawn in the sweep on glass. */}
        <Entrance delay={360} style={styles.wavePillWrap}>
          <Animated.View style={[styles.wavePill, { transform: [{ translateY: waveFloat }] }]}>
            <Wave />
          </Animated.View>
        </Entrance>
      </View>

      <View style={{ flex: 1 }} />

      {/* ── The headline ── */}
      {/* Its words bring themselves in, one at a time. */}
      <Headline />

      {/* ── Start ── */}
      {/* The app's blue, the same pill as every primary button after it: the
          questionnaire's Continue is the next thing pressed, and the front
          door should look like the doors behind it. The sweep already runs
          through the collage and the headline's word. */}
      <Entrance delay={700}>
        <View style={styles.startRow}>
          <Animated.View style={{ transform: [{ scale: pulse }] }}>
            <Pressable
              onPress={start}
              accessibilityRole="button"
              accessibilityLabel={t('intro.start')}
              style={styles.startBtn}
            >
              <LinearGradient
                colors={NIGHT.blue}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                // Rounded itself rather than clipped by the button: clipping on
                // iOS takes the button's glow with it.
                style={[StyleSheet.absoluteFill, styles.startFill]}
              />
              <Text style={styles.startText}>{t('intro.start')}</Text>
              {/* In a View of its own: on the web the fill above is positioned and
                  a bare svg is not, so the fill painted over the arrow. */}
              <View pointerEvents="none" style={{ transform: [{ scaleX: isRTL() ? -1 : 1 }] }}>
                <ArrowRight color={colors.primaryText} size={18} strokeWidth={2.6} style={{ transform: [{ scaleX: isRTL() ? -1 : 1 }] }} />
              </View>
            </Pressable>
          </Animated.View>
        </View>
      </Entrance>
    </Animated.View>
  );
}

/**
 * A glass card: a whisper over the page, with a hairline edge.
 *
 * The colours are getters, read each time the object is spread: a sheet built
 * for the other scheme has to pick up the glass in force, not the one this
 * module saw when it was imported.
 */
const glass = {
  get backgroundColor() {
    return NIGHT.card;
  },
  borderWidth: StyleSheet.hairlineWidth,
  get borderColor() {
    return NIGHT.line;
  },
};

const styles = themed(() =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.bg,
      paddingHorizontal: spacing.lg,
    },

    /** Its opacity is `DRIFT_OPACITY`, set as it arrives. */
    drift: { position: 'absolute', zIndex: 1 },

    collageRow: { flexDirection: 'row', gap: 14 },
    /** The blob's glow, held outside it: the blob clips, and a clip takes the glow. */
    blobGlow: {
      borderRadius: 34,
      shadowColor: IRIDESCENT[1],
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.35,
      shadowRadius: 18,
    },
    blob: {
      height: 148,
      borderRadius: 34,
      overflow: 'hidden',
    },
    /** Painted the page's colour, so the bite reads as a hole through to it. */
    blobHole: {
      position: 'absolute',
      bottom: 16,
      insetInlineStart: 16,
      width: 58,
      height: 58,
      borderRadius: 29,
      backgroundColor: colors.bg,
    },
    glassPillClip: {
      backgroundColor: NIGHT.card,
      height: 148,
      borderRadius: 34,
      overflow: 'hidden',
    },
    glassPill: { flex: 1 },
    glassPillEdge: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: 34,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    shimmerBand: { width: 64, height: '160%', top: '-30%' },

    barCardWrap: { marginTop: 14, width: '64%' },
    // No drop shadow: on the dark a card is lifted by its glass and its edge,
    // and a shadow under it would only be black on black.
    barCard: {
      ...glass,
      height: 118,
      borderRadius: 30,
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 12,
      paddingVertical: 20,
    },
    barFill: { flex: 1, borderRadius: 5.5 },

    wavePillWrap: { marginTop: 14, width: '82%', alignSelf: 'flex-end' },
    wavePill: {
      ...glass,
      height: 118,
      borderRadius: 30,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    /** A white bead in a halo of the sweep's blue, lit like Home's "now" dot. */
    waveDot: {
      position: 'absolute',
      top: 0,
      // Physical left, deliberately: the SVG underneath does not mirror in RTL,
      // so the dot that rides it must not either.
      left: 0,
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: 'rgba(143, 199, 255, 0.3)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    waveDotCore: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: NIGHT.ink,
      shadowColor: IRIDESCENT[1],
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.9,
      shadowRadius: 6,
    },

    headline: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      columnGap: WORD_GAP,
      marginBottom: spacing.lg,
    },
    headlineText: {
      fontSize: HEADLINE_SIZE,
      ...font(700),
      color: colors.text,
      lineHeight: 46,
      letterSpacing: -1,
    },

    startRow: { flexDirection: 'row', justifyContent: 'flex-end' },
    startBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 28,
      paddingVertical: 16,
      borderRadius: 100,
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.5,
      shadowRadius: 14,
      elevation: 6,
    },
    startFill: { borderRadius: 100 },
    startText: { fontSize: 16, ...font(700), color: colors.primaryText },
  }),
);
