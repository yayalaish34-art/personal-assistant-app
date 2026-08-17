import { useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Check } from 'lucide-react-native';

import { Button } from '../components/ui';
import {
  storage,
  defaultProfile,
  EVENT_TYPES,
  type Profile,
  type EventType,
} from '../lib/storage';
import { api } from '../lib/api';
import { colors, spacing, font, radius, TILES, TILE_INK } from '../theme';
import {
  t,
  LANGUAGES,
  getLanguage,
  setLanguage,
  isRTL,
  alignStart,
  type Language,
} from '../lib/i18n';

/**
 * The questionnaire on first launch.
 *
 * Language is asked first, and not for tidiness: every screen after it is
 * rendered in whatever was chosen, and the assistant is handed the same
 * choice. It is also the one answer that can restart the app — switching
 * between a left-to-right and a right-to-left language flips a native flag
 * that is only read when a surface starts. Asking it first means a restart
 * costs nothing, because nothing else has been answered yet.
 *
 * Every question has a usable default, and the whole thing can be skipped.
 * What comes out is a `Profile`, which rides along with every voice turn and
 * is what stops her offering a meeting in the middle of the night.
 */

type StepId = 'language' | 'name' | 'work' | 'sleep' | 'buffer' | 'types' | 'fixed';

const STEPS: StepId[] = ['language', 'name', 'work', 'sleep', 'buffer', 'types', 'fixed'];

/** Offered gaps between meetings, in minutes. */
const BUFFERS = [0, 10, 15, 30];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function hourLabel(hour: number): string {
  return t('onboarding.hour', { hour: String(hour).padStart(2, '0') });
}

