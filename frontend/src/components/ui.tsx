import { ReactNode } from 'react';
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
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  colors,
  radius,
  spacing,
  GRADIENT_BACKGROUND,
  ACCENT_GRADIENT,
  TAB_BAR_CLEARANCE,
} from '../theme';

export function Screen({
  children,
  clearTabBar = true,
}: {
  children: ReactNode;
  // Modals (no tab bar) pass false to skip the extra bottom clearance.
  clearTabBar?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <LinearGradient
      colors={GRADIENT_BACKGROUND.colors as unknown as [string, string, ...string[]]}
      locations={GRADIENT_BACKGROUND.locations as unknown as [number, number, ...number[]]}
      start={GRADIENT_BACKGROUND.start}
      end={GRADIENT_BACKGROUND.end}
      style={styles.screen}
    >
      <View
        style={[
          styles.screenInner,
          {
            paddingTop: Math.max(insets.top, spacing.md) + spacing.xs,
            paddingBottom: clearTabBar ? TAB_BAR_CLEARANCE : spacing.lg,
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
  title: { color: colors.text, fontSize: 18, fontWeight: '600', marginBottom: spacing.sm },
  muted: { color: colors.textMuted, fontSize: 14, fontWeight: '400' },
  buttonWrap: { borderRadius: 50 },
  button: {
    borderRadius: 50,
    paddingVertical: 16,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  ghost: {
    backgroundColor: colors.surface,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  buttonText: { color: colors.primaryText, fontWeight: '600', fontSize: 15 },
  label: {
    color: colors.text,
    marginBottom: spacing.sm,
    fontSize: 15,
    fontWeight: '500',
  },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 15,
    fontWeight: '400',
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
});
