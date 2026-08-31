import { useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  Check,
  Mic,
  CalendarCheck,
  ShieldCheck,
  Bell,
  Languages,
  Sparkles,
  User,
  Clock,
  Moon,
  Timer,
  CalendarDays,
  Pin,
  Globe,
} from 'lucide-react-native';

import { LinearGradient } from 'expo-linear-gradient';

import { Button } from '../components/ui';
import { Entrance } from '../components/motion';
import {
  HourRangePicker,
  BufferPicker,
  EventTypePicker,
  GenderPicker,
  SleepInsight,
  CountryPicker,
} from '../components/ProfileFields';
import { storage, defaultProfile, type Profile } from '../lib/storage';
import { guessCountry, currencyOf } from '../lib/currency';
import { api } from '../lib/api';
import {
  getMicrophoneState,
  getNotificationState,
  requestMicrophone,
  requestNotifications,
  type PermissionState,
} from '../lib/permissions';
import { colors, spacing, font, radius, AURA, IRIDESCENT, type AuraKey } from '../theme';
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
 * What follows it says what the app *is*, before asking anything. Someone who
 * has just installed this has no reason to know the main interface is a
 * conversation, and a questionnaire about sleeping hours does not tell them.
 *
 * Permissions come last, once there is a reason for them. The microphone and
 * the notifications used to be requested at the moment they were first needed
 * — mid-sentence, with no explanation on screen — which is the version of the
 * prompt people refuse. Refusing here costs nothing either: both are optional
 * and the app says so.
 *
 * Every question has a usable default, and the whole thing can be skipped.
 * What comes out is a `Profile`, which rides along with every voice turn and
 * is what stops her offering a meeting in the middle of the night.
 */

type StepId =
  | 'language'
  | 'intro'
  | 'name'
  | 'place'
  | 'work'
  | 'sleep'
  | 'buffer'
  | 'types'
  | 'fixed'
  | 'permissions';

const STEPS: StepId[] = [
  'language',
  'intro',
  'name',
  'place',
  'work',
  'sleep',
  'buffer',
  'types',
  'fixed',
  'permissions',
];

/**
 * The face each step wears.
 *
 * Colour cycles through the app's own tiles rather than meaning anything —
 * the same thing `AURA_CYCLE` does on the lists. What it buys is a sense of
 * moving through chapters instead of filling in one long form: nine
 * identically white screens in a row is what made this read as a survey.
 */
const STEP_SKIN: Record<StepId, { tile: AuraKey; Icon: typeof Mic }> = {
  language: { tile: 'blue', Icon: Languages },
  intro: { tile: 'green', Icon: Sparkles },
  name: { tile: 'yellow', Icon: User },
  place: { tile: 'green', Icon: Globe },
  work: { tile: 'green', Icon: Clock },
  sleep: { tile: 'blue', Icon: Moon },
  buffer: { tile: 'yellow', Icon: Timer },
  types: { tile: 'green', Icon: CalendarDays },
  fixed: { tile: 'blue', Icon: Pin },
  permissions: { tile: 'yellow', Icon: ShieldCheck },
};

/**
 * The panel behind each question, as a slice of the app's own gradient.
 *
 * Walking the questionnaire walks the sweep: green at the start, blue through
 * the middle, yellow at the end. It is a pair rather than all three stops so
 * each screen is a calm wash instead of a rainbow, and consecutive steps
 * always share an edge — which is what makes moving between them read as one
 * surface sliding rather than nine unrelated colours.
 */
const STEP_WASH: Record<StepId, readonly [string, string]> = {
  language: [IRIDESCENT[0], AURA.green.tint],
  intro: [AURA.green.tint, IRIDESCENT[0]],
  name: [IRIDESCENT[0], IRIDESCENT[1]],
  place: [IRIDESCENT[1], AURA.green.tint],
  work: [AURA.green.tint, IRIDESCENT[1]],
  sleep: [IRIDESCENT[1], AURA.blue.tint],
  buffer: [AURA.blue.tint, IRIDESCENT[1]],
  types: [IRIDESCENT[1], IRIDESCENT[2]],
  fixed: [IRIDESCENT[2], AURA.yellow.tint],
  permissions: [AURA.yellow.tint, IRIDESCENT[2]],
};

/** The three things worth knowing before answering anything. */
const INTRO_POINTS = [
  { key: 'talk', Icon: Mic, tile: 'green' },
  { key: 'plan', Icon: CalendarCheck, tile: 'blue' },
  { key: 'private', Icon: ShieldCheck, tile: 'yellow' },
] as const satisfies readonly { key: string; Icon: typeof Mic; tile: AuraKey }[];

