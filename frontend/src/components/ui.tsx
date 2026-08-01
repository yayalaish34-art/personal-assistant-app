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
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bell } from 'lucide-react-native';

import { isRTL } from '../lib/i18n';
import { colors, radius, spacing, font, TAB_BAR_CLEARANCE } from '../theme';

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
    <View
      style={[
        styles.screen,
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
  );
}

/**
 * The greeting row Home and Calendar share: photo, "Hello, <name>!", and a
 * bell carrying an unread dot.
 */
export function GreetingHeader({
  name,
  photoUri,
  onBellPress,
  unread = true,
}: {
  name: string;
  photoUri?: string;
  onBellPress?: () => void;
  unread?: boolean;
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'U';

  return (
    <View style={styles.greetingRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarInitials}>{initials}</Text>
        {photoUri ? <Image source={{ uri: photoUri }} style={styles.avatarPhoto} /> : null}
      </View>
      <Text style={styles.greetingText} numberOfLines={1}>
        {name}
      </Text>
      <Pressable onPress={onBellPress} style={styles.bellBtn} accessibilityRole="button">
        <Bell color={colors.text} size={20} />
        {unread ? <View style={styles.bellDot} /> : null}
      </Pressable>
    </View>
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
    <ActivityIndicator color={variant === 'primary' ? colors.primaryText : colors.text} />
  ) : (
    <Text
      style={[
        styles.buttonText,
        variant === 'ghost' && { color: colors.text },
        variant === 'danger' && { color: colors.danger },
      ]}
    >
      {label}
    </Text>
  );

  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant !== 'primary' && styles.buttonQuiet,
        { opacity: pressed || loading ? 0.75 : 1 },
      ]}
    >
      {content}
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
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.md + 4 },

  greetingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarInitials: { ...font(700), fontSize: 16, color: colors.text },
  avatarPhoto: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  greetingText: { flex: 1, fontSize: 19, ...font(700), color: colors.text },
  bellBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  bellDot: {
    position: 'absolute',
    top: 9,
    insetInlineEnd: 11,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.alert,
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    marginBottom: spacing.md,
  },
  title: { color: colors.text, fontSize: 18, ...font(700), marginBottom: spacing.sm },
  muted: { color: colors.textMuted, fontSize: 14, ...font(500) },

  button: {
    borderRadius: 100,
    paddingVertical: 18,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 58,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonQuiet: { backgroundColor: colors.surface },
  buttonText: { color: colors.primaryText, ...font(600), fontSize: 16 },
  label: { color: colors.text, marginBottom: spacing.sm, fontSize: 15, ...font(600) },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 16,
    fontSize: 15,
    ...font(400),
  },
});
