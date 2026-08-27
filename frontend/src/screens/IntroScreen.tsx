import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';
import { ArrowRight } from 'lucide-react-native';

import { Entrance, useFloat, useBreathe } from '../components/motion';
import { colors, spacing, font, TILES, TILE_INK, NAV_BAR } from '../theme';
import { t, isRTL, alignStart } from '../lib/i18n';

// The opening moment, shown once per launch while the app is warm behind it.
//
// A collage of the app's own shapes — the accent blob, a pastel gradient pill,
// a bar chart, a wave — each arriving on its own beat and then breathing in
// place, over the headline and a Start button. Everything is drawn from the
// existing palette: paper ground, pastel tiles, tile inks, the orange accent.

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
function Bar({ height, color, delay }: { height: number; color: string; delay: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
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
  }, [delay, v]);

  return (
    <View style={{ height: 78, justifyContent: 'flex-end' }}>
      <Animated.View
        style={{
          width: 11,
          height,
          borderRadius: 5.5,
          backgroundColor: color,
          transform: [
            // Scaling happens about the centre; this translate pins the foot
            // of the bar to the baseline so it grows upward like a bar should.
            { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [height / 2, 0] }) },
            { scaleY: v },
          ],
        }}
      />
    </View>
  );
}

/** The wave drawing itself on, with a dot riding back and forth along it. */
function Wave() {
  const draw = useRef(new Animated.Value(0)).current; // JS-driven: SVG props
  const travel = useRef(new Animated.Value(0)).current; // native: transforms
  useEffect(() => {
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
  }, [draw, travel]);

  return (
    <View style={{ width: WAVE_W, height: WAVE_H }}>
      <Svg width={WAVE_W} height={WAVE_H}>
        <Defs>
          <SvgGradient id="wave" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={TILES.green} />
            <Stop offset="0.5" stopColor={TILES.blue} />
            <Stop offset="1" stopColor={TILES.yellow} />
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

/** A light sweep across the gradient pill, so it reads as glass, not print. */
function Shimmer() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
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
  }, [v]);

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
        colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.shimmerBand}
      />
    </Animated.View>
  );
}

/** A loose pastel dot drifting near the collage. */
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
  const float = useFloat(9, 2400, delay);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.drift,
        style,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        { transform: [{ translateY: float }] },
      ]}
    />
  );
}

// ── The screen ──────────────────────────────────────────────────────────────

const BAR_HEIGHTS = [34, 60, 44, 74, 52, 28];
const BAR_COLORS = [
  NAV_BAR.accent,
  colors.primary,
  TILE_INK.blue,
  colors.primary,
  TILE_INK.green,
  TILE_INK.yellow,
];

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

  const startAlign = { textAlign: alignStart() } as const;

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
      {/* ── The collage ── */}
      <View>
        <Drift color={TILE_INK.yellow} size={10} delay={300} style={{ top: -4, insetInlineStart: '55%' }} />
        <Drift color={TILE_INK.blue} size={8} delay={900} style={{ top: 150, insetInlineStart: -2 }} />
        <Drift color={TILE_INK.green} size={9} delay={1500} style={{ top: 300, insetInlineEnd: 6 }} />

        <View style={styles.collageRow}>
          {/* The accent blob with a bite taken out of it — the logo's gesture. */}
          <Entrance delay={0} style={{ flex: 1 }}>
            <Animated.View style={{ transform: [{ translateY: blobFloat }] }}>
              <LinearGradient
                colors={NAV_BAR.accentGradient}
                start={{ x: 0.15, y: 0 }}
                end={{ x: 0.85, y: 1 }}
                style={styles.blob}
              >
                <View style={styles.blobHole} />
              </LinearGradient>
            </Animated.View>
          </Entrance>

          {/* The pastel glass pill. */}
          <Entrance delay={120} style={{ flex: 1 }}>
            <Animated.View style={{ transform: [{ translateY: pillFloat }] }}>
              <View style={styles.glassPillClip}>
                <LinearGradient
                  colors={[TILES.blue, '#E9F1FA', TILES.green]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.glassPill}
                />
                <Shimmer />
              </View>
            </Animated.View>
          </Entrance>
        </View>

        {/* The bar chart, growing bar by bar. */}
        <Entrance delay={240} style={styles.barCardWrap}>
          <Animated.View style={[styles.barCard, { transform: [{ translateY: barsFloat }] }]}>
            {BAR_HEIGHTS.map((h, i) => (
              <Bar key={i} height={h} color={BAR_COLORS[i]} delay={420 + i * 90} />
            ))}
          </Animated.View>
        </Entrance>

        {/* The wave, on the one dark surface in the app. */}
        <Entrance delay={360} style={styles.wavePillWrap}>
          <Animated.View style={[styles.wavePill, { transform: [{ translateY: waveFloat }] }]}>
            <Wave />
          </Animated.View>
        </Entrance>
      </View>

      <View style={{ flex: 1 }} />

      {/* ── The headline ── */}
      <Entrance delay={520} from={30}>
        <Text style={[styles.headline, startAlign]}>
          {t('intro.l1')} <Text style={styles.headlineAccent}>{t('intro.accent')}</Text> {t('intro.l2')}{' '}
          {t('intro.l3')}
        </Text>
      </Entrance>

      {/* ── Start ── */}
      <Entrance delay={700}>
        <View style={styles.startRow}>
          <Animated.View style={{ transform: [{ scale: pulse }] }}>
            <Pressable
              onPress={start}
              accessibilityRole="button"
              accessibilityLabel={t('intro.start')}
              style={({ pressed }) => [pressed && styles.startPressed]}
            >
              <LinearGradient
                colors={NAV_BAR.accentGradient}
                start={{ x: 0.15, y: 0 }}
                end={{ x: 0.85, y: 1 }}
                style={styles.startBtn}
              >
                <Text style={styles.startText}>{t('intro.start')}</Text>
                <ArrowRight
                  color={NAV_BAR.accentIcon}
                  size={18}
                  strokeWidth={2.6}
                  style={{ transform: [{ scaleX: isRTL() ? -1 : 1 }] }}
                />
              </LinearGradient>
            </Pressable>
          </Animated.View>
        </View>
      </Entrance>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
  },

  drift: { position: 'absolute', opacity: 0.55, zIndex: 1 },

  collageRow: { flexDirection: 'row', gap: 14 },
  blob: {
    height: 148,
    borderRadius: 34,
    overflow: 'hidden',
  },
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
    height: 148,
    borderRadius: 34,
    overflow: 'hidden',
  },
  glassPill: { flex: 1 },
  shimmerBand: { width: 64, height: '160%', top: '-30%' },

  barCardWrap: { marginTop: 14, width: '64%' },
  barCard: {
    height: 118,
    borderRadius: 30,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 20,
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
    elevation: 3,
  },

  wavePillWrap: { marginTop: 14, width: '82%', alignSelf: 'flex-end' },
  wavePill: {
    height: 118,
    borderRadius: 30,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  waveDot: {
    position: 'absolute',
    top: 0,
    // Physical left, deliberately: the SVG underneath does not mirror in RTL,
    // so the dot that rides it must not either.
    left: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveDotCore: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },

  headline: {
    fontSize: 38,
    ...font(700),
    color: colors.text,
    lineHeight: 46,
    letterSpacing: -1,
    marginBottom: spacing.lg,
  },
  headlineAccent: { color: NAV_BAR.accent },

  startRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 100,
    shadowColor: NAV_BAR.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  startPressed: { transform: [{ scale: 0.95 }] },
  startText: { fontSize: 16, ...font(700), color: NAV_BAR.accentIcon },
});