/** What each permission is, in the order it is asked for. */
const PERMISSIONS = [
  { key: 'mic', Icon: Mic, tile: 'green', request: requestMicrophone, read: getMicrophoneState },
  {
    key: 'notify',
    Icon: Bell,
    tile: 'yellow',
    request: requestNotifications,
    read: getNotificationState,
  },
] as const satisfies readonly {
  key: string;
  Icon: typeof Mic;
  tile: AuraKey;
  request: () => Promise<PermissionState>;
  read: () => Promise<PermissionState>;
}[];

type PermissionKey = (typeof PERMISSIONS)[number]['key'];

/** Tinted icon square, the same glyph treatment the cards use elsewhere. */
function IconSquare({ tile, Icon }: { tile: AuraKey; Icon: typeof Mic }) {
  return (
    <View style={[styles.iconSquare, { backgroundColor: AURA[tile].tint }]}>
      <Icon color={AURA[tile].ink} size={19} strokeWidth={2.2} />
    </View>
  );
}

/**
 * One permission, with the reason for it and a button that asks.
 *
 * Granted turns the button into a check and stops it being pressable — the
 * system shows nothing on a second request, so a button that still looked live
 * would do nothing visible and read as broken.
 *
 * A refusal has the same problem for the opposite reason: iOS never shows the
 * prompt twice and Android stops after the second no, so once someone has said
 * no the button can no longer do what it says. It becomes a route to the
 * system settings instead, which is the only place the answer can still be
 * changed. This only applies to a no given *here* — a permission that has
 * simply never been asked for looks the same to the system and is still worth
 * an ordinary button.
 */
