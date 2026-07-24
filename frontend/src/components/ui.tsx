import { ReactNode } from 'react';
import {
  Text,
  View,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  TextInput,
  TextInputProps,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  colors,
  radius,
  spacing,
  GRADIENT_BACKGROUND,
  ACCENT_GRADIENT,
  TAB_BAR_CLEARANCE,
} from '../theme';

export function Screen({ children }: { children: ReactNode }) {
  return (
    <LinearGradient
      colors={GRADIENT_BACKGROUND.colors as unknown as [string, string, ...string[]]}
      locations={GRADIENT_BACKGROUND.locations as unknown as [number, number, ...number[]]}
      start={GRADIENT_BACKGROUND.start}
      end={GRADIENT_BACKGROUND.end}
      style={styles.screen}
    >
      <View style={styles.screenInner}>{children}</View>
    </LinearGradient>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
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

  // Primary buttons get the purple→pink gradient; danger a warm gradient;
  // ghost is a translucent glass pill with a light border.
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
    variant === 'danger'
      ? (['#F2A7C6', '#E8607A'] as const)
      : ACCENT_GRADIENT.colors;

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
  screenInner: { flex: 1, padding: spacing.md, paddingBottom: TAB_BAR_CLEARANCE },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.06,
    shadowRadius: 18,
    elevation: 4,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: spacing.sm },
  muted: { color: colors.textMuted, fontSize: 14 },
  buttonWrap: { borderRadius: 50, marginBottom: 0 },
  button: {
    borderRadius: 50,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  ghost: {
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonText: { color: colors.primaryText, fontWeight: '600', fontSize: 16 },
  label: { color: colors.text, marginBottom: spacing.xs, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    borderRadius: radius.md,
    padding: spacing.md - 2,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
