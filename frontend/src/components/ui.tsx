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
  ViewProps,
  TextStyle,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bell } from 'lucide-react-native';

import { Entrance } from './motion';
import { isRTL } from '../lib/i18n';
import { colors, radius, spacing, font, BAND, TAB_BAR_CLEARANCE } from '../theme';

/**
 * Where the dark ends on the very first frame, before the card has measured
 * itself and said where its top edge really is.
 *
 * The computed seam on a normal phone: 4 + 16 of padding, the 46 greeting
 * row, the rail's 8 + 12 + 74 + 12, and the card's own 8 margin. One frame
 * later the real number replaces it.
 */
const BAND_DEPTH = 180;

export function Screen({
  children,
  clearTabBar = true,
  topBand = false,
  bandBottom,
}: {
  children: ReactNode;
  // Modals (no tab bar) pass false to skip the extra bottom clearance.
  clearTabBar?: boolean;
  /**
   * Lays a dark ground under the top of the page, status bar included.
   *
   * The child lays a white card over it, and the dark has to still be there
   * *behind* that card's two rounded top corners — that is what turns the
   * join into a curve rather than a line.
   *
   * It is a layer with a fixed depth rather than the page's own background.
   * Painting the whole page dark makes every pixel the card fails to cover
   * show black: past its bottom edge, and either side of it if a margin is a
   * pixel out. Bounded, the dark can only ever appear where it is wanted, and
   * everything the card misses falls back to paper.
   *
   * It has to be set here rather than by the screen's own content, because
   * the safe-area inset lives on this view: anything a child draws starts
   * below the notch and leaves a pale band above it.
   */
  topBand?: boolean;
  /**
   * Where the white card's top edge sits, in dp from the top of this view.
   *
   * The dark is drawn to exactly this height, so the two cannot drift apart.
   * A constant was wrong the moment anything above the card changed size: it
   * carried 80px of overshoot that showed either side of the card — which is
   * inside the page's padding, while the dark layer spans the full width — as
   * a hard line across the screen.
   */
  bandBottom?: number;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.screen,
        topBand && styles.screenBanded,
        {
          paddingTop: Math.max(insets.top, spacing.md) + spacing.xs,
          // None when a card is going to cover the bottom itself.
          paddingBottom: topBand ? 0 : clearTabBar ? TAB_BAR_CLEARANCE : spacing.lg,
          // Declared explicitly rather than left to inherit: on web
          // react-native-web's I18nManager is a no-op, so this is what makes
          // rows, text alignment, and logical margins mirror. Native reads
          // I18nManager, and this agrees with it.
          direction: isRTL() ? 'rtl' : 'ltr',
        },
      ]}
    >
      {topBand ? (
        <View
          pointerEvents="none"
          style={[
            styles.band,
            // Exactly to the card's top edge. Until the card has measured
            // itself, the computed seam stands in for one frame.
            {
              height:
                bandBottom ?? Math.max(insets.top, spacing.md) + BAND_DEPTH,
            },
          ]}
        />
      ) : null}
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
  onDark = false,
  onLayout,
}: {
  name: string;
  photoUri?: string;
  onBellPress?: () => void;
  unread?: boolean;
  /** Flips the row to light ink for a screen whose head is the dark band. */
  onDark?: boolean;
  /** Reports the row's height, for a screen placing the seam under it. */
  onLayout?: ViewProps['onLayout'];
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'U';

  return (
    <View style={styles.greetingRow} onLayout={onLayout}>
      <View style={[styles.avatar, onDark && styles.avatarOnDark]}>
        <Text style={[styles.avatarInitials, onDark && styles.inkOnDark]}>{initials}</Text>
        {photoUri ? <Image source={{ uri: photoUri }} style={styles.avatarPhoto} /> : null}
      </View>
      <Text style={[styles.greetingText, onDark && styles.inkOnDark]} numberOfLines={1}>
        {name}
      </Text>
      <Pressable
        onPress={onBellPress}
        style={[styles.bellBtn, onDark && styles.bellBtnOnDark]}
        accessibilityRole="button"
      >
        <Bell color={onDark ? BAND.ink : colors.text} size={20} />
        {unread ? <View style={styles.bellDot} /> : null}
      </Pressable>
    </View>
  );
}

/**
 * A white block, which arrives rather than appearing.
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
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.md + 4,
  },
  /**
   * The page under a banded screen is the card's own white, not the app's
   * off-white. Anything the card leaves uncovered then reads as more card
   * rather than as a faint cream seam beside it.
   */
  screenBanded: { backgroundColor: colors.surface },
  /**
   * Behind everything, and out past the page's own side padding so it reaches
   * the screen edges the way the card over it does.
   */
  band: {
    position: 'absolute',
    top: 0,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    backgroundColor: BAND.bg,
  },

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
  avatarPhoto: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  greetingText: { flex: 1, fontSize: 19, ...font(700), color: colors.text },
  /** Type and glyphs once the row is standing on the band. */
  inkOnDark: { color: BAND.ink },
  avatarOnDark: { backgroundColor: BAND.line },
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
  /** On the band the button is a hole in it, not a white disc floating over it. */
  bellBtnOnDark: {
    backgroundColor: BAND.line,
    shadowOpacity: 0,
    elevation: 0,
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
  buttonPrimary: { backgroundColor: colors.primary },
  buttonQuiet: { backgroundColor: colors.surface },
  buttonText: { color: colors.primaryText, ...font(600), fontSize: 16 },
  label: {
    color: colors.text,
    marginBottom: spacing.sm,
    fontSize: 15,
    ...font(600),
  },
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
