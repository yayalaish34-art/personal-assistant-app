import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  ScrollView,
  View,
  Text,
  TextInput,
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

import { Button, Glow, LitDisc } from '../components/ui';
import {
  Entrance,
  PageReveal,
  PopIn,
  Pressable,
  useBreathe,
  useGrow,
  useReducedMotion,
} from '../components/motion';
import {
  HourRangePicker,
  BufferPicker,
  EventTypePicker,
  GenderPicker,
  SleepInsight,
  CountryPicker,
} from '../components/ProfileFields';
import { storage, defaultProfile, type Profile } from '../lib/storage';
import { PersonalizationField, PERSONALIZATION_QUESTIONS, type PersonalizationQuestion } from '../components/PersonalizationFields';
import { guessCountry, currencyOf } from '../lib/currency';
import { api } from '../lib/api';
import {
  getMicrophoneState,
  getNotificationState,
  requestMicrophone,
  requestNotifications,
  type PermissionState,
} from '../lib/permissions';
import { colors, spacing, font, radius, AURA, NIGHT, type AuraKey, themed } from '../theme';
import {
  t,
  LANGUAGES,
  getVoiceLanguage,
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
  | PersonalizationQuestion
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
  'workDays',
  'focusPeriod',
  'primaryGoal',
  'sleep',
  'sleepQuality',
  'assistanceStyle',
  'buffer',
  'types',
  'fixed',
  'permissions',
];

/**
 * The face each step wears: a glyph on a tile of its own colour at the head of
 * the page.
 *
 * Colour cycles through the app's own tiles rather than meaning anything —
 * the same thing `AURA_CYCLE` does on the lists. What it buys is a sense of
 * moving through chapters instead of filling in one long form: nine identical
 * screens in a row is what made this read as a survey. The page itself stays
 * dark on every step, as Home does; the chapter is carried by the tile.
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
  workDays: { tile: 'green', Icon: CalendarDays },
  focusPeriod: { tile: 'blue', Icon: Clock },
  primaryGoal: { tile: 'yellow', Icon: Sparkles },
  sleepQuality: { tile: 'blue', Icon: Moon },
  assistanceStyle: { tile: 'green', Icon: Mic },
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

/**
 * Tinted icon square, the same glyph treatment the cards use elsewhere: the hue
 * at a whisper over the dark, and its lit ink for the glyph.
 */
function IconSquare({ tile, Icon }: { tile: AuraKey; Icon: typeof Mic }) {
  return (
    <View style={[styles.iconSquare, { backgroundColor: AURA[tile].tint }]}>
      <Icon color={AURA[tile].ink} size={19} strokeWidth={2.2} />
    </View>
  );
}

// ── Moving between steps ────────────────────────────────────────────────────

/** Which way the questionnaire last moved: on, or back. */
type Heading = 1 | -1;

/** How far a step's pieces travel in from the side, in px. */
const STEP_TRAVEL = 44;
/** When the answers start to arrive: a beat behind the question. */
const ANSWERS_AT = 170;
/** The gap between one row of answers and the next. */
const ROW_BEAT = 70;

/**
 * One piece of a step, arriving from the side the questionnaire is heading:
 * Continue brings the next page in from ahead, Back brings the last one in from
 * behind. The same rise both ways made Back read as one more step on.
 *
 * Ahead is the end of the line, so it swaps sides with the language — in Hebrew
 * the next page comes in from the left. Transforms are physical and do not
 * mirror with the layout, so the side is flipped here by hand.
 *
 * Key it on the step: mounting is what plays it.
 */
