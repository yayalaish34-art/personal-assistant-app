import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Line, Path } from 'react-native-svg';
import {
  ChartPie,
  CalendarClock,
  ShoppingCart,
  Sun,
  Clock,
  Mic,
  X,
  type LucideIcon,
} from 'lucide-react-native';

import { Pressable } from './motion';
import { colors, font, IRIDESCENT, NIGHT, spacing, themed } from '../theme';
import { alignStart, isRTL, t } from '../lib/i18n';
import { goToTab } from '../navigation';

// The feature tour: an overlay that walks the reader through six things
// worth knowing about this build. Each slide navigates to the tab where the
// feature lives, drops a wash over the rest of the page, and drops a clean
// pointer — a straight arrow with a short label under it — onto the exact
// spot on the screen the feature sits on. Tap anywhere to move on.

/** Where the target sits on the current tab, in physical (px) coordinates. */
type Pointer =
  | { kind: 'topEnd'; offsetTop?: number; offsetInset?: number }
  | { kind: 'topStart'; offsetTop?: number; offsetInset?: number }
  | { kind: 'bottomCenter'; offsetBottom?: number }
  | { kind: 'midStart'; offsetTop?: number };

type Slide = {
  key: string;
  Icon: LucideIcon;
  discColours: readonly [string, string];
  tab: 'Today' | 'Calendar' | 'Shopping' | 'Finance';
  pointer: Pointer;
  titleKey: string;
  bodyKey: string;
};

const SLIDES: Slide[] = [
  {
    key: 'stats',
    Icon: ChartPie,
    discColours: NIGHT.discs.tasks,
    tab: 'Finance',
    pointer: { kind: 'topEnd', offsetTop: 60, offsetInset: 108 },
    titleKey: 'tour.stats.title',
    bodyKey: 'tour.stats.body',
  },
  {
    key: 'calendar',
    Icon: CalendarClock,
    discColours: NIGHT.discs.reminders,
    tab: 'Calendar',
    pointer: { kind: 'topEnd', offsetTop: 155, offsetInset: 30 },
    titleKey: 'tour.calendar.title',
    bodyKey: 'tour.calendar.body',
  },
  {
    key: 'shopping',
    Icon: ShoppingCart,
    discColours: NIGHT.discs.meetings,
    tab: 'Shopping',
    pointer: { kind: 'midStart', offsetTop: 320 },
    titleKey: 'tour.shopping.title',
    bodyKey: 'tour.shopping.body',
  },
  {
    key: 'weatherColour',
    Icon: Sun,
    discColours: ['#FFE066', '#F5A623'] as const,
    tab: 'Today',
    pointer: { kind: 'topStart', offsetTop: 160, offsetInset: 12 },
    titleKey: 'tour.weatherColour.title',
    bodyKey: 'tour.weatherColour.body',
  },
  {
    key: 'weatherHours',
    Icon: Clock,
    discColours: NIGHT.discs.tasks,
    tab: 'Today',
    pointer: { kind: 'topStart', offsetTop: 160, offsetInset: 12 },
    titleKey: 'tour.weatherHours.title',
    bodyKey: 'tour.weatherHours.body',
  },
  {
    key: 'voice',
    Icon: Mic,
    discColours: [IRIDESCENT[1], IRIDESCENT[0]] as const,
    tab: 'Today',
    pointer: { kind: 'bottomCenter', offsetBottom: 76 },
    titleKey: 'tour.voice.title',
    bodyKey: 'tour.voice.body',
  },
];

// ── Callout: arrow + card ──────────────────────────────────────────────────

const ARROW_LEN = 68;
const ARROW_HEAD = 14;

/**
 * A clean straight arrow: one hairline shaft with a solid triangular head.
 * The tip is at (cx, 0) — the "point that lands on the target" — and the
 * tail is at (cx, ARROW_LEN). Rotated as one unit when the callout needs to
 * point down instead of up.
 */
