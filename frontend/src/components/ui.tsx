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
import { colors, radius, spacing } from '../theme';

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
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
  const bg =
    variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : 'transparent';
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: pressed || loading ? 0.7 : 1 },
        variant === 'ghost' && styles.ghostBorder,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.primaryText} />
      ) : (
        <Text style={[styles.buttonText, variant === 'ghost' && { color: colors.text }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, ...rest } = props;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        {...rest}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: spacing.sm },
  muted: { color: colors.textMuted, fontSize: 14 },
  button: {
    borderRadius: radius.sm,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  ghostBorder: { borderWidth: 1, borderColor: colors.border },
  buttonText: { color: colors.primaryText, fontWeight: '600', fontSize: 16 },
  label: { color: colors.textMuted, marginBottom: spacing.xs, fontSize: 13 },
  input: {
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    borderRadius: radius.sm,
    padding: spacing.md - 4,
    fontSize: 16,
  },
});
