import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  View,
  Text,
  TextInput,
  Switch,
  StyleSheet,
  Alert,
  Image,
  Linking,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import {
  User,
  Bell,
  CheckCircle2,
  ListTodo,
  Flame,
  CalendarDays,
  Pencil,
  Database,
  Trash2,
  Languages,
  Moon,
  Sun,
  Shield,
  ScrollText,
  Mail,
  FileText,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CalendarClock,
  X,
} from 'lucide-react-native';

import { Screen, GreetingHeader, Card, Button, LitDisc } from '../components/ui';
import {
  CountUp,
  Entrance,
  PopIn,
  Pressable,
  animateLayout,
  useGrow,
  useReducedMotion,
} from '../components/motion';
import {
  HourRangePicker,
  BufferPicker,
  TaskLeadPicker,
  EventTypePicker,
  GenderPicker,
  SleepInsight,
  CountryPicker,
} from '../components/ProfileFields';
import {
  storage,
  defaultSettings,
  defaultProfile,
  type Settings,
  type Profile,
} from '../lib/storage';
import { getNotificationState, requestNotifications } from '../lib/permissions';
import { cancelAllReminders } from '../lib/notifications';
import { stopGeofencing } from '../lib/geofencing';
import { unregisterProactiveTask } from '../lib/proactive';
import { getAppearance, setAppearance } from '../lib/appearance';
import { PersonalizationField, PERSONALIZATION_QUESTIONS } from '../components/PersonalizationFields';
import { api, type Task, type Event } from '../lib/api';
import { toDateStr, isLive } from '../lib/tasks';
import { colors, spacing, font, radius, type AuraKey, AURA, NIGHT, themed } from '../theme';
import {
  t,
  LANGUAGES,
  getVoiceLanguage,
  setLanguage,
  alignStart,
  isRTL,
  type Language,
} from '../lib/i18n';

// Placeholder portrait, matching the Today header avatar.
const PROFILE_PHOTO_URI = 'https://i.pravatar.cc/220?img=47';

// ── Support and legal ─────────────────────────────────────────────────────
// Point these at the real pages before submitting to the App Store: a
// reachable privacy policy is a review requirement, not a nicety.
const LEGAL_URLS = {
  privacy: 'https://example.com/privacy',
  terms: 'https://example.com/terms',
};
const SUPPORT_EMAIL = 'support@example.com';

/** Language chips shown before the list is expanded — about two rows. */
const COLLAPSED_LANGUAGES = 6;

type Icon = typeof ListTodo;

/** Opens a URL, saying so plainly when the device has nothing to open it. */
async function openLink(url: string): Promise<void> {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert(t('profile.linkFailed'), url);
  }
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'U'
  );
}

/**
 * The mark beside a card's title: the card's hue at a whisper, its glyph lit
 * in the same hue. A tint rather than a lit disc on purpose — on this screen,
 * as on Home, the lit discs stand behind counts, and a title is not one. With
 * no hue it is the quiet grey of a thing that is only housekeeping.
 */
function IconDisc({ tile, Glyph }: { tile?: AuraKey; Glyph: Icon }) {
  return (
    <View style={[styles.iconDisc, { backgroundColor: tile ? AURA[tile].tint : NIGHT.cardAlt }]}>
      <Glyph color={tile ? AURA[tile].ink : colors.textMuted} size={18} strokeWidth={2} />
    </View>
  );
}

/**
 * One figure in the hero's stat strip, on a lit disc like Home's counts.
 *
 * The four land one after another rather than together, each counting up as
 * it arrives, so the strip reads as being tallied instead of printed.
 */
function HeroStat({
  Glyph,
  disc,
  value,
  label,
  delay,
}: {
  Glyph: Icon;
  disc: readonly [string, string];
  value: number;
  label: string;
  delay: number;
}) {
  return (
    <Entrance delay={delay} from={10} style={styles.heroStat}>
      <LitDisc colors={disc} size={30} style={styles.heroStatDisc}>
        <Glyph color={NIGHT.glyph} size={15} strokeWidth={2.4} />
      </LitDisc>
      <CountUp value={value} style={styles.heroStatValue} />
      <Text style={styles.heroStatLabel}>{label}</Text>
    </Entrance>
  );
}

