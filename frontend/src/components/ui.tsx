import { ReactNode, useMemo, useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  TextInput,
  TextInputProps,
  StyleProp,
  ViewStyle,
  TextStyle,
  type LayoutChangeEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isRTL } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import {
  radius,
  spacing,
  font,
  cardStyle,
  GRADIENT_BACKGROUND,
  BACKGROUND_BLOOMS,
  ACCENT_GRADIENT,
  TAB_BAR_CLEARANCE,
  type Palette,
} from '../theme';

// Soft-edged radial colour blooms painted over the light base ramp. Each bloom
// fades to fully transparent at its edge so overlapping circles read as one
// wash rather than as distinct discs. The dark theme does not use these — a
// bloom over near-black reads as a smudge, and the reference ground is flat.
function BackgroundBlooms({ width, height }: { width: number; height: number }) {
  return (
    <Svg
      style={StyleSheet.absoluteFillObject}
      width={width}
      height={height}
      pointerEvents="none"
    >
      <Defs>
        {BACKGROUND_BLOOMS.map((b, i) => (
          <RadialGradient key={i} id={`bloom${i}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={b.color} stopOpacity={b.opacity} />
            <Stop offset="55%" stopColor={b.color} stopOpacity={b.opacity * 0.45} />
            <Stop offset="100%" stopColor={b.color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {BACKGROUND_BLOOMS.map((b, i) => {
        // Blooms are sized off width so their aspect stays circular.
        const d = width * b.size;
        return (
          <Rect
            key={i}
            x={b.x * width}
            y={b.y * height}
            width={d}
            height={d}
            fill={`url(#bloom${i})`}
          />
        );
      })}
    </Svg>
  );
}

export function Screen({
  children,
  clearTabBar = true,
}: {
  children: ReactNode;
  // Modals (no tab bar) pass false to skip the extra bottom clearance.
  clearTabBar?: boolean;
}) {
  const { palette: c } = useTheme();
  const insets = useSafeAreaInsets();

  // Blooms are painted in absolute pixels, so they need the measured box.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    );
  };

  const inner = [
    styles.screenInner,
    {
      paddingTop: Math.max(insets.top, spacing.md) + spacing.xs,
      paddingBottom: clearTabBar ? TAB_BAR_CLEARANCE : spacing.lg,
      // Declared explicitly rather than left to inherit: on web
      // react-native-web's I18nManager is a no-op, so this is what makes rows,
      // text alignment, and logical margins mirror. Native reads I18nManager,
      // and this agrees with it.
      direction: (isRTL() ? 'rtl' : 'ltr') as 'rtl' | 'ltr',
    },
  ];

  if (c.mode === 'dark') {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]} onLayout={onLayout}>
        <View style={inner}>{children}</View>
      </View>
    );
  }

  return (
    <LinearGradient
      colors={GRADIENT_BACKGROUND.colors as unknown as [string, string, ...string[]]}
      locations={GRADIENT_BACKGROUND.locations as unknown as [number, number, ...number[]]}
      start={GRADIENT_BACKGROUND.start}
      end={GRADIENT_BACKGROUND.end}
      style={styles.screen}
      onLayout={onLayout}
    >
      {size.width > 0 ? <BackgroundBlooms width={size.width} height={size.height} /> : null}
      <View style={inner}>{children}</View>
    </LinearGradient>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { palette: c } = useTheme();
  return <View style={[cardStyle(c), style]}>{children}</View>;
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const { palette: c } = useTheme();
  return (
    <Text
      style={[
        { color: c.text, fontSize: 18, marginBottom: spacing.sm, textAlign: 'auto' },
        font(600),
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const { palette: c } = useTheme();
  return (
    <Text style={[{ color: c.textMuted, fontSize: 14, textAlign: 'auto' }, font(400), style]}>
      {children}
    </Text>
  );
}

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
  const { palette: c } = useTheme();
  const styles = useMemo(() => makeButtonStyles(c), [c]);

  const content = loading ? (
    <ActivityIndicator color={variant === 'ghost' ? c.text : c.onAccent} />
  ) : (
    <Text style={[styles.buttonText, variant === 'ghost' && { color: c.text }]}>{label}</Text>
  );

  if (variant === 'ghost') {
    return (
      <Pressable
        onPress={onPress}
        disabled={loading}
        style={({ pressed }) => [
          styles.button,
          styles.ghost,
          { opacity: pressed || loading ? 0.7 : 1 },
        ]}
      >
        {content}
      </Pressable>
    );
  }

  const gradientColors =
    variant === 'danger' ? ([c.danger, '#D93B45'] as const) : ACCENT_GRADIENT.colors;

  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [styles.buttonWrap, { opacity: pressed || loading ? 0.85 : 1 }]}
    >
      <LinearGradient
        colors={gradientColors as unknown as [string, string, ...string[]]}
        start={ACCENT_GRADIENT.start}
        end={ACCENT_GRADIENT.end}
        style={styles.button}
      >
        {content}
      </LinearGradient>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { palette: c } = useTheme();
  const styles = useMemo(() => makeButtonStyles(c), [c]);
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput placeholderTextColor={c.textMuted} style={[styles.input, style]} {...rest} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenInner: { flex: 1, paddingHorizontal: spacing.md + 4 },
});

function makeButtonStyles(c: Palette) {
  return StyleSheet.create({
    buttonWrap: { borderRadius: radius.pill },
    button: {
      borderRadius: radius.pill,
      paddingVertical: 18,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 58,
    },
    ghost: {
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    buttonText: { color: c.onAccent, ...font(600), fontSize: 15 },
    label: {
      color: c.text,
      marginBottom: spacing.sm,
      fontSize: 15,
      textAlign: 'auto',
      ...font(500),
    },
    input: {
      backgroundColor: c.surfaceAlt,
      color: c.text,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 16,
      fontSize: 15,
      textAlign: 'auto',
      borderWidth: 1,
      borderColor: c.border,
      ...font(400),
    },
  });
}