function PermissionRow({
  Icon,
  tile,
  title,
  body,
  state,
  refused,
  busy,
  onPress,
}: {
  Icon: typeof Mic;
  tile: AuraKey;
  title: string;
  body: string;
  state: PermissionState | 'unknown';
  refused: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const granted = state === 'granted';
  const label = granted
    ? t('onboarding.permissions.allowed')
    : refused
      ? t('profile.openSettings')
      : t('onboarding.permissions.allow');
  const start = { textAlign: alignStart() } as const;

  return (
    <View style={styles.permRow}>
      <IconSquare tile={tile} Icon={Icon} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.permTitle, start]}>{title}</Text>
        <Text style={[styles.permBody, start]}>{body}</Text>
      </View>
      <Pressable
        onPress={granted || busy ? undefined : onPress}
        disabled={granted || busy}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.permBtn, granted && styles.permBtnDone]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.text} />
        ) : granted ? (
          <Check color={AURA.green.ink} size={17} strokeWidth={3} />
        ) : (
          <Text style={styles.permBtnText} numberOfLines={1}>
            {label}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

export default function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();

  const [index, setIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [lang, setLang] = useState<Language>(getLanguage());
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<Profile>(() => {
    // Pre-answered from the device's timezone, the same way the language
    // question is: a guess that is usually right costs nothing to correct,
    // and an empty question costs a decision.
    const guess = guessCountry();
    return guess
      ? { ...defaultProfile, country: guess, currency: currencyOf(guess) }
      : defaultProfile;
  });
  const [permissions, setPermissions] = useState<Record<PermissionKey, PermissionState | 'unknown'>>(
    { mic: 'unknown', notify: 'unknown' },
  );
  const [asking, setAsking] = useState<PermissionKey | null>(null);
  /**
   * The ones refused in this session, which the system will not prompt for
   * again. Kept apart from the state map because a permission nobody has ever
   * been asked about reads as 'denied' too, and those two want different
   * buttons.
   */
  const [refused, setRefused] = useState<PermissionKey[]>([]);

  const step = STEPS[index];

  const patch = (p: Partial<Profile>) => setProfile((prev) => ({ ...prev, ...p }));

  /**
   * Reads what has already been granted when the permissions step opens.
   *
   * Someone reinstalling, or returning after granting these in the system
   * settings, should see checks rather than buttons that do nothing when
   * pressed. Reading is silent — none of this shows a prompt.
   */
  useEffect(() => {
    if (step !== 'permissions') return;
    let active = true;
    (async () => {
      const states = await Promise.all(PERMISSIONS.map((p) => p.read()));
      if (!active) return;
      setPermissions((prev) => {
        const next = { ...prev };
        PERMISSIONS.forEach((p, i) => {
          next[p.key] = states[i]!;
        });
        return next;
      });
    })();
    return () => {
      active = false;
    };
  }, [step]);

  const askFor = async (key: PermissionKey) => {
    const entry = PERMISSIONS.find((p) => p.key === key);
    if (!entry || asking) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Already refused once: the system will not show a prompt, so the only
    // thing left that can change the answer is the settings app.
    if (refused.includes(key)) {
      Linking.openSettings().catch(() => {
        /* nothing to open; the step is skippable either way */
      });
      return;
    }

    setAsking(key);
    const state = await entry.request();
    setAsking(null);
    setPermissions((prev) => ({ ...prev, [key]: state }));
    if (state === 'granted') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (state === 'denied') {
      setRefused((prev) => (prev.includes(key) ? prev : [...prev, key]));
    }
  };

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
    // read as the app not having listened. The profile can be changed later in
    // Settings, and the permissions are asked again at first use.
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
            <Check color={AURA.green.ink} size={34} strokeWidth={2.4} />
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

  const skin = STEP_SKIN[step];
  const StepIcon = skin.Icon;

  return (
    <View style={[styles.screen, direction]}>
      {/* The question lives on a tinted panel of its own, and the answers on
          the paper below it. Before this the two ran together in one column of
          off-white, which is what made nine screens of it read as a form. */}
      <LinearGradient
        key={step}
        colors={STEP_WASH[step]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.hero, { paddingTop: insets.top + spacing.md }]}
      >
        <View style={styles.heroTop}>
          <View style={styles.heroBadge}>
            <StepIcon color={colors.text} size={20} strokeWidth={2.2} />
          </View>
          <Text style={styles.stepCount}>
            {t('onboarding.step', { current: index + 1, total: STEPS.length })}
          </Text>
        </View>

        {/* A pip per step, on the tint rather than as a hairline at the very
            edge of the screen where it was easy to miss entirely. The one in
            hand is wider, so "where am I" is answerable without counting. */}
        <View style={styles.progressRow}>
          {STEPS.map((s, i) => (
            <View
              key={s}
              style={[
                styles.progressPip,
                i < index && styles.progressPipDone,
                i === index && styles.progressPipNow,
              ]}
            />
          ))}
        </View>

        {/* Keyed on the step, so each question arrives rather than swapping
            its text in place. */}
        <Entrance key={`q-${step}`} delay={60} from={16}>
          <Text style={[styles.title, start]}>{t(`onboarding.${step}.title`)}</Text>
          <Text style={[styles.body, start]}>{t(`onboarding.${step}.body`)}</Text>
        </Entrance>
      </LinearGradient>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* The answers follow the question in, one beat behind it. */}
        <Entrance key={`a-${step}`} delay={160} from={22}>

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

        {step === 'intro' ? (
          <View style={styles.introList}>
            {INTRO_POINTS.map(({ key, Icon, tile }) => (
              <View key={key} style={styles.introRow}>
                <IconSquare tile={tile} Icon={Icon} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.introTitle, start]}>
                    {t(`onboarding.intro.${key}.title`)}
                  </Text>
                  <Text style={[styles.introBody, start]}>
                    {t(`onboarding.intro.${key}.body`)}
                  </Text>
                </View>
              </View>
            ))}
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

        {step === 'place' ? (
          <CountryPicker
            country={profile.country}
            currency={profile.currency}
            onChange={({ country, currency }) => patch({ country, currency })}
          />
        ) : null}

        {step === 'work' ? (
          <HourRangePicker
            from={profile.workStartHour}
            to={profile.workEndHour}
            onFrom={(workStartHour) => patch({ workStartHour })}
            onTo={(workEndHour) => patch({ workEndHour })}
            tile="green"
          />
        ) : null}

        {step === 'sleep' ? (
          <>
            <Text style={[styles.sleepPrompt, start]}>
              {t('onboarding.sleep.genderPrompt')}
            </Text>
            <GenderPicker value={profile.gender} onChange={(gender) => patch({ gender })} />

            <HourRangePicker
              from={profile.sleepStartHour}
              to={profile.sleepEndHour}
              onFrom={(sleepStartHour) => patch({ sleepStartHour })}
              onTo={(sleepEndHour) => patch({ sleepEndHour })}
              tile="blue"
            />

            <SleepInsight
              gender={profile.gender}
              startHour={profile.sleepStartHour}
              endHour={profile.sleepEndHour}
            />
          </>
        ) : null}

        {step === 'buffer' ? (
          <BufferPicker
            value={profile.bufferMinutes}
            onChange={(bufferMinutes) => patch({ bufferMinutes })}
          />
        ) : null}

        {step === 'types' ? (
          <EventTypePicker
            value={profile.eventTypes}
            onChange={(eventTypes) => patch({ eventTypes })}
          />
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

        {step === 'permissions' ? (
          <View style={styles.introList}>
            {PERMISSIONS.map(({ key, Icon, tile }) =>
              // A permission the platform cannot grant is not offered. On web
              // there is no recorder module to ask, and a button that can only
              // fail is worse than no button.
              permissions[key] === 'unavailable' ? null : (
                <PermissionRow
                  key={key}
                  Icon={Icon}
                  tile={tile}
                  title={t(`onboarding.permissions.${key}.title`)}
                  body={t(`onboarding.permissions.${key}.body`)}
                  state={permissions[key]}
                  refused={refused.includes(key)}
                  busy={asking === key}
                  onPress={() => askFor(key)}
                />
              ),
            )}
            <Text style={[styles.permFoot, start]}>{t('onboarding.permissions.optional')}</Text>
          </View>
        ) : null}
        </Entrance>
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
  screen: { flex: 1, backgroundColor: colors.bg },

  // The tint runs to both edges and curves only at the foot, so it reads as
  // the top of the page rather than as a card floating on it.
  hero: {
    paddingHorizontal: spacing.md + 4,
    paddingBottom: spacing.lg,
    borderBottomStartRadius: 30,
    borderBottomEndRadius: 30,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  heroBadge: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  progressRow: { flexDirection: 'row', gap: 5, marginBottom: spacing.md },
  progressPip: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    // On a tinted ground a grey pip disappears; ink at low opacity does not.
    backgroundColor: 'rgba(20, 21, 15, 0.14)',
  },
  progressPipDone: { backgroundColor: 'rgba(20, 21, 15, 0.45)' },
  // The one in hand is wider as well as darker, so the position reads without
  // counting pips.
  progressPipNow: { flex: 2.2, backgroundColor: colors.primary },
  stepCount: { ...font(600), fontSize: 12.5, color: colors.text, opacity: 0.55 },

  content: {
    paddingHorizontal: spacing.md + 4,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    // Short answers sit in the middle of the space rather than clinging to the
    // top of it. Half the steps are one input or three rows, and left at the
    // top they hung under the panel with a screen of nothing beneath them.
    flexGrow: 1,
    justifyContent: 'center',
  },
  title: {
    fontSize: 30,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.7,
    lineHeight: 36,
    marginBottom: 6,
  },
  // Ink at reduced opacity rather than the muted grey: on a tinted ground the
  // grey turns murky, and the two greys stop looking like one family.
  body: {
    fontSize: 15,
    ...font(500),
    color: colors.text,
    opacity: 0.66,
    lineHeight: 21,
  },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: 50,
    backgroundColor: colors.surface,
    // A hairline, so twenty-five of them read as one grid instead of as white
    // shapes drifting on an almost-white page.
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...font(600), fontSize: 14, color: colors.text },
  chipTextActive: { color: colors.primaryText },

  iconSquare: {
    width: 40,
    height: 40,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Intro and permissions: the same row, one with a button on the end ──
  introList: { gap: 6 },
  introRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  introTitle: { ...font(600), fontSize: 15.5, color: colors.text },
  introBody: { ...font(400), fontSize: 13, color: colors.textMuted, lineHeight: 18, marginTop: 2 },

  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  permTitle: { ...font(600), fontSize: 15.5, color: colors.text },
  permBody: { ...font(400), fontSize: 13, color: colors.textMuted, lineHeight: 18, marginTop: 2 },
  permBtn: {
    minWidth: 62,
    // Capped so the longer "open settings" label cannot crowd out the reason
    // for the permission, which is the part that does the persuading.
    maxWidth: 132,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  permBtnDone: { backgroundColor: AURA.green.tint },
  permBtnText: { ...font(600), fontSize: 13.5, color: colors.text },
  permFoot: {
    ...font(400),
    fontSize: 12.5,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.sm,
  },

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

  sleepPrompt: { ...font(600), fontSize: 13.5, color: colors.textMuted, marginBottom: 8 },

  // The screen itself no longer pads its sides — the tint has to reach the
  // edges — so the footer carries its own.
  footer: { gap: 4, paddingTop: spacing.sm, paddingHorizontal: spacing.md + 4 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  quietBtn: { paddingVertical: 12, paddingHorizontal: 4 },
  quietBtnText: { ...font(600), fontSize: 14, color: colors.textMuted },

  doneBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  doneMark: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: AURA.green.tint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
});
