import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Text,
  View,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  TextInputProps,
  StyleProp,
  ViewStyle,
  ViewProps,
  TextStyle,
  Image,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { Bell, Sun, Moon } from 'lucide-react-native';

import { Entrance, PageReveal, Pressable, useBreathe, useReducedMotion } from './motion';
import { isRTL, t } from '../lib/i18n';
import { getAppearance, setAppearance } from '../lib/appearance';
import { colors, radius, spacing, font, NIGHT, SWEEP_TEXT, themed } from '../theme';

/**
 * Two soft pools of blue on the black: a bright one behind the head of the
 * page, a faint one lower down on the other side. It is what keeps the cards
 * reading as lifted — over flat black they are just grey boxes.
 *
 * The gradients' ids are made per instance. On the web every mounted screen's
 * svg shares one document, and `url(#id)` finds the first element with that
 * id — which, under a modal, belongs to a screen the stack has hidden, and a
 * gradient inside a hidden subtree paints nothing. Settings, the form and the
 * assistant all opened on flat black until the ids stopped colliding.
 */
export function Glow() {
  const { width: w, height: h } = useWindowDimensions();
  // useId's own characters are not all legal in a url(#…) reference.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <Svg pointerEvents="none" width={w} height={h} style={styles.glow}>
      <Defs>
        <RadialGradient
          id={`glowHead${uid}`}
          gradientUnits="userSpaceOnUse"
          cx={w * 0.88}
          cy={h * 0.3}
          r={w * 0.8}
        >
          <Stop offset="0" stopColor={NIGHT.glow} stopOpacity={0.55} />
          <Stop offset="1" stopColor={NIGHT.glow} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient
          id={`glowLow${uid}`}
          gradientUnits="userSpaceOnUse"
          cx={w * 0.05}
          cy={h * 0.62}
          r={w * 0.7}
        >
          <Stop offset="0" stopColor={NIGHT.glow} stopOpacity={0.3} />
          <Stop offset="1" stopColor={NIGHT.glow} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={w} height={h} fill={`url(#glowHead${uid})`} />
      <Rect width={w} height={h} fill={`url(#glowLow${uid})`} />
    </Svg>
  );
}

/**
 * The page every screen stands on: the dark, the glow over it, and the safe
 * area kept clear.
 *
 * The ground is painted here rather than by each screen's own content,
 * because the safe-area inset lives on this view: anything a child draws
 * starts below the notch and leaves a band of another colour above it.
 */
export function Screen({
  children,
  clearTabBar = true,
}: {
  children: ReactNode;
  /**
   * Whether the page sits under the floating tab bar. Modals pass false.
   *
   * Under the bar the page runs to the bottom of the device, and the screen's
   * own scroll pads its end by `TAB_BAR_CLEARANCE` instead. Padding the page
   * itself stopped every list at a hard edge above the bar, with a band of
   * empty dark under it; this way rows pass under the bar the way Home's do,
   * and the last one can still be scrolled clear of it.
   */
  clearTabBar?: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop: Math.max(insets.top, spacing.md) + spacing.xs,
          paddingBottom: clearTabBar ? 0 : spacing.lg,
          // Declared explicitly rather than left to inherit: on web
          // react-native-web's I18nManager is a no-op, so this is what makes
          // rows, text alignment, and logical margins mirror. Native reads
          // I18nManager, and this agrees with it.
          direction: isRTL() ? 'rtl' : 'ltr',
        },
      ]}
    >
      <Glow />
      {/* The glow stays put; the page itself lifts in every time it opens. */}
      <PageReveal>{children}</PageReveal>
    </View>
  );
}

/**
 * Type painted with the sweep — blue into green into yellow — instead of set
 * in one colour. For the one word a headline leans on, and nothing else.
 *
 * The sweep drifts: it slides slowly one way and back, so the word looks lit
 * rather than printed. The gradient is laid out twice as wide as the word —
 * blue, green, yellow, green, blue — and moved across it, so at rest either end
 * of the swing is a clean sweep in one direction or the other.
 *
 * On a phone the word is a mask over that moving gradient; the word is laid
 * out a second time, transparent, to give the mask its exact size. The masked
 * view does nothing on the web — it renders the mask as plain text — so there
 * the same paint is done with CSS, which clips a background to the glyphs and
 * slides the background with a keyframe animation.
 */
