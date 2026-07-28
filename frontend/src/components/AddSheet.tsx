import { View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Keyboard, Mic, X } from 'lucide-react-native';

import { colors, spacing, font, ACCENT_GRADIENT } from '../theme';

/**
 * Bottom sheet shown by the + button: type it yourself, or talk to the
 * assistant. Rendered as a Modal so it floats above the tab bar.
 */
export function AddSheet({
  visible,
  onClose,
  onManual,
  onAssistant,
}: {
  visible: boolean;
  onClose: () => void;
  onManual: () => void;
  onAssistant: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Tapping the scrim dismisses; the card swallows its own taps. */}
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />

          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>
                How would you like{'\n'}
                <Text style={styles.titleStrong}>to add this?</Text>
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
              <X color={colors.textMuted} size={18} />
            </Pressable>
          </View>

          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onAssistant();
            }}
            style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
          >
            <LinearGradient
              colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
              start={ACCENT_GRADIENT.start}
              end={ACCENT_GRADIENT.end}
              style={styles.primaryCard}
            >
              <View style={styles.primaryIcon}>
                <Mic color="#FFFFFF" size={22} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.primaryTitle}>Talk to your assistant</Text>
                <Text style={styles.primarySub}>
                  Say what you need — it fills in the details
                </Text>
              </View>
            </LinearGradient>
          </Pressable>

          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onManual();
            }}
            style={({ pressed }) => [styles.secondaryCard, { opacity: pressed ? 0.9 : 1 }]}
          >
            <View style={styles.secondaryIcon}>
              <Keyboard color={colors.primary} size={20} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.secondaryTitle}>Type it manually</Text>
              <Text style={styles.secondarySub}>Fill in the form yourself</Text>
            </View>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(25,23,33,0.42)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FBF8FE',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: spacing.md + 4,
    paddingTop: 12,
    paddingBottom: spacing.xl + 8,
    gap: 12,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(25,23,33,0.14)',
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.sm },
  title: { ...font(400), fontSize: 24, lineHeight: 31, color: colors.text, letterSpacing: -0.4 },
  titleStrong: { ...font(600) },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(25,23,33,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  primaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 22,
    padding: spacing.md + 2,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 5,
  },
  primaryIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryTitle: { ...font(600), fontSize: 16, color: '#FFFFFF' },
  primarySub: {
    ...font(400),
    fontSize: 12.5,
    color: 'rgba(255,255,255,0.82)',
    marginTop: 2,
    lineHeight: 17,
  },

  secondaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 22,
    padding: spacing.md + 2,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(136,117,246,0.16)',
  },
  secondaryIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: '#EFE7FD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryTitle: { ...font(600), fontSize: 16, color: colors.text },
  secondarySub: { ...font(400), fontSize: 12.5, color: colors.textMuted, marginTop: 2 },
});
