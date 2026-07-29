import { ReactNode, useState } from 'react';
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
import {
  colors,
  radius,
  spacing,
  font,
  GRADIENT_BACKGROUND,
  BACKGROUND_BLOOMS,
  ACCENT_GRADIENT,
  TAB_BAR_CLEARANCE,
} from '../theme';

// Soft-edged radial color blooms painted over the base ramp. Each bloom fades
// to fully transparent at its edge so overlapping circles read as one wash
// rather than as distinct discs.
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
  const insets = useSafeAreaInsets();
  // Blooms are painted in absolute pixels, so they need the measured box.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    );
  };

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
      <View
        style={[
          styles.screenInner,
          {
            paddingTop: Math.max(insets.top, spacing.md) + spacing.xs,
            paddingBottom: clearTabBar ? TAB_BAR_CLEARANCE : spacing.lg,
            // Declared explicitly rather than left to inherit: on web
            // react-native-web's I18nManager is a no-op, so this is what makes
            // rows, text alignment, and logical margins mirror. Native reads
            // I18nManager, and this agrees with it.
            direction: isRTL() ? 'rtl' : 'ltr',
          },
        ]}
      >
        {children}
      </View>
    </LinearGradient>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
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
  const content = loading ? (
    <ActivityIndicator color={variant === 'ghost' ? colors.text : colors.primaryText} />
  ) : (
    <Text style={[styles.buttonText, variant === 'ghost' && { color: colors.text }]}>{label}</Text>
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
    variant === 'danger' ? (['#F08A8D', '#E5484D'] as const) : ACCENT_GRADIENT.colors;

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
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.textMuted} style={[styles.input, style]} {...rest} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenInner: { flex: 1, paddingHorizontal: spacing.md + 4 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg - 4,
    padding: spacing.md + 4,
    marginBottom: spacing.md,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 3,
  },
  title: { color: colors.text, fontSize: 18, ...font(600), marginBottom: spacing.sm },
  muted: { color: colors.textMuted, fontSize: 14, ...font(400) },
  buttonWrap: { borderRadius: 50 },
  button: {
    borderRadius: 50,
    paddingVertical: 18,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 58,
  },
  ghost: {
    backgroundColor: colors.surface,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  buttonText: { color: colors.primaryText, ...font(600), fontSize: 15 },
  label: {
    color: colors.text,
    marginBottom: spacing.sm,
    fontSize: 15,
    ...font(500),
  },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 16,
    fontSize: 15,
    ...font(400),
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
});