/** A figure on its hue: the tint for the ground, the lit ink for the glyph. */
function StatTile({
  tile,
  Glyph,
  value,
  label,
  delay,
}: {
  tile: AuraKey;
  Glyph: Icon;
  value: number;
  label: string;
  delay: number;
}) {
  return (
    // The entrance takes the tile's share of the row; the tile fills it.
    <Entrance delay={delay} style={styles.tileSlot}>
      <View style={[styles.tile, { backgroundColor: AURA[tile].tint }]}>
        {/* The tint again, over the tile's own: a deeper pool of the same hue. */}
        <View style={[styles.tileIcon, { backgroundColor: AURA[tile].tint }]}>
          <Glyph color={AURA[tile].ink} size={17} strokeWidth={2.2} />
        </View>
        <CountUp value={value} style={styles.tileValue} />
        <Text style={styles.tileLabel}>{label}</Text>
      </View>
    </Entrance>
  );
}

/**
 * The fold chevron on the languages' "more" chip: down while folded, turned
 * over to point up once open.
 *
 * One chevron turned, rather than a down one swapped for a popping up one: the
 * list opens with a layout animation, which fades in every view mounted in the
 * same change — and a pop drives that same opacity from the native side, so
 * the two would pull one view's opacity both ways at once. A view that stays
 * put and turns gives them nothing to share. Upside down, the down chevron is
 * the up one exactly.
 */
function FoldChevron({ open }: { open: boolean }) {
  const reduce = useReducedMotion();
  const turn = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    if (reduce) {
      turn.setValue(open ? 1 : 0);
      return;
    }
    const anim = Animated.spring(turn, {
      toValue: open ? 1 : 0,
      friction: 6,
      tension: 120,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [open, reduce, turn]);

  return (
    <Animated.View
      style={{
        transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }],
      }}
    >
      <ChevronDown color={colors.textMuted} size={15} strokeWidth={2.4} />
    </Animated.View>
  );
}