function StepIn({
  heading,
  delay = 0,
  travel = STEP_TRAVEL,
  children,
}: {
  heading: Heading;
  delay?: number;
  /** How far in from the side it starts, in px. */
  travel?: number;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;

  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    // The spring `Entrance` uses, so a step arrives with the same weight a
    // page does everywhere else — only from the side instead of from below.
    const anim = Animated.spring(v, {
      toValue: 1,
      delay,
      friction: 8,
      tension: 46,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [delay, reduce, v]);

  const from = travel * heading * (isRTL() ? -1 : 1);
  return (
    <Animated.View
      style={{
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Holds its children back for `delay` ms, then mounts them.
 *
 * For a pop that belongs after something has arrived. Picking a language
 * rebuilds the whole questionnaire, so the chosen chip is always a fresh mount
 * — and a pop that played at mount would be over, unseen, before the chip's own
 * entrance had brought it into view. Nothing is held back for someone who has
 * asked for less motion.
 */
function After({ delay, children }: { delay: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (reduce) return;
    const timer = setTimeout(() => setDue(true), delay);
    return () => clearTimeout(timer);
  }, [delay, reduce]);
  return reduce || due ? <>{children}</> : null;
}

/** How much wider than the rest the pip in hand is. */
const PIP_NOW_FLEX = 2.2;

/**
 * One step's pip.
 *
 * The one in hand widens as it lights, and the one it took over from narrows
 * back at the same time, so moving on reads as the light travelling along the
 * row rather than blinking out in one place and on in another.
 */
function Pip({ now, done }: { now: boolean; done: boolean }) {
  const grow = useGrow(now ? 1 : 0, 0);
  return (
    <Animated.View
      style={[
        styles.progressPip,
        done && styles.progressPipDone,
        { flex: grow.interpolate({ inputRange: [0, 1], outputRange: [1, PIP_NOW_FLEX] }) },
      ]}
    >
      {now ? (
        // The lit ground and its glow ride in with the fill. Left on the pip
        // itself, the blue would be there already and the pop would only
        // show the gradient's top edge.
        <PopIn from={0.5} style={styles.progressPipLit}>
          <LinearGradient
            colors={NIGHT.blue}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={[StyleSheet.absoluteFill, styles.progressPipFill]}
          />
        </PopIn>
      ) : null}
    </Animated.View>
  );
}

/**
 * The closing screen's one button, breathing once everything has arrived.
 *
 * Only there. Continue is pressed ten times running under a page that is
 * already moving on every step, and a pulse on it would nag; Finish is the one
 * press the whole questionnaire has been leading to.
 */
function Breathing({ children }: { children: ReactNode }) {
  const pulse = useBreathe(1, 1.025, 1600, 1000);
  return <Animated.View style={{ transform: [{ scale: pulse }] }}>{children}</Animated.View>;
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
          // Springs in the moment the answer comes back yes: the check is the
          // thing that was just given.
          <PopIn from={0.3}>
            <Check color={AURA.green.ink} size={17} strokeWidth={3} />
          </PopIn>
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
  const [lang, setLang] = useState<Language>(getVoiceLanguage());
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
  /** Only which side the next page slides in from; nothing reads it but motion. */
  const [heading, setHeading] = useState<Heading>(1);

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
    setHeading(1);
    if (index < STEPS.length - 1) setIndex(index + 1);
    else setFinished(true);
  };

  const back = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHeading(-1);
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
        <Glow />
        {/* Keyed apart from the steps' reveal, which sits in the same place in
            the tree: without it React keeps the one instance and the closing
            page would swap in without playing. */}
        <PageReveal key="done">
          <View style={styles.doneBody}>
            {/* The same lit tick a finished row gets on Home, and it arrives
                the way that one does when a row is ticked. Its margin is on
                the pop, so the spring scales about the disc's own centre. */}
            <PopIn from={0.3} style={styles.doneMark}>
              <LitDisc colors={NIGHT.discs.tasks} size={76}>
                <Check color={NIGHT.glyph} size={34} strokeWidth={2.6} />
              </LitDisc>
            </PopIn>
            <Entrance delay={140} from={18}>
              <Text style={[styles.title, { textAlign: 'center' }]}>
                {t('onboarding.done.title')}
              </Text>
            </Entrance>
            <Entrance delay={210} from={18}>
              <Text style={[styles.body, { textAlign: 'center' }]}>
                {t('onboarding.done.body')}
              </Text>
            </Entrance>
          </View>
          <Entrance
            delay={320}
            from={16}
            style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}
          >
            <Breathing>
              <Button label={t('onboarding.finish')} onPress={finish} />
            </Breathing>
            <Pressable onPress={back} style={styles.quietBtn}>
              <Text style={styles.quietBtnText}>{t('onboarding.back')}</Text>
            </Pressable>
          </Entrance>
        </PageReveal>
      </View>
    );
  }

  const skin = STEP_SKIN[step];
  const StepIcon = skin.Icon;

  return (
    <View style={[styles.screen, direction]}>
      <Glow />
      {/* Plays when the questionnaire opens and when the closing page hands
          back to it. Moving between steps does not replay it — the steps slide
          themselves, below — or the whole page would lurch on every Continue. */}
      <PageReveal key="steps">
        {/* The question heads the page in big type, and the answers sit below it
            on glass. Run together in one column on one ground, nine screens of
            this read as a form; with the page dark end to end, as Home is, size
            and the glass are what keep the two apart. */}
        <View style={[styles.hero, { paddingTop: insets.top + spacing.md }]}>
          <View style={styles.heroTop}>
            {/* The chapter's badge pops in with each step, ahead of the question,
                so the new chapter is seen arriving rather than its tile
                changing colour in place. */}
            <PopIn
              key={`badge-${step}`}
              from={0.5}
              style={[styles.heroBadge, { backgroundColor: AURA[skin.tile].tint }]}
            >
              <StepIcon color={AURA[skin.tile].ink} size={20} strokeWidth={2.2} />
            </PopIn>
            <StepIn key={`count-${step}`} heading={heading} travel={12}>
              <Text style={styles.stepCount}>
                {t('onboarding.step', { current: index + 1, total: STEPS.length })}
              </Text>
            </StepIn>
          </View>

          {/* A pip per step, under the question's head rather than as a hairline
              at the very edge of the screen where it was easy to miss entirely.
              The one in hand is wider and lit like the chosen day on Home, so
              "where am I" is answerable without counting; the ones behind it
              keep a dimmer blue, so the trail reads as ground covered. */}
          <View style={styles.progressRow}>
            {STEPS.map((s, i) => (
              <Pip key={s} now={i === index} done={i < index} />
            ))}
          </View>

          {/* Keyed on the step, so each question arrives rather than swapping
              its text in place — the question first, what it means a beat
              after. */}
          <StepIn key={`title-${step}`} heading={heading} delay={60}>
            <Text style={[styles.title, start]}>{t(`onboarding.${step}.title`)}</Text>
          </StepIn>
          <StepIn key={`body-${step}`} heading={heading} delay={115}>
            <Text style={[styles.body, start]}>{t(`onboarding.${step}.body`)}</Text>
          </StepIn>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          {/* The answers follow the question in, one beat behind it, and a list
              of them comes in row by row. Each step's answers are their own
              slot below, so a new step always mounts — which is what plays them. */}

          {step === 'language' ? (
            <View style={styles.chipWrap}>
              {(Object.keys(LANGUAGES) as Language[]).map((code, i) => {
                const active = code === lang;
                // A quick ripple through the chips in reading order; there are
                // two dozen of them, so the beat is short.
                const arrives = ANSWERS_AT + i * 12;
                return (
                  <StepIn key={code} heading={heading} delay={arrives}>
                    <Pressable
                      onPress={() => pickLanguage(code)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      {active ? (
                        // Lit once the chip has landed. Choosing rebuilds the
                        // page in the new language, so this is the moment the
                        // choice is seen to take.
                        <After delay={arrives + 160}>
                          <PopIn style={styles.chipLit}>
                            <LinearGradient
                              colors={NIGHT.blue}
                              start={{ x: 0, y: 0 }}
                              end={{ x: 0, y: 1 }}
                              // Rounded itself rather than clipped by the chip: a
                              // clip on iOS takes the chip's glow with it.
                              style={[StyleSheet.absoluteFill, styles.chipFill]}
                            />
                          </PopIn>
                        </After>
                      ) : null}
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {LANGUAGES[code].native}
                      </Text>
                    </Pressable>
                  </StepIn>
                );
              })}
            </View>
          ) : null}

          {step === 'intro' ? (
            <View style={styles.introList}>
              {INTRO_POINTS.map(({ key, Icon, tile }, i) => (
                <StepIn key={key} heading={heading} delay={ANSWERS_AT + i * ROW_BEAT}>
                  <View style={styles.introRow}>
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
                </StepIn>
              ))}
            </View>
          ) : null}

          {step === 'name' ? (
            <StepIn heading={heading} delay={ANSWERS_AT}>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={t('profile.yourName')}
                placeholderTextColor={colors.textMuted}
                selectionColor={NIGHT.blue[0]}
                style={[styles.input, start]}
                autoFocus
                returnKeyType="next"
                onSubmitEditing={next}
              />
            </StepIn>
          ) : null}

          {step === 'place' ? (
            <StepIn heading={heading} delay={ANSWERS_AT}>
              <CountryPicker
                country={profile.country}
                currency={profile.currency}
                onChange={({ country, currency }) => patch({ country, currency })}
              />
            </StepIn>
          ) : null}

          {step === 'work' ? (
            <StepIn heading={heading} delay={ANSWERS_AT}>
              <HourRangePicker
                from={profile.workStartHour}
                to={profile.workEndHour}
                onFrom={(workStartHour) => patch({ workStartHour })}
                onTo={(workEndHour) => patch({ workEndHour })}
                tile="green"
              />
            </StepIn>
          ) : null}

          {PERSONALIZATION_QUESTIONS.includes(step as PersonalizationQuestion) ? (
            <StepIn key={step} heading={heading} delay={ANSWERS_AT}>
              <PersonalizationField question={step as PersonalizationQuestion} profile={profile} onChange={patch} />
            </StepIn>
          ) : null}

          {step === 'sleep' ? (
            <>
              <StepIn heading={heading} delay={ANSWERS_AT}>
                <Text style={[styles.sleepPrompt, start]}>
                  {t('onboarding.sleep.genderPrompt')}
                </Text>
                <GenderPicker value={profile.gender} onChange={(gender) => patch({ gender })} />
              </StepIn>

              <StepIn heading={heading} delay={ANSWERS_AT + ROW_BEAT}>
                <HourRangePicker
                  from={profile.sleepStartHour}
                  to={profile.sleepEndHour}
                  onFrom={(sleepStartHour) => patch({ sleepStartHour })}
                  onTo={(sleepEndHour) => patch({ sleepEndHour })}
                  tile="blue"
                />
              </StepIn>

              <StepIn heading={heading} delay={ANSWERS_AT + ROW_BEAT * 2}>
                <SleepInsight
                  gender={profile.gender}
                  startHour={profile.sleepStartHour}
                  endHour={profile.sleepEndHour}
                />
              </StepIn>
            </>
          ) : null}

          {step === 'buffer' ? (
            <StepIn heading={heading} delay={ANSWERS_AT}>
              <BufferPicker
                value={profile.bufferMinutes}
                onChange={(bufferMinutes) => patch({ bufferMinutes })}
              />
            </StepIn>
          ) : null}

          {step === 'types' ? (
            <StepIn heading={heading} delay={ANSWERS_AT}>
              <EventTypePicker
                value={profile.eventTypes}
                onChange={(eventTypes) => patch({ eventTypes })}
              />
            </StepIn>
          ) : null}

          {step === 'fixed' ? (
            <StepIn heading={heading} delay={ANSWERS_AT}>
              <TextInput
                value={profile.fixedCommitments}
                onChangeText={(fixedCommitments) => patch({ fixedCommitments })}
                placeholder={t('onboarding.fixed.placeholder')}
                placeholderTextColor={colors.textMuted}
                selectionColor={NIGHT.blue[0]}
                style={[styles.input, styles.inputTall, start]}
                multiline
                textAlignVertical="top"
              />
            </StepIn>
          ) : null}

          {step === 'permissions' ? (
            <View style={styles.introList}>
              {PERMISSIONS.map(({ key, Icon, tile }, i) =>
                // A permission the platform cannot grant is not offered. On web
                // there is no recorder module to ask, and a button that can only
                // fail is worse than no button.
                permissions[key] === 'unavailable' ? null : (
                  <StepIn key={key} heading={heading} delay={ANSWERS_AT + i * ROW_BEAT}>
                    <PermissionRow
                      Icon={Icon}
                      tile={tile}
                      title={t(`onboarding.permissions.${key}.title`)}
                      body={t(`onboarding.permissions.${key}.body`)}
                      state={permissions[key]}
                      refused={refused.includes(key)}
                      busy={asking === key}
                      onPress={() => askFor(key)}
                    />
                  </StepIn>
                ),
              )}
              <StepIn heading={heading} delay={ANSWERS_AT + PERMISSIONS.length * ROW_BEAT}>
                <Text style={[styles.permFoot, start]}>
                  {t('onboarding.permissions.optional')}
                </Text>
              </StepIn>
            </View>
          ) : null}
        </ScrollView>

        {/* The footer stays put between steps: it is the same three buttons on
            every page, and sliding them with the question would make Continue
            move out from under a thumb that is about to press it again. */}
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <Button label={t('onboarding.next')} onPress={next} />
          <View style={styles.footerRow}>
            {index > 0 ? (
              // Pops in on the first step it has somewhere to go back to.
              <PopIn from={0.8}>
                <Pressable onPress={back} style={styles.quietBtn}>
                  <Text style={styles.quietBtnText}>{t('onboarding.back')}</Text>
                </Pressable>
              </PopIn>
            ) : (
              <View />
            )}
            <Pressable onPress={skip} style={styles.quietBtn}>
              <Text style={styles.quietBtnText}>{t('onboarding.skip')}</Text>
            </Pressable>
          </View>
        </View>
      </PageReveal>
    </View>
  );
}

/**
 * A glass card: a whisper over the page, with a hairline edge.
 *
 * The colours are getters, read each time the object is spread: a sheet built
 * for the other scheme has to pick up the glass in force, not the one this
 * module saw when it was imported.
 */
const glass = {
  get backgroundColor() {
    return NIGHT.card;
  },
  borderWidth: StyleSheet.hairlineWidth,
  get borderColor() {
    return NIGHT.line;
  },
};

const styles = themed(() =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },

    hero: {
      paddingHorizontal: spacing.md + 4,
      paddingBottom: spacing.sm,
    },
    heroTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    /** Its ground is the step's tile, set where it is drawn. */
    heroBadge: {
      width: 42,
      height: 42,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },

    progressRow: { flexDirection: 'row', gap: 5, marginBottom: spacing.md + 4 },
    progressPip: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      backgroundColor: NIGHT.cardAlt,
    },
    progressPipDone: { backgroundColor: NIGHT.blue[1], opacity: 0.5 },
    // The one in hand is wider as well as lit (see `PIP_NOW_FLEX`), so the
    // position reads without counting pips. The glow is its own blue, as the
    // chosen day's is on Home. This is the fill that pops in over the pip.
    progressPipLit: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      borderRadius: 2,
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.5,
      shadowRadius: 10,
    },
    progressPipFill: { borderRadius: 2 },
    stepCount: { ...font(600), fontSize: 12.5, color: colors.textMuted },

    content: {
      paddingHorizontal: spacing.md + 4,
      paddingTop: spacing.lg,
      paddingBottom: spacing.lg,
      // Short answers sit in the middle of the space rather than clinging to the
      // top of it. Half the steps are one input or three rows, and left at the
      // top they hung under the question with a screen of nothing beneath them.
      flexGrow: 1,
      justifyContent: 'center',
    },
    /** The question, set the way Home sets its headline. */
    title: {
      fontSize: 32,
      ...font(700),
      color: colors.text,
      letterSpacing: -1,
      lineHeight: 36,
      marginBottom: 8,
    },
    body: {
      fontSize: 15,
      ...font(500),
      color: colors.textMuted,
      lineHeight: 21,
    },

    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      ...glass,
      paddingHorizontal: 15,
      paddingVertical: 11,
      borderRadius: 50,
    },
    // Lit like the chosen day on Home: the blue from the top, glowing its own
    // colour. The edge keeps its width, clear, so a chip does not change size
    // when it is picked.
    //
    // The blue and its glow are on the fill (`chipLit`), which springs in, rather
    // than on the chip, where they would be showing before the pop began. Android
    // draws its glow from elevation, and that stays on the chip: on the fill it
    // would lift the blue over the chip's own label.
    chipActive: {
      borderColor: 'transparent',
      shadowColor: NIGHT.blue[1],
      elevation: 6,
    },
    /** A hairline past the chip on every side, over the clear edge the blue used to fill. */
    chipLit: {
      position: 'absolute',
      top: -StyleSheet.hairlineWidth,
      bottom: -StyleSheet.hairlineWidth,
      left: -StyleSheet.hairlineWidth,
      right: -StyleSheet.hairlineWidth,
      borderRadius: 50,
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 10,
    },
    chipFill: { borderRadius: 50 },
    chipText: { ...font(600), fontSize: 14, color: colors.text },
    chipTextActive: { ...font(700), color: colors.primaryText },

    iconSquare: {
      width: 40,
      height: 40,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── Intro and permissions: the same row, one with a button on the end ──
    introList: { gap: 7 },
    introRow: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 13,
      borderRadius: 16,
      padding: spacing.md,
    },
    introTitle: { ...font(600), fontSize: 15.5, color: colors.text },
    introBody: { ...font(400), fontSize: 13, color: colors.textMuted, lineHeight: 18, marginTop: 2 },

    permRow: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 13,
      borderRadius: 16,
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
      // Quiet on purpose: Continue is the button the page is asking for.
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
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

    /** The same field `Field` draws everywhere else, at the size a question wants. */
    input: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: 16,
      paddingVertical: 16,
      fontSize: 16,
      ...font(500),
      color: colors.text,
    },
    inputTall: { minHeight: 110 },

    sleepPrompt: { ...font(600), fontSize: 13.5, color: colors.textMuted, marginBottom: 8 },

    // The screen itself does not pad its sides, so the answers can scroll out to
    // the edges; the head of the page and the footer carry their own.
    footer: { gap: spacing.sm + 2, paddingTop: spacing.sm, paddingHorizontal: spacing.md + 4 },
    footerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    /** Back and skip: glass, sized to the word, a step below Continue. */
    quietBtn: {
      ...glass,
      alignSelf: 'flex-start',
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderRadius: 50,
    },
    quietBtnText: { ...font(600), fontSize: 14, color: colors.textMuted },

    doneBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
    doneMark: { marginBottom: spacing.md },
  }),
);