export function SweepText({
  children,
  style,
}: {
  children: string;
  style?: StyleProp<TextStyle>;
}) {
  const reduce = useReducedMotion();
  const [width, setWidth] = useState(0);
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduce || Platform.OS === 'web') {
      drift.setValue(0);
      return;
    }
    const swing = (toValue: number) =>
      Animated.timing(drift, {
        toValue,
        duration: SWEEP_DRIFT_MS,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      });
    const anim = Animated.loop(Animated.sequence([swing(1), swing(0)]));
    anim.start();
    return () => anim.stop();
  }, [reduce, drift]);

  if (Platform.OS === 'web') {
    const sheet = webSweep as unknown as { still: TextStyle; drifting: TextStyle };
    return <Text style={[style, sheet.still, !reduce && sheet.drifting]}>{children}</Text>;
  }
  const w = Math.max(width, 1);
  return (
    <MaskedView maskElement={<Text style={style}>{children}</Text>}>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <Text style={[style, styles.ghost]}>{children}</Text>
        <Animated.View
          style={[
            styles.sweepTrack,
            {
              width: w * 2,
              transform: [{ translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -w] }) }],
            },
          ]}
        >
          <LinearGradient
            colors={sweepLoop()}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
    </MaskedView>
  );
}

/** One swing of the drift, each way. Slow: it is a light moving, not a sign blinking. */
const SWEEP_DRIFT_MS = 3400;

/**
 * The sweep and its mirror, end to end, so the drift can slide across both.
 * Built when asked for: the word's stops are deeper on white than on the dark.
 */
const sweepLoop = () =>
  [SWEEP_TEXT[0], SWEEP_TEXT[1], SWEEP_TEXT[2], SWEEP_TEXT[1], SWEEP_TEXT[0]] as const;

/**
 * The same paint for a browser: a background clipped to the glyphs, twice the
 * word's width, slid across it by a keyframe animation.
 *
 * Built with `StyleSheet.create` and not as an inline object on purpose:
 * react-native-web compiles `animationKeyframes` into a real @keyframes rule
 * only for a created sheet, and silently drops it from an inline style — the
 * word sat painted and perfectly still. None of these properties exist in React
 * Native's style types, and none of them mean anything on a phone, so the sheet
 * is only made on the web — and made again for each scheme, whose stops differ.
 */
const webSweep = themed(() =>
  Platform.OS === 'web'
    ? StyleSheet.create({
        still: {
          backgroundImage: `linear-gradient(90deg, ${sweepLoop().join(', ')})`,
          backgroundSize: '200% 100%',
          backgroundPosition: '0% 50%',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        },
        drifting: {
          animationKeyframes: [
            { '0%': { backgroundPosition: '0% 50%' }, '100%': { backgroundPosition: '100% 50%' } },
          ],
          animationDuration: `${SWEEP_DRIFT_MS}ms`,
          animationTimingFunction: 'ease-in-out',
          animationDirection: 'alternate',
          animationIterationCount: 'infinite',
        },
      } as never)
    : ({} as never),
);

/**
 * A lit disc behind a glyph: the gradient circle the counts on Home stand on.
 * Its glow is its own darker stop. Put a glyph in `NIGHT.glyph` inside it.
 */
export function LitDisc({
  colors: stops,
  size = 34,
  children,
  style,
}: {
  colors: readonly [string, string, ...string[]];
  size?: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        styles.discWrap,
        { borderRadius: size / 2, shadowColor: stops[stops.length - 1] },
        style,
      ]}
    >
      <LinearGradient
        colors={stops}
        start={{ x: 0.15, y: 0.1 }}
        end={{ x: 0.85, y: 0.95 }}
        style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }]}
      >
        {children}
      </LinearGradient>
    </View>
  );
}

/**
 * The greeting row Home, Calendar and Settings share: photo, the greeting,
 * and a bell carrying an unread dot.
 */