/** A horizontal rail of hours. Scrolls to keep the strip one line tall. */
function HourPicker({
  value,
  onChange,
  tile,
}: {
  value: number;
  onChange: (hour: number) => void;
  tile: keyof typeof TILES;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // The rail is a row of its own, so it has to be told which way to run;
      // a horizontal ScrollView does not inherit the mirrored direction.
      style={{ transform: isRTL() ? [{ scaleX: -1 }] : undefined }}
      contentContainerStyle={styles.hourRail}
    >
      {HOURS.map((hour) => {
        const active = hour === value;
        return (
          <Pressable
            key={hour}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onChange(hour);
            }}
            style={[
              styles.hourChip,
              { transform: isRTL() ? [{ scaleX: -1 }] : undefined },
              active && { backgroundColor: TILES[tile] },
            ]}
          >
            <Text style={[styles.hourText, active && styles.hourTextActive]}>
              {hourLabel(hour)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export default function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();

  const [index, setIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [lang, setLang] = useState<Language>(getLanguage());
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<Profile>(defaultProfile);

  const step = STEPS[index];

  const patch = (p: Partial<Profile>) => setProfile((prev) => ({ ...prev, ...p }));

  const pickLanguage = async (code: Language) => {
    if (code === lang) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Returns true only when it could not restart on its own; when it can, the
    // app is already on its way back up and comes back to a fresh
    // questionnaire — in the new language, with nothing lost.
    const restartByHand = await setLanguage(code);
    setLang(code);
    if (restartByHand) {
      Alert.alert(t('profile.restartTitle'), t('profile.restartBody'));
    }
  };

  /** Saves everything and hands over to the app. */
  const finish = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await storage.saveProfile(profile);
    const trimmed = name.trim();
    if (trimmed) {
      const settings = await storage.getSettings();
      await storage.saveSettings({ ...settings, displayName: trimmed });
      // Mirrored onto the device profile so the greeting can use it.
      try {
        await api.updateMe({ name: trimmed });
      } catch {
        /* local-first; the name is already saved above */
      }
    }
    await storage.setOnboarded(true);
    onDone();
  };

  const skip = async () => {
    // Skipping still keeps the language, which was applied the moment it was
    // tapped, and still counts as onboarded — asking again next launch would
    // read as the app not having listened.
    await storage.saveProfile(profile);
    await storage.setOnboarded(true);
    onDone();
  };

  const next = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (index < STEPS.length - 1) setIndex(index + 1);
    else setFinished(true);
  };

  const back = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (finished) setFinished(false);
    else if (index > 0) setIndex(index - 1);
  };

  const start = { textAlign: alignStart() } as const;
  /**
   * Read while rendering, never from `StyleSheet.create`. Stylesheets are
   * built when the module is first imported, which happens before the language
   * has loaded — baked in there this is always `ltr`, and picking Hebrew on
   * the first step would translate the text without mirroring the layout.
   * On web this is also the only thing that mirrors anything, since
   * react-native-web ships I18nManager as a no-op.
   */
  const direction = { direction: isRTL() ? 'rtl' : 'ltr' } as const;

  // ── The closing screen ────────────────────────────────────────────────────
  if (finished) {
    return (
      <View style={[styles.screen, direction, { paddingTop: insets.top + spacing.lg }]}>
        <View style={styles.doneBody}>
          <View style={styles.doneMark}>
            <Check color={TILE_INK.green} size={34} strokeWidth={2.4} />
          </View>
          <Text style={[styles.title, { textAlign: 'center' }]}>{t('onboarding.done.title')}</Text>
          <Text style={[styles.body, { textAlign: 'center' }]}>{t('onboarding.done.body')}</Text>
        </View>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <Button label={t('onboarding.finish')} onPress={finish} />
          <Pressable onPress={back} style={styles.quietBtn}>
            <Text style={styles.quietBtnText}>{t('onboarding.back')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, direction, { paddingTop: insets.top + spacing.md }]}>
      {/* Progress: a filled bar per step, so "how much longer" is answerable
          at a glance without reading the counter. */}
      <View style={styles.progressRow}>
        {STEPS.map((s, i) => (
          <View key={s} style={[styles.progressPip, i <= index && styles.progressPipOn]} />
        ))}
      </View>
      <Text style={[styles.stepCount, start]}>
        {t('onboarding.step', { current: index + 1, total: STEPS.length })}
      </Text>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={[styles.title, start]}>{t(`onboarding.${step}.title`)}</Text>
        <Text style={[styles.body, start]}>{t(`onboarding.${step}.body`)}</Text>

        {step === 'language' ? (
          <View style={styles.chipWrap}>
            {(Object.keys(LANGUAGES) as Language[]).map((code) => {
              const active = code === lang;
              return (
                <Pressable
                  key={code}
                  onPress={() => pickLanguage(code)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {LANGUAGES[code].native}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {step === 'name' ? (
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('profile.yourName')}
            placeholderTextColor={colors.textMuted}
            style={[styles.input, start]}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={next}
          />
        ) : null}

        {step === 'work' ? (
          <>
            <Text style={[styles.railLabel, start]}>{hourLabel(profile.workStartHour)}</Text>
            <HourPicker
              value={profile.workStartHour}
              onChange={(workStartHour) => patch({ workStartHour })}
              tile="green"
            />
            <Text style={[styles.railLabel, start]}>{hourLabel(profile.workEndHour)}</Text>
            <HourPicker
              value={profile.workEndHour}
              onChange={(workEndHour) => patch({ workEndHour })}
              tile="green"
            />
          </>
        ) : null}

        {step === 'sleep' ? (
          <>
            <Text style={[styles.railLabel, start]}>{hourLabel(profile.sleepStartHour)}</Text>
            <HourPicker
              value={profile.sleepStartHour}
              onChange={(sleepStartHour) => patch({ sleepStartHour })}
              tile="blue"
            />
            <Text style={[styles.railLabel, start]}>{hourLabel(profile.sleepEndHour)}</Text>
            <HourPicker
              value={profile.sleepEndHour}
              onChange={(sleepEndHour) => patch({ sleepEndHour })}
              tile="blue"
            />
          </>
        ) : null}

        {step === 'buffer' ? (
          <View style={styles.chipWrap}>
            {BUFFERS.map((minutes) => {
              const active = minutes === profile.bufferMinutes;
              return (
                <Pressable
                  key={minutes}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    patch({ bufferMinutes: minutes });
                  }}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {minutes === 0
                      ? t('onboarding.buffer.none')
                      : t('onboarding.buffer.minutes', { count: minutes })}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {step === 'types' ? (
          <View style={styles.chipWrap}>
            {EVENT_TYPES.map((type) => {
              const active = profile.eventTypes.includes(type);
              return (
                <Pressable
                  key={type}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    patch({
                      eventTypes: active
                        ? profile.eventTypes.filter((e) => e !== type)
                        : [...profile.eventTypes, type as EventType],
                    });
                  }}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {t(`onboarding.type.${type}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {step === 'fixed' ? (
          <TextInput
            value={profile.fixedCommitments}
            onChangeText={(fixedCommitments) => patch({ fixedCommitments })}
            placeholder={t('onboarding.fixed.placeholder')}
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.inputTall, start]}
            multiline
            textAlignVertical="top"
          />
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <Button label={t('onboarding.next')} onPress={next} />
        <View style={styles.footerRow}>
          {index > 0 ? (
            <Pressable onPress={back} style={styles.quietBtn}>
              <Text style={styles.quietBtnText}>{t('onboarding.back')}</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <Pressable onPress={skip} style={styles.quietBtn}>
            <Text style={styles.quietBtnText}>{t('onboarding.skip')}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.md + 4,
  },

  progressRow: { flexDirection: 'row', gap: 5, marginBottom: spacing.sm },
  progressPip: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceAlt,
  },
  progressPipOn: { backgroundColor: colors.primary },
  stepCount: { ...font(500), fontSize: 12.5, color: colors.textMuted },

  content: { paddingTop: spacing.lg, paddingBottom: spacing.lg },
  title: {
    fontSize: 28,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.6,
    marginBottom: 6,
  },
  body: { fontSize: 15, ...font(500), color: colors.textMuted, lineHeight: 21, marginBottom: spacing.lg },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: 50,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { ...font(600), fontSize: 14, color: colors.text },
  chipTextActive: { color: colors.primaryText },

  railLabel: { ...font(700), fontSize: 20, color: colors.text, marginBottom: 6 },
  hourRail: { gap: 8, paddingBottom: spacing.md },
  hourChip: {
    minWidth: 58,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  hourText: { ...font(600), fontSize: 14, color: colors.textMuted },
  hourTextActive: { color: colors.text },

  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 16,
    fontSize: 16,
    ...font(500),
    color: colors.text,
  },
  inputTall: { minHeight: 110 },

  footer: { gap: 4, paddingTop: spacing.sm },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  quietBtn: { paddingVertical: 12, paddingHorizontal: 4 },
  quietBtnText: { ...font(600), fontSize: 14, color: colors.textMuted },

  doneBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  doneMark: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: TILES.green,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
});