function CleanArrow({ pointsDown }: { pointsDown: boolean }) {
  const w = ARROW_HEAD * 2 + 4;
  const cx = w / 2;
  return (
    <View style={{ transform: [{ rotate: pointsDown ? '180deg' : '0deg' }] }}>
      <Svg width={w} height={ARROW_LEN + 2} viewBox={`0 0 ${w} ${ARROW_LEN + 2}`}>
        <Line
          x1={cx}
          y1={ARROW_LEN}
          x2={cx}
          y2={ARROW_HEAD}
          stroke="#FFFFFF"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <Path
          d={`M ${cx} 0 L ${cx - ARROW_HEAD} ${ARROW_HEAD + 4} L ${cx + ARROW_HEAD} ${ARROW_HEAD + 4} Z`}
          fill="#FFFFFF"
        />
      </Svg>
    </View>
  );
}

/** Fades and rises children when `trigger` changes — one call per slide. */
function Fade({ trigger, children }: { trigger: number; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [trigger, v]);
  return (
    <Animated.View
      style={{
        opacity: v,
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

function Pips({ count, index }: { count: number; index: number }) {
  return (
    <View style={styles.pips}>
      {[...Array(count)].map((_, i) => (
        <View key={i} style={[styles.pip, i === index && styles.pipOn]} />
      ))}
    </View>
  );
}

// ── The tour ────────────────────────────────────────────────────────────────

export function FeatureTour({
  visible,
  onDone,
}: {
  visible: boolean;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    if (visible) setIndex(0);
  }, [visible]);

  // Jump to the tab that carries this feature so the arrow lands on
  // something real.
  useEffect(() => {
    if (!visible) return;
    goToTab(SLIDES[index].tab);
  }, [visible, index]);

  const slide = SLIDES[index];
  const isLast = index === SLIDES.length - 1;
  const start = { textAlign: alignStart() } as const;

  const advance = () => {
    Haptics.selectionAsync();
    if (isLast) {
      onDone();
      return;
    }
    setIndex((i) => Math.min(i + 1, SLIDES.length - 1));
  };

  // ── Where the arrow tip lands, and which way the callout opens ─────────
  const rtl = isRTL();
  const p = slide.pointer;
  let tipX = 0;
  let tipY = 0;
  let pointsDown = false;

  if (p.kind === 'topEnd') {
    const inset = p.offsetInset ?? 40;
    tipX = rtl ? inset + 20 : width - inset - 20;
    tipY = (insets.top || 20) + (p.offsetTop ?? 40);
    pointsDown = false;
  } else if (p.kind === 'topStart') {
    const inset = p.offsetInset ?? 40;
    tipX = rtl ? width - inset - 20 : inset + 20;
    tipY = (insets.top || 20) + (p.offsetTop ?? 40);
    pointsDown = false;
  } else if (p.kind === 'midStart') {
    tipX = rtl ? width - 60 : 60;
    tipY = p.offsetTop ?? Math.round(height * 0.35);
    pointsDown = false;
  } else {
    // bottomCenter — the mic FAB sits at the bottom, so the callout comes in
    // from above and the arrow flips over to point down.
    tipX = width / 2;
    tipY = height - (p.offsetBottom ?? 60);
    pointsDown = true;
  }

  // ── The callout's own box ─────────────────────────────────────────────
  const CALLOUT_WIDTH = Math.min(280, width - 32);
  const arrowW = ARROW_HEAD * 2 + 4;

  // The arrow is one child of the callout; its tail is where the card meets
  // it. We position the whole callout so the arrow's TIP lands on (tipX,
  // tipY), with the card either below (arrow up) or above (arrow down).
  let calloutLeft = tipX - CALLOUT_WIDTH / 2;
  calloutLeft = Math.max(16, Math.min(calloutLeft, width - CALLOUT_WIDTH - 16));
  const calloutTop = pointsDown ? tipY - ARROW_LEN - 260 : tipY;

  // Which side of the callout the arrow sits on, so the arrow lines up with
  // (tipX, tipY) even when the card was shifted to stay on screen.
  const arrowLeftInsideCallout = tipX - calloutLeft - arrowW / 2;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => onDone()}
    >
      {/* One big tap zone: pressing anywhere on the page advances. The card
          sits above it and stops taps from double-firing. */}
      <Pressable
        onPress={advance}
        style={styles.scrim}
        accessibilityRole="button"
        accessibilityLabel={t('tour.next')}
      >
        <View />
      </Pressable>

      {/* Skip: closes the tour without opting out. Sits above the scrim so
          its own tap does not also advance. */}
      <View style={[styles.skipRow, { top: insets.top + 6 }]} pointerEvents="box-none">
        <Pressable
          onPress={() => {
            Haptics.selectionAsync();
            onDone();
          }}
          style={({ pressed }) => [styles.skipBtn, pressed && styles.dim]}
          accessibilityRole="button"
          accessibilityLabel={t('tour.skip')}
        >
          <X color={colors.text} size={18} strokeWidth={2.2} />
        </Pressable>
      </View>

      {/* The callout itself: a short label with the arrow attached. Advances
          on its own tap too, so the reader never has to hunt for a button. */}
      <View
        pointerEvents="box-none"
        style={[styles.calloutWrap, { left: calloutLeft, top: calloutTop, width: CALLOUT_WIDTH, direction: isRTL() ? 'rtl' : 'ltr' }]}
      >
        {pointsDown ? (
          // Card first, then arrow beneath pointing down at the target.
          <View>
            <Pressable
              onPress={advance}
              style={styles.card}
              accessibilityRole="button"
              accessibilityLabel={t('tour.next')}
            >
              <CardContent slide={slide} index={index} isLast={isLast} start={start} />
            </Pressable>
            <View style={[styles.arrowSlot, { marginStart: arrowLeftInsideCallout }]}>
              <CleanArrow pointsDown />
            </View>
          </View>
        ) : (
          // Arrow first, pointing up at the target, then card underneath.
          <View>
            <View style={[styles.arrowSlot, { marginStart: arrowLeftInsideCallout }]}>
              <CleanArrow pointsDown={false} />
            </View>
            <Pressable
              onPress={advance}
              style={styles.card}
              accessibilityRole="button"
              accessibilityLabel={t('tour.next')}
            >
              <CardContent slide={slide} index={index} isLast={isLast} start={start} />
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

/** The card's body: a small header, the shorter caption, pips at the foot. */
function CardContent({
  slide,
  index,
  isLast,
  start,
}: {
  slide: Slide;
  index: number;
  isLast: boolean;
  start: { textAlign: 'left' | 'right' };
}) {
  return (
    <>
      <View style={styles.cardHead}>
        <LinearGradient
          colors={slide.discColours}
          start={{ x: 0.15, y: 0.1 }}
          end={{ x: 0.85, y: 0.95 }}
          style={styles.disc}
        >
          <slide.Icon color={NIGHT.glyph} size={18} strokeWidth={2.2} />
        </LinearGradient>
        <Text style={[styles.kicker, start]}>
          {index + 1} / {SLIDES.length}
        </Text>
      </View>
      <Fade trigger={index}>
        <Text style={[styles.title, start]}>{t(slide.titleKey)}</Text>
        <Text style={[styles.body, start]}>{t(slide.bodyKey)}</Text>
      </Fade>
      <View style={styles.foot}>
        <Pips count={SLIDES.length} index={index} />
        <Text style={styles.tapHint}>{isLast ? t('tour.done') : t('tour.tap')}</Text>
      </View>
    </>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = themed(() =>
  StyleSheet.create({
    scrim: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.55)',
    },

    skipRow: {
      position: 'absolute',
      insetInlineEnd: 12,
      zIndex: 4,
    },
    skipBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.22)',
    },
    dim: { opacity: 0.7 },

    calloutWrap: { position: 'absolute', zIndex: 3 },
    arrowSlot: { width: ARROW_HEAD * 2 + 4 },

    card: {
      backgroundColor: NIGHT.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.14)',
      borderRadius: 18,
      padding: 14,
      // Card sits on the dark scrim, so it needs its own weight.
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 8,
    },
    cardHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 6,
    },
    disc: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    kicker: {
      fontSize: 11,
      ...font(600),
      color: colors.textMuted,
      letterSpacing: 0.6,
    },
    title: {
      fontSize: 17,
      lineHeight: 21,
      ...font(700),
      color: colors.text,
      letterSpacing: -0.3,
      marginBottom: 4,
    },
    body: {
      fontSize: 13,
      lineHeight: 18,
      ...font(500),
      color: colors.textMuted,
    },

    foot: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 10,
    },
    pips: { flexDirection: 'row', gap: 5, alignItems: 'center' },
    pip: { width: 5, height: 5, borderRadius: 3, backgroundColor: NIGHT.cardAlt },
    pipOn: { backgroundColor: colors.primary, width: 14 },
    tapHint: {
      fontSize: 11,
      ...font(600),
      color: colors.textMuted,
    },
  }),
);