export function GreetingHeader({
  name,
  photoUri,
  onBellPress,
  onAppearancePress,
  unread = true,
  onLayout,
  style,
}: {
  name: string;
  photoUri?: string;
  onBellPress?: () => void;
  onAppearancePress?: () => void;
  unread?: boolean;
  /** Reports the row's height, for a screen placing something under it. */
  onLayout?: ViewProps['onLayout'];
  style?: StyleProp<ViewStyle>;
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'U';
  // Something unread is waiting, so the dot says so gently rather than sitting there.
  const pulse = useBreathe(1, 1.3, 1200, 600);

  return (
    <View style={[styles.greetingRow, style]} onLayout={onLayout}>
      <View style={styles.avatar}>
        <Text style={styles.avatarInitials}>{initials}</Text>
        {photoUri ? <Image source={{ uri: photoUri }} style={styles.avatarPhoto} /> : null}
      </View>
      <Text
        style={[styles.greetingText, { textAlign: isRTL() ? 'right' : 'left' }]}
        numberOfLines={1}
      >
        {name}
      </Text>
      <Pressable
        onPress={onBellPress}
        style={({ pressed }) => [styles.bellBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={t('profile.notifications')}
      >
        <Bell color={colors.text} size={23} strokeWidth={1.9} />
        {/* Named physically: react-native-web resolves a logical inset from its
            own direction, which the document's `dir` never reaches. */}
        {unread ? (
          <Animated.View
            style={[styles.bellDot, isRTL() ? { left: 1 } : { right: 1 }, { transform: [{ scale: pulse }] }]}
          />
        ) : null}
      </Pressable>
      <Pressable
        onPress={onAppearancePress ?? (() => void setAppearance(getAppearance() === 'dark' ? 'light' : 'dark'))}
        style={({ pressed }) => [styles.bellBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={t(getAppearance() === 'dark' ? 'profile.switchToLight' : 'profile.switchToDark')}
      >
        {getAppearance() === 'dark'
          ? <Sun color={colors.text} size={23} strokeWidth={1.9} />
          : <Moon color={colors.text} size={23} strokeWidth={1.9} />}
      </Pressable>
    </View>
  );
}

/**
 * A card, which arrives rather than appearing.
 *
 * The entrance lives here rather than at each call site because every screen
 * that uses `Card` wants the same thing — a stack that builds in reading order
 * — and wiring it per card is the kind of thing that gets done on four of six.
 * `delay` staggers a stack; pass 0 to have one land immediately.
 */
export function Card({
  children,
  style,
  delay = 0,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  delay?: number;
}) {
  return (
    <Entrance delay={delay} from={18}>
      <View style={[styles.card, style]}>{children}</View>
    </Entrance>
  );
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

/**
 * The primary button is the app's blue, lit from the top — the same fill as
 * the chosen day on Home. The quiet ones are a step off the page.
 */
export function Button({
  label,
  onPress,
  loading,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const primary = variant === 'primary';
  const content = loading ? (
    <ActivityIndicator color={colors.text} />
  ) : (
    <Text style={[styles.buttonText, variant === 'danger' && { color: colors.danger }]}>
      {label}
    </Text>
  );

  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(loading), busy: Boolean(loading) }}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonQuiet,
        { opacity: pressed || loading ? 0.75 : 1 },
      ]}
    >
      {primary ? (
        <LinearGradient
          colors={NIGHT.blue}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          // Rounded itself rather than clipped by the button: clipping on iOS
          // takes the button's glow with it.
          style={[StyleSheet.absoluteFill, styles.buttonFill]}
        />
      ) : null}
      {content}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textMuted}
        selectionColor={NIGHT.blue[0]}
        style={[styles.input, style]}
        {...rest}
      />
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.bg,
      paddingHorizontal: spacing.md + 4,
    },
    glow: { position: 'absolute', top: 0, left: 0 },
    pressed: { opacity: 0.72 },
    /** Sizes the gradient without painting over it. */
    ghost: { opacity: 0 },
    /** The moving gradient behind a swept word, twice its width. */
    sweepTrack: { position: 'absolute', top: 0, bottom: 0, left: 0 },

    discWrap: {
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.45,
      shadowRadius: 8,
    },
    disc: { alignItems: 'center', justifyContent: 'center' },

    greetingRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: spacing.sm },
    avatar: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: NIGHT.cardAlt,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    avatarInitials: { ...font(700), fontSize: 18, color: colors.text },
    avatarPhoto: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      height: '100%',
    },
    greetingText: { flex: 1, fontSize: 21, ...font(600), color: colors.text, letterSpacing: -0.3 },
    bellBtn: {
      width: 50,
      height: 50,
      borderRadius: 25,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bellDot: {
      position: 'absolute',
      top: 1,
      width: 11,
      height: 11,
      borderRadius: 5.5,
      backgroundColor: NIGHT.alert,
    },

    /** Glass: white at a whisper over the page, so the glow shows through. */
    card: {
      backgroundColor: NIGHT.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: radius.lg,
      padding: spacing.md + 2,
      marginBottom: spacing.md,
    },
    title: {
      color: colors.text,
      fontSize: 18,
      ...font(700),
      marginBottom: spacing.sm,
    },
    muted: { color: colors.textMuted, fontSize: 14, ...font(500) },

    button: {
      borderRadius: 100,
      paddingVertical: 18,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 58,
    },
    buttonFill: { borderRadius: 100 },
    buttonPrimary: {
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.45,
      shadowRadius: 14,
      elevation: 6,
    },
    buttonQuiet: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    buttonText: { color: colors.text, ...font(600), fontSize: 16 },
    label: {
      color: colors.text,
      marginBottom: spacing.sm,
      fontSize: 15,
      ...font(600),
    },
    input: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      color: colors.text,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 16,
      fontSize: 15,
      ...font(400),
    },
  }),
);