export default function SettingsScreen() {
  const navigation = useNavigation();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [events, setEvents] = useState<Event[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lang, setLang] = useState<Language>(getVoiceLanguage());
  const [allLanguages, setAllLanguages] = useState(false);

  /**
   * The languages on show, and how many are folded away.
   *
   * The app ships in enough languages now that laying them all out flat turned
   * this card into several screens of chips and pushed everything below it off
   * the page. Collapsed, it shows a couple of rows — always including the one
   * in use, which would otherwise vanish for anyone whose language sorts late
   * and leave the card looking like it had forgotten their choice.
   */
  const { shownLanguages, hiddenCount } = useMemo(() => {
    const codes = Object.keys(LANGUAGES) as Language[];
    if (allLanguages) return { shownLanguages: codes, hiddenCount: 0 };

    const head = codes.slice(0, COLLAPSED_LANGUAGES);
    if (!head.includes(lang)) head[head.length - 1] = lang;
    return { shownLanguages: head, hiddenCount: codes.length - head.length };
  }, [allLanguages, lang]);

  const pickLanguage = async (code: Language) => {
    if (code === lang) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Switching between an RTL and an LTR language restarts the app itself
    // where it can (the native direction flag is only read when a surface
    // starts). This is true only when it could not.
    await Promise.all([storage.saveSettings(settings), storage.saveProfile(profile)]);
    const restartByHand = await setLanguage(code);
    setLang(code);
    if (restartByHand) {
      Alert.alert(t('profile.restartTitle'), t('profile.restartBody'));
    }
  };

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const [s, p, notify] = await Promise.all([
        storage.getSettings(),
        storage.getProfile(),
        getNotificationState(),
      ]);
      if (!active) return;
      // The stored preference defaults to on, but the system permission behind
      // it defaults to nothing. Showing the switch on while the OS is dropping
      // every notification is the lie this screen used to tell; the OS wins.
      // Only a firm 'denied' overrides — an unreadable state is not evidence.
      setSettings(notify === 'denied' ? { ...s, notifications: false } : s);
      setProfile(p);
      try {
        // /me is the authoritative profile; the local displayName is only a
        // fallback for when there's no session yet.
        const [me, evRes, taskRes] = await Promise.all([
          api.getMe(),
          api.listEvents(),
          api.listTasks(),
        ]);
        if (!active) return;
        setSettings((prev) => ({ ...prev, displayName: me.user.name || prev.displayName }));
        // Sync endpoints include soft-deleted rows; drop them before counting.
        setEvents(evRes.events.filter(isLive));
        setTasks(taskRes.tasks.filter(isLive));
      } catch {
        /* offline; the local settings already loaded above still render */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  // Real figures from the API rather than a decorative counter.
  const stats = useMemo(() => {
    // Tasks carry an explicit isDone flag — no clock inference needed.
    const done = tasks.filter((t) => t.isDone).length;
    const open = tasks.length - done;

    // Consecutive days up to today that have at least one dated item.
    const dates = new Set<string>();
    for (const t of tasks) if (t.dueAt) dates.add(toDateStr(new Date(t.dueAt)));
    for (const e of events) dates.add(toDateStr(new Date(e.startsAt)));
    let streak = 0;
    const cursor = new Date();
    while (dates.has(toDateStr(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return { total: tasks.length, done, open, streak, events: events.length };
  }, [events, tasks]);

  const completion = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  // The bar keeps its sliver at zero, so it grows to that rather than to
  // nothing. Held back until the hero has landed, so the growth is seen.
  const completionGrow = useGrow(Math.max(completion, 2) / 100, 360);

  /**
   * Read while rendering rather than from `StyleSheet.create`: stylesheets are
   * built when the module is first imported, which can be before the language
   * has resolved, and a start-aligned label baked in as `left` sits at the
   * wrong edge of every Hebrew and Arabic card.
   */
  const alignStartStyle = { textAlign: alignStart() } as const;
  const rtl = isRTL();
  // A row's way onward points along the reading direction, as "See all" does
  // on Home: right in English, left in Hebrew and Arabic.
  const Onward = rtl ? ChevronLeft : ChevronRight;

  /**
   * Turning reminders on is a request, not a preference.
   *
   * The switch used to flip on its own and change nothing: the system
   * permission behind it was asked for separately, the first time a reminder
   * was scheduled, so someone who had refused there saw a switch that said
   * "on" above notifications that never arrived. Now the switch asks, and
   * refuses to claim it is on when it is not.
   */
  const toggleNotifications = async (on: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!on) {
      setSettings((s) => ({ ...s, notifications: false }));
      await cancelAllReminders();
      void stopGeofencing();
      void unregisterProactiveTask();
      return;
    }

    const state = await requestNotifications();
    setSettings((s) => ({ ...s, notifications: state === 'granted' }));
    if (state === 'denied') {
      // Refused once, iOS never prompts again; the only route left is the
      // system settings, so say that rather than leaving a dead switch.
      Alert.alert(t('profile.notificationsBlocked'), t('profile.notificationsBlockedBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('profile.openSettings'), onPress: () => Linking.openSettings() },
      ]);
    }
  };

  const save = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await Promise.all([storage.saveSettings(settings), storage.saveProfile(profile)]);
    // Mirror the name onto the device profile so other screens can read it.
    if (settings.displayName.trim()) {
      await api.updateMe({ name: settings.displayName.trim() });
    }
    Alert.alert(t('profile.saved'), t('profile.savedBody'));
  };

  const contactSupport = () =>
    openLink(
      `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(t('profile.contactSubject'))}`,
    );

  /**
   * There is no account to close — everything lives on this device — so
   * "delete my account" means erasing all of it, which is what the store
   * policy is actually asking for.
   */
  const deleteAccount = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(t('profile.deleteAccount'), t('profile.deleteAccountBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.deleteEverything'),
        style: 'destructive',
        onPress: async () => {
          await api.clearAll();
          await storage.saveSettings({ ...defaultSettings });
          setSettings(defaultSettings);
          load();
          Alert.alert(t('profile.deleted'), t('profile.deletedBody'));
        },
      },
    ]);
  };

  const clearData = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(t('profile.clearConfirm'), t('profile.clearConfirmBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.deleteEverything'),
        style: 'destructive',
        onPress: async () => {
          await api.clearAll();
          load();
        },
      },
    ]);
  };

  return (
    // A modal: no tab bar to clear.
    <Screen clearTabBar={false}>
      {/* Settings opens as a modal from Finance now that it has no tab of
          its own, so it has to carry its own way out.

          The page builds top to bottom in the order it is read: the way out,
          the greeting, the headline, the hero and its counts, the tiles, then
          each card — a beat apart, so the eye is led down the page. */}
      <Entrance delay={0} from={12} style={styles.closeRow}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressedDim]}
          accessibilityRole="button"
          accessibilityLabel={t('notes.close')}
        >
          <X color={colors.text} size={20} strokeWidth={2.2} />
        </Pressable>
      </Entrance>
      <Entrance delay={50} from={12}>
        <GreetingHeader
          name={t('today.hello', { name: settings.displayName || t('today.friend') })}
          photoUri={PROFILE_PHOTO_URI}
          onAppearancePress={() => {
            void Promise.all([storage.saveSettings(settings), storage.saveProfile(profile)])
              .then(() => setAppearance(getAppearance() === 'dark' ? 'light' : 'dark'));
          }}
          onBellPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
        />
      </Entrance>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Entrance delay={100} from={16}>
          <Text style={[styles.headline, alignStartStyle]}>
            {t('profile.headline.line1')} {t('profile.headline.line2')}
          </Text>
        </Entrance>

        {/* ── Hero: the one big surface. Glass like every card on Home, so it
            leads by what it holds — the face, the bar, the counts — rather
            than by a colour of its own. ── */}
        <Entrance delay={160} from={18}>
          <View style={styles.hero}>
            <View style={styles.heroTop}>
              <View style={styles.avatarRing}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {initialsOf(settings.displayName || 'You')}
                  </Text>
                  <Image source={{ uri: PROFILE_PHOTO_URI }} style={styles.avatarPhoto} />
                </View>
              </View>
              <View style={{ flex: 1, marginStart: 14 }}>
                <Text style={styles.heroName} numberOfLines={1}>
                  {settings.displayName || t('profile.yourName')}
                </Text>
                <Text style={styles.heroSub}>{t('profile.workspace')}</Text>
                <View style={styles.statusPill}>
                  <View style={[styles.statusDot, { backgroundColor: AURA.green.ink }]} />
                  <Text style={styles.statusText}>{t('profile.onDevice')}</Text>
                </View>
              </View>
            </View>

            {/* Completion bar, filled with the blue a ticked row fills with on
                Home: the bar is how many of those ticks there are. It grows
                from the reading edge, so its light end is turned to match.

                The figure counts and the bar grows together, to the same
                value. The growing width is a plain view, with the gradient
                laid inside it: the gradient spans whatever width the bar has
                reached, as it spanned the fixed one. */}
            <View style={styles.progressBlock}>
              <View style={styles.progressLabelRow}>
                <Text style={styles.progressLabel}>{t('profile.completion')}</Text>
                <CountUp
                  value={completion}
                  format={(n) => `${Math.round(n)}%`}
                  style={styles.progressPct}
                />
              </View>
              <View style={styles.progressTrack}>
                <Animated.View
                  style={[
                    styles.progressFill,
                    {
                      width: completionGrow.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0%', '100%'],
                      }),
                    },
                  ]}
                >
                  <LinearGradient
                    colors={NIGHT.discs.tasks}
                    start={{ x: rtl ? 1 : 0, y: 0 }}
                    end={{ x: rtl ? 0 : 1, y: 0 }}
                    style={[StyleSheet.absoluteFill, styles.progressPaint]}
                  />
                </Animated.View>
              </View>
            </View>

            <View style={styles.heroDivider} />

            {/* Four counts, and Home only has three disc colours. "Done" takes
                the blue a ticked row fills with, the total the paler blue
                beside it, the streak the warm one; the calendar borrows the
                timeline's deeper blue, so no two neighbours share a colour.
                They follow the hero in, once it has mostly landed. */}
            <View style={styles.heroStatsRow}>
              <HeroStat
                Glyph={ListTodo}
                disc={NIGHT.discs.reminders}
                value={stats.total}
                label={t('profile.stat.tasks')}
                delay={280}
              />
              <HeroStat
                Glyph={CheckCircle2}
                disc={NIGHT.discs.tasks}
                value={stats.done}
                label={t('profile.stat.done')}
                delay={330}
              />
              <HeroStat
                Glyph={Flame}
                disc={NIGHT.discs.meetings}
                value={stats.streak}
                label={t('profile.stat.streak')}
                delay={380}
              />
              <HeroStat
                Glyph={CalendarDays}
                disc={NIGHT.blocks[2]}
                value={stats.events}
                label={t('profile.stat.events')}
                delay={430}
              />
            </View>
          </View>
        </Entrance>

        {/* ── Quick stat tiles ── */}
        <View style={styles.tileRow}>
          <StatTile
            tile="blue"
            Glyph={ListTodo}
            value={stats.open}
            label={t('profile.openTasks')}
            delay={230}
          />
          <StatTile
            tile="yellow"
            Glyph={CheckCircle2}
            value={stats.done}
            label={t('profile.completed')}
            delay={290}
          />
        </View>

        {/* ── Display name ── */}
        <Card delay={340} style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <IconDisc tile="green" Glyph={User} />
            <Text style={styles.cardTitle}>{t('profile.displayName')}</Text>
          </View>
          <View style={styles.inputWrap}>
            <TextInput
              value={settings.displayName}
              onChangeText={(displayName) => setSettings((s) => ({ ...s, displayName }))}
              placeholder={t('profile.yourName')}
              placeholderTextColor={colors.textMuted}
              selectionColor={NIGHT.blue[0]}
              style={styles.input}
            />
            <Pencil color={colors.textMuted} size={15} style={styles.inputIcon} />
          </View>
        </Card>

        {/* ── Notifications ── */}
        <Card delay={400} style={styles.card}>
          <View style={[styles.cardHeaderRow, { marginBottom: 0 }]}>
            <IconDisc tile="yellow" Glyph={Bell} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.notifications')}</Text>
              <Text style={styles.mutedText}>{t('profile.notificationsBody')}</Text>
            </View>
            {/* On is the app's blue, off a step off the card. The track is
                flat: a native switch takes a colour, not a gradient. */}
            <Switch
              value={settings.notifications}
              onValueChange={toggleNotifications}
              trackColor={{ true: NIGHT.blue[1], false: NIGHT.cardAlt }}
              ios_backgroundColor={NIGHT.cardAlt}
              thumbColor={colors.primaryText}
            />
          </View>
        </Card>

        {/* ── Light or dark ──
             Applies the moment it is tapped, to the whole app: the tokens are
             rewritten and the tree rebuilt around this screen, which stays
             open (see App.tsx), so the change is seen where it was made. ── */}
        <Card delay={430} style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <IconDisc tile="blue" Glyph={getAppearance() === 'dark' ? Moon : Sun} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.appearance')}</Text>
              <Text style={styles.mutedText}>{t('profile.appearanceBody')}</Text>
            </View>
          </View>
          <View style={styles.schemeRail} accessibilityRole="radiogroup">
            {(['dark', 'light'] as const).map((option) => {
              const active = getAppearance() === option;
              const Glyph = option === 'dark' ? Moon : Sun;
              return (
                <Pressable
                  key={option}
                  onPress={() => {
                    if (active) return;
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    void Promise.all([storage.saveSettings(settings), storage.saveProfile(profile)])
                      .then(() => setAppearance(option));
                  }}
                  style={styles.schemeCell}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={t(`profile.appearance.${option}`)}
                >
                  {active ? (
                    <PopIn style={styles.schemeFill} from={0.6}>
                      <LinearGradient
                        colors={NIGHT.blue}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 0, y: 1 }}
                        style={[StyleSheet.absoluteFill, styles.schemeFillGradient]}
                      />
                    </PopIn>
                  ) : null}
                  {/* In a View of its own: on the web the fill is positioned and a
                      bare svg is not, so the fill would paint over the glyph. */}
                  <View style={styles.schemeLabel} pointerEvents="none">
                    <Glyph
                      color={active ? colors.primaryText : colors.textMuted}
                      size={17}
                      strokeWidth={2.2}
                    />
                    <Text style={[styles.schemeText, active && styles.schemeTextActive]}>
                      {t(`profile.appearance.${option}`)}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Card>

        {/* ── How the week is shaped ──
             The answers from the opening questionnaire, which until now could
             only be given once. They ride along with every voice turn and are
             what keep her from offering a meeting at two in the morning, so
             they have to be changeable when someone changes job or shift.
             The pickers keep their own glass ground: inside this card it
             stacks a step brighter, which is the lift they need. ── */}
        <Card delay={460} style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <IconDisc tile="blue" Glyph={CalendarClock} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.week')}</Text>
              <Text style={styles.mutedText}>{t('profile.weekBody')}</Text>
            </View>
          </View>

          <Text style={[styles.fieldLabel, alignStartStyle]}>{t('onboarding.place.title')}</Text>
          <CountryPicker
            country={profile.country}
            currency={profile.currency}
            onChange={({ country, currency }) =>
              setProfile((p) => ({ ...p, country, currency }))
            }
          />

          <Text style={[styles.fieldLabel, alignStartStyle, { marginTop: spacing.md }]}>
            {t('onboarding.work.title')}
          </Text>
          <HourRangePicker
            from={profile.workStartHour}
            to={profile.workEndHour}
            onFrom={(workStartHour) => setProfile((p) => ({ ...p, workStartHour }))}
            onTo={(workEndHour) => setProfile((p) => ({ ...p, workEndHour }))}
            tile="green"
          />

          <Text style={[styles.fieldLabel, alignStartStyle]}>{t('onboarding.sleep.title')}</Text>
          <Text style={[styles.mutedText, alignStartStyle, { marginBottom: spacing.sm }]}>
            {t('onboarding.sleep.genderPrompt')}
          </Text>
          <GenderPicker
            value={profile.gender}
            onChange={(gender) => setProfile((p) => ({ ...p, gender }))}
          />
          <HourRangePicker
            from={profile.sleepStartHour}
            to={profile.sleepEndHour}
            onFrom={(sleepStartHour) => setProfile((p) => ({ ...p, sleepStartHour }))}
            onTo={(sleepEndHour) => setProfile((p) => ({ ...p, sleepEndHour }))}
            tile="blue"
          />
          <SleepInsight
            gender={profile.gender}
            startHour={profile.sleepStartHour}
            endHour={profile.sleepEndHour}
          />

          <Text style={[styles.fieldLabel, alignStartStyle, { marginTop: spacing.md }]}>
            {t('onboarding.buffer.title')}
          </Text>
          <BufferPicker
            value={profile.bufferMinutes}
            onChange={(bufferMinutes) => setProfile((p) => ({ ...p, bufferMinutes }))}
          />

          <Text style={[styles.fieldLabel, alignStartStyle, { marginTop: spacing.md }]}>
            {t('onboarding.reminder.title')}
          </Text>
          <TaskLeadPicker
            value={profile.taskReminderMinutes}
            onChange={(taskReminderMinutes) =>
              setProfile((p) => ({ ...p, taskReminderMinutes }))
            }
          />

          <Text style={[styles.fieldLabel, alignStartStyle, { marginTop: spacing.md }]}>
            {t('onboarding.types.title')}
          </Text>
          <EventTypePicker
            value={profile.eventTypes}
            onChange={(eventTypes) => setProfile((p) => ({ ...p, eventTypes }))}
          />

          <Text style={[styles.fieldLabel, alignStartStyle, { marginTop: spacing.md }]}>
            {t('onboarding.fixed.title')}
          </Text>
          <TextInput
            value={profile.fixedCommitments}
            onChangeText={(fixedCommitments) => setProfile((p) => ({ ...p, fixedCommitments }))}
            placeholder={t('onboarding.fixed.placeholder')}
            placeholderTextColor={colors.textMuted}
            selectionColor={NIGHT.blue[0]}
            style={[styles.input, styles.inputTall, alignStartStyle]}
            multiline
            textAlignVertical="top"
            maxLength={500}
          />
          {PERSONALIZATION_QUESTIONS.map((question) => (
            <View key={question} style={{ marginTop: spacing.md }}>
              <Text style={[styles.fieldLabel, alignStartStyle]}>{t(`onboarding.${question}.title`)}</Text>
              <Text style={[styles.mutedText, alignStartStyle, { marginBottom: spacing.sm }]}>{t(`onboarding.${question}.body`)}</Text>
              <PersonalizationField question={question} profile={profile}
                onChange={(patch) => setProfile((p) => ({ ...p, ...patch }))} />
            </View>
          ))}
        </Card>

        {/* ── Language ── */}
        <Card delay={520} style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <IconDisc tile="blue" Glyph={Languages} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.language')}</Text>
              <Text style={styles.mutedText}>{t('profile.languageBody')}</Text>
            </View>
          </View>
          <View style={styles.langGrid}>
            {shownLanguages.map((code) => {
              const active = code === lang;
              return (
                <Pressable
                  key={code}
                  onPress={() => pickLanguage(code)}
                  style={[styles.langChip, active ? styles.langChipActive : styles.langChipIdle]}
                >
                  {/* The one in use is lit like every chosen thing. Rounded
                      itself rather than clipped by the chip: clipping on iOS
                      takes the chip's glow with it.

                      The light springs up on the chip the moment it is
                      chosen: it mounts only on the chosen one, and mounting
                      is what pops it. */}
                  {active ? (
                    <PopIn style={StyleSheet.absoluteFill}>
                      <LinearGradient
                        colors={NIGHT.blue}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 0, y: 1 }}
                        style={[StyleSheet.absoluteFill, styles.langChipFill]}
                      />
                    </PopIn>
                  ) : null}
                  <Text style={[styles.langChipText, active && styles.langChipTextActive]}>
                    {LANGUAGES[code].native}
                  </Text>
                </Pressable>
              );
            })}
            {/* The chip that opens the rest. A count and a chevron rather than
                a word, so it needs no translation of its own — and the label
                for it would be the one string on the screen guaranteed to be
                in a language the user is trying to leave. */}
            {hiddenCount > 0 || allLanguages ? (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  // The rest of the chips open a space and fade into it, and
                  // the cards below slide down to make room, instead of the
                  // page jumping by several rows.
                  animateLayout();
                  setAllLanguages((open) => !open);
                }}
                style={[styles.langChip, styles.langChipIdle, styles.langChipMore]}
                accessibilityRole="button"
                accessibilityLabel={t('profile.language')}
                accessibilityState={{ expanded: allLanguages }}
              >
                <FoldChevron open={allLanguages} />
                {allLanguages ? null : (
                  <Text style={styles.langChipMoreText}>{hiddenCount}</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </Card>

        {/* ── Local data ── */}
        <Card delay={580} style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <IconDisc Glyph={Database} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.storage')}</Text>
              <Text style={styles.mutedText}>{t('profile.storageBody')}</Text>
            </View>
          </View>
          <Pressable
            onPress={clearData}
            style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressedDim]}
          >
            <Trash2 color={colors.danger} size={16} />
            <Text style={styles.dangerBtnText}>{t('profile.clearData')}</Text>
          </Pressable>
        </Card>

        {/* ── Legal and support ──
             The App Store requires a reachable privacy policy and a way to
             erase everything; the rest is the usual footer. LEGAL_URLS and
             SUPPORT_EMAIL at the top of this file are what these open. The
             links share the card as one list, split by hairlines. */}
        <Card delay={640} style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <IconDisc tile="green" Glyph={FileText} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.legal')}</Text>
              <Text style={styles.mutedText}>{t('profile.legalBody')}</Text>
            </View>
          </View>

          <Pressable
            onPress={() => openLink(LEGAL_URLS.privacy)}
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressedDim]}
          >
            <Shield color={colors.text} size={20} strokeWidth={1.7} />
            <Text style={[styles.linkText, alignStartStyle]}>{t('profile.privacy')}</Text>
            <Onward color={colors.textMuted} size={20} strokeWidth={1.7} />
          </Pressable>

          <Pressable
            onPress={() => openLink(LEGAL_URLS.terms)}
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressedDim]}
          >
            <ScrollText color={colors.text} size={20} strokeWidth={1.7} />
            <Text style={[styles.linkText, alignStartStyle]}>{t('profile.terms')}</Text>
            <Onward color={colors.textMuted} size={20} strokeWidth={1.7} />
          </Pressable>

          <Pressable
            onPress={contactSupport}
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressedDim]}
          >
            <Mail color={colors.text} size={20} strokeWidth={1.7} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.linkText, alignStartStyle]}>{t('profile.contact')}</Text>
              <Text style={[styles.linkMeta, alignStartStyle]}>{SUPPORT_EMAIL}</Text>
            </View>
            <Onward color={colors.textMuted} size={20} strokeWidth={1.7} />
          </Pressable>

          <Pressable
            onPress={deleteAccount}
            style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressedDim]}
          >
            <Trash2 color={colors.danger} size={16} />
            <Text style={styles.dangerBtnText}>{t('profile.deleteAccount')}</Text>
          </Pressable>
        </Card>

        {/* ── Save ──
             Last in, closing the build. It stays still once it has landed:
             it is always there to press, changed or not, and one breathing
             at the foot of every visit would nag. The saved message is the
             system alert, which brings its own motion. */}
        <Entrance delay={700} from={14}>
          <View style={{ height: spacing.xs }} />
          <Button label={t('profile.save')} onPress={save} />
        </Entrance>
      </ScrollView>
    </Screen>
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
    /** A press that reads as a press without moving anything under the finger. */
    pressedDim: { opacity: 0.72 },

    closeRow: { flexDirection: 'row', marginBottom: spacing.sm },
    /** The bell's disc, a size down: the two round buttons are one family. */
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: { paddingTop: spacing.md, paddingBottom: spacing.md },

    headline: {
      fontSize: 36,
      lineHeight: 40,
      ...font(700),
      color: colors.text,
      letterSpacing: -1,
      marginBottom: spacing.md + 2,
    },

    /**
     * `Card` paints an opaque surface; the cards here are glass instead, so the
     * page's glow shows through them the way it does through Home's.
     */
    card: { ...glass },

    // ── Hero ──
    hero: {
      ...glass,
      borderRadius: radius.lg,
      padding: spacing.md + 4,
      marginBottom: spacing.md,
    },
    heroTop: { flexDirection: 'row', alignItems: 'center' },
    avatarRing: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: NIGHT.cardAlt,
    },
    avatar: {
      width: 62,
      height: 62,
      borderRadius: 31,
      backgroundColor: NIGHT.cardAlt,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    avatarText: { ...font(700), fontSize: 21, color: colors.text },
    avatarPhoto: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
    heroName: { ...font(700), fontSize: 20, color: colors.text, letterSpacing: -0.3 },
    heroSub: { ...font(500), fontSize: 14, color: colors.textMuted, marginTop: 1 },
    statusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: AURA.green.tint,
      borderRadius: 50,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginTop: 8,
    },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusText: { ...font(600), fontSize: 11.5, color: colors.text },

    progressBlock: { marginTop: spacing.md + 2 },
    progressLabelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 7,
    },
    progressLabel: { ...font(500), fontSize: 13, color: colors.textMuted },
    progressPct: { ...font(700), fontSize: 13.5, color: colors.text },
    progressTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: NIGHT.cardAlt,
      overflow: 'hidden',
    },
    progressFill: { height: '100%', borderRadius: 4 },
    progressPaint: { borderRadius: 4 },

    heroDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: NIGHT.line,
      marginVertical: spacing.md,
    },
    heroStatsRow: { flexDirection: 'row', justifyContent: 'space-between' },
    heroStat: { alignItems: 'center', flex: 1 },
    heroStatDisc: { marginBottom: 7 },
    heroStatValue: { ...font(700), fontSize: 18, color: colors.text },
    heroStatLabel: {
      ...font(500),
      fontSize: 11.5,
      color: colors.textMuted,
      marginTop: 1,
    },

    // ── Quick tiles ──
    tileRow: { flexDirection: 'row', gap: 10, marginBottom: spacing.md },
    tileSlot: { flex: 1 },
    tile: {
      flex: 1,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      padding: spacing.md,
    },
    tileIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 10,
    },
    tileValue: { ...font(700), fontSize: 22, color: colors.text, letterSpacing: -0.4 },
    tileLabel: { ...font(500), fontSize: 13, color: colors.textMuted, marginTop: 1 },

    cardHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 14,
    },
    iconDisc: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardTitle: { ...font(600), fontSize: 16, color: colors.text },
    mutedText: { ...font(500), fontSize: 13.5, color: colors.textMuted, lineHeight: 19 },

    inputWrap: { justifyContent: 'center' },
    /** `Field`'s look, a radius tighter to sit inside a card. */
    input: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 15,
      paddingEnd: 38,
      fontSize: 15,
      ...font(400),
      color: colors.text,
    },
    inputIcon: { position: 'absolute', end: 14 },
    inputTall: { minHeight: 92, paddingEnd: 14 },

    /** Sits above a picker inside a card — the question, in a quieter voice. */
    fieldLabel: {
      ...font(600),
      fontSize: 13,
      color: colors.textMuted,
      marginBottom: 8,
    },

    /** Light or dark: two halves of one glass rail, the one in force lit. */
    schemeRail: {
      ...glass,
      flexDirection: 'row',
      height: 50,
      borderRadius: 14,
      padding: 4,
      gap: 4,
    },
    schemeCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    /** No `overflow: hidden` and no elevation: see Home's chosen day. */
    schemeFill: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      borderRadius: 11,
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.45,
      shadowRadius: 10,
    },
    schemeFillGradient: { borderRadius: 11 },
    schemeLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    schemeText: { ...font(600), fontSize: 15, color: colors.textMuted },
    schemeTextActive: { color: colors.primaryText },

    langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    langChip: {
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: 50,
      borderWidth: StyleSheet.hairlineWidth,
    },
    langChipIdle: { backgroundColor: NIGHT.card, borderColor: NIGHT.line },
    /** Under the gradient: its lower stop, which the glow is cast from on iOS. */
    langChipActive: {
      backgroundColor: NIGHT.blue[1],
      borderColor: 'transparent',
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 10,
      elevation: 6,
    },
    langChipFill: { borderRadius: 50 },
    // One weight either way, so the chip in use is no wider than it was idle.
    langChipText: { ...font(600), fontSize: 13.5, color: colors.textMuted },
    langChipTextActive: { color: colors.primaryText },
    langChipMore: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    langChipMoreText: { ...font(600), fontSize: 13.5, color: colors.textMuted },

    /** A settings row inside the card, a hairline above it to split the list. */
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      minHeight: 60,
      paddingVertical: 9,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: NIGHT.line,
    },
    linkText: { flex: 1, ...font(600), fontSize: 16, color: colors.text },
    linkMeta: { ...font(500), fontSize: 14, color: colors.textMuted, marginTop: 2 },

    /** Destructive, and quiet about it: red type on a step off the card. */
    dangerBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 12,
      minHeight: 52,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: 50,
      paddingVertical: 14,
    },
    dangerBtnText: { ...font(600), fontSize: 15, color: colors.danger },
  }),
);
