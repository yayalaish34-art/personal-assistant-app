import { useCallback, useMemo, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Switch,
  StyleSheet,
  Alert,
  Pressable,
  Image,
  Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
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
  Shield,
  ScrollText,
  Mail,
  FileText,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CalendarClock,
} from 'lucide-react-native';

import { Screen, GreetingHeader, Card, Button } from '../components/ui';
import {
  HourRangePicker,
  BufferPicker,
  EventTypePicker,
  GenderPicker,
  SleepInsight,
} from '../components/ProfileFields';
import {
  storage,
  defaultSettings,
  defaultProfile,
  type Settings,
  type Profile,
} from '../lib/storage';
import { getNotificationState, requestNotifications } from '../lib/permissions';
import { api, type Task, type Event } from '../lib/api';
import { toDateStr, isLive } from '../lib/tasks';
import { colors, spacing, font, radius, TILES, TILE_INK, type TileColor } from '../theme';
import { t, LANGUAGES, getLanguage, setLanguage, alignStart, type Language } from '../lib/i18n';

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

/** Tinted icon square, same pattern as a card row's leading glyph. */
function IconSquare({ tile, children }: { tile?: TileColor; children: React.ReactNode }) {
  return (
    <View style={[styles.iconSquare, { backgroundColor: tile ? TILES[tile] : TILES.neutral }]}>
      {children}
    </View>
  );
}

/** One figure in the hero's stat strip. */
function HeroStat({
  Icon,
  value,
  label,
}: {
  Icon: typeof ListTodo;
  value: number | string;
  label: string;
}) {
  return (
    <View style={styles.heroStat}>
      <View style={styles.heroStatIcon}>
        <Icon color={colors.text} size={15} />
      </View>
      <Text style={styles.heroStatValue}>{value}</Text>
      <Text style={styles.heroStatLabel}>{label}</Text>
    </View>
  );
}

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [events, setEvents] = useState<Event[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lang, setLang] = useState<Language>(getLanguage());
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

  /**
   * Read while rendering rather than from `StyleSheet.create`: stylesheets are
   * built when the module is first imported, which can be before the language
   * has resolved, and a start-aligned label baked in as `left` sits at the
   * wrong edge of every Hebrew and Arabic card.
   */
  const alignStartStyle = { textAlign: alignStart() } as const;

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
    <Screen>
      <GreetingHeader
        name={t('today.hello', { name: settings.displayName || t('today.friend') })}
        photoUri={PROFILE_PHOTO_URI}
        onBellPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.headline}>
          {t('profile.headline.line1')} {t('profile.headline.line2')}
        </Text>

        {/* ── Hero: the one big surface, flat sage — same weight as the
            Today screen's day card, not a glass panel of its own. ── */}
        <View style={[styles.hero, { backgroundColor: TILES.green }]}>
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
                <View style={[styles.statusDot, { backgroundColor: TILE_INK.green }]} />
                <Text style={styles.statusText}>{t('profile.onDevice')}</Text>
              </View>
            </View>
          </View>

          {/* Completion bar */}
          <View style={styles.progressBlock}>
            <View style={styles.progressLabelRow}>
              <Text style={styles.progressLabel}>{t('profile.completion')}</Text>
              <Text style={styles.progressPct}>{completion}%</Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.max(completion, 2)}%` }]} />
            </View>
          </View>

          <View style={styles.heroDivider} />

          <View style={styles.heroStatsRow}>
            <HeroStat Icon={ListTodo} value={stats.total} label={t('profile.stat.tasks')} />
            <HeroStat Icon={CheckCircle2} value={stats.done} label={t('profile.stat.done')} />
            <HeroStat Icon={Flame} value={stats.streak} label={t('profile.stat.streak')} />
            <HeroStat Icon={CalendarDays} value={stats.events} label={t('profile.stat.events')} />
          </View>
        </View>

        {/* ── Quick stat tiles ── */}
        <View style={styles.tileRow}>
          <View style={[styles.tile, { backgroundColor: TILES.blue }]}>
            <View style={styles.tileIcon}>
              <ListTodo color={colors.text} size={17} />
            </View>
            <Text style={styles.tileValue}>{stats.open}</Text>
            <Text style={styles.tileLabel}>{t('profile.openTasks')}</Text>
          </View>
          <View style={[styles.tile, { backgroundColor: TILES.yellow }]}>
            <View style={styles.tileIcon}>
              <CheckCircle2 color={colors.text} size={17} />
            </View>
            <Text style={styles.tileValue}>{stats.done}</Text>
            <Text style={styles.tileLabel}>{t('profile.completed')}</Text>
          </View>
        </View>

        {/* ── Display name ── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <IconSquare tile="green">
              <User color={TILE_INK.green} size={18} />
            </IconSquare>
            <Text style={styles.cardTitle}>{t('profile.displayName')}</Text>
          </View>
          <View style={styles.inputWrap}>
            <TextInput
              value={settings.displayName}
              onChangeText={(displayName) => setSettings((s) => ({ ...s, displayName }))}
              placeholder={t('profile.yourName')}
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
            <Pencil color={colors.textMuted} size={15} style={styles.inputIcon} />
          </View>
        </Card>

        {/* ── Notifications ── */}
        <Card>
          <View style={[styles.cardHeaderRow, { marginBottom: 0 }]}>
            <IconSquare tile="yellow">
              <Bell color={TILE_INK.yellow} size={18} />
            </IconSquare>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.notifications')}</Text>
              <Text style={styles.mutedText}>{t('profile.notificationsBody')}</Text>
            </View>
            <Switch
              value={settings.notifications}
              onValueChange={toggleNotifications}
              trackColor={{ true: colors.primary, false: colors.surfaceAlt }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        {/* ── How the week is shaped ──
             The answers from the opening questionnaire, which until now could
             only be given once. They ride along with every voice turn and are
             what keep her from offering a meeting at two in the morning, so
             they have to be changeable when someone changes job or shift. ── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <IconSquare tile="blue">
              <CalendarClock color={TILE_INK.blue} size={18} />
            </IconSquare>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.week')}</Text>
              <Text style={styles.mutedText}>{t('profile.weekBody')}</Text>
            </View>
          </View>

          <Text style={[styles.fieldLabel, alignStartStyle]}>{t('onboarding.work.title')}</Text>
          <HourRangePicker
            from={profile.workStartHour}
            to={profile.workEndHour}
            onFrom={(workStartHour) => setProfile((p) => ({ ...p, workStartHour }))}
            onTo={(workEndHour) => setProfile((p) => ({ ...p, workEndHour }))}
            tile="green"
            surface={TILES.neutral}
          />

          <Text style={[styles.fieldLabel, alignStartStyle]}>{t('onboarding.sleep.title')}</Text>
          <Text style={[styles.mutedText, alignStartStyle, { marginBottom: spacing.sm }]}>
            {t('onboarding.sleep.genderPrompt')}
          </Text>
          <GenderPicker
            value={profile.gender}
            onChange={(gender) => setProfile((p) => ({ ...p, gender }))}
            surface={TILES.neutral}
          />
          <HourRangePicker
            from={profile.sleepStartHour}
            to={profile.sleepEndHour}
            onFrom={(sleepStartHour) => setProfile((p) => ({ ...p, sleepStartHour }))}
            onTo={(sleepEndHour) => setProfile((p) => ({ ...p, sleepEndHour }))}
            tile="blue"
            surface={TILES.neutral}
          />
          <SleepInsight
            gender={profile.gender}
            startHour={profile.sleepStartHour}
            endHour={profile.sleepEndHour}
            surface={TILES.neutral}
          />

          <Text style={[styles.fieldLabel, alignStartStyle]}>{t('onboarding.buffer.title')}</Text>
          <BufferPicker
            value={profile.bufferMinutes}
            onChange={(bufferMinutes) => setProfile((p) => ({ ...p, bufferMinutes }))}
            surface={TILES.neutral}
          />

          <Text style={[styles.fieldLabel, alignStartStyle, { marginTop: spacing.md }]}>
            {t('onboarding.types.title')}
          </Text>
          <EventTypePicker
            value={profile.eventTypes}
            onChange={(eventTypes) => setProfile((p) => ({ ...p, eventTypes }))}
            surface={TILES.neutral}
          />

          <Text style={[styles.fieldLabel, alignStartStyle, { marginTop: spacing.md }]}>
            {t('onboarding.fixed.title')}
          </Text>
          <TextInput
            value={profile.fixedCommitments}
            onChangeText={(fixedCommitments) => setProfile((p) => ({ ...p, fixedCommitments }))}
            placeholder={t('onboarding.fixed.placeholder')}
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.inputTall, alignStartStyle]}
            multiline
            textAlignVertical="top"
          />
        </Card>

        {/* ── Language ── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <IconSquare tile="blue">
              <Languages color={TILE_INK.blue} size={18} />
            </IconSquare>
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
                  style={[styles.langChip, active && styles.langChipActive]}
                >
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
                  setAllLanguages((open) => !open);
                }}
                style={[styles.langChip, styles.langChipMore]}
                accessibilityRole="button"
                accessibilityLabel={t('profile.language')}
                accessibilityState={{ expanded: allLanguages }}
              >
                {allLanguages ? (
                  <ChevronUp color={colors.textMuted} size={15} strokeWidth={2.4} />
                ) : (
                  <>
                    <ChevronDown color={colors.textMuted} size={15} strokeWidth={2.4} />
                    <Text style={styles.langChipMoreText}>{hiddenCount}</Text>
                  </>
                )}
              </Pressable>
            ) : null}
          </View>
        </Card>

        {/* ── Local data ── */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <IconSquare>
              <Database color={colors.textMuted} size={18} />
            </IconSquare>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.storage')}</Text>
              <Text style={styles.mutedText}>{t('profile.storageBody')}</Text>
            </View>
          </View>
          <Pressable onPress={clearData} style={styles.ghostBtn}>
            <Trash2 color={colors.danger} size={16} />
            <Text style={[styles.ghostBtnText, { color: colors.danger }]}>
              {t('profile.clearData')}
            </Text>
          </Pressable>
        </Card>

        {/* ── Legal and support ──
             The App Store requires a reachable privacy policy and a way to
             erase everything; the rest is the usual footer. LEGAL_URLS and
             SUPPORT_EMAIL at the top of this file are what these open. */}
        <Card>
          <View style={styles.cardHeaderRow}>
            <IconSquare tile="green">
              <FileText color={TILE_INK.green} size={18} />
            </IconSquare>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.legal')}</Text>
              <Text style={styles.mutedText}>{t('profile.legalBody')}</Text>
            </View>
          </View>

          <Pressable onPress={() => openLink(LEGAL_URLS.privacy)} style={styles.linkRow}>
            <Shield color={colors.text} size={17} />
            <Text style={styles.linkText}>{t('profile.privacy')}</Text>
            <ChevronRight color={colors.textMuted} size={17} />
          </Pressable>

          <Pressable onPress={() => openLink(LEGAL_URLS.terms)} style={styles.linkRow}>
            <ScrollText color={colors.text} size={17} />
            <Text style={styles.linkText}>{t('profile.terms')}</Text>
            <ChevronRight color={colors.textMuted} size={17} />
          </Pressable>

          <Pressable onPress={contactSupport} style={styles.linkRow}>
            <Mail color={colors.text} size={17} />
            <View style={{ flex: 1 }}>
              <Text style={styles.linkText}>{t('profile.contact')}</Text>
              <Text style={styles.mutedText}>{SUPPORT_EMAIL}</Text>
            </View>
            <ChevronRight color={colors.textMuted} size={17} />
          </Pressable>

          <Pressable onPress={deleteAccount} style={styles.ghostBtn}>
            <Trash2 color={colors.danger} size={16} />
            <Text style={[styles.ghostBtnText, { color: colors.danger }]}>
              {t('profile.deleteAccount')}
            </Text>
          </Pressable>
        </Card>

        {/* ── Save ── */}
        <View style={{ height: spacing.xs }} />
        <Button label={t('profile.save')} onPress={save} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.md, paddingBottom: spacing.md },

  headline: {
    fontSize: 32,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.8,
    marginBottom: spacing.md,
  },

  // ── Hero ──
  hero: {
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
    borderColor: colors.surface,
  },
  avatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarText: { ...font(700), fontSize: 21, color: colors.text },
  avatarPhoto: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  heroName: { ...font(700), fontSize: 20, color: colors.text, letterSpacing: -0.3 },
  heroSub: { ...font(500), fontSize: 13, color: colors.text, opacity: 0.7, marginTop: 1 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: 50,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 8,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { ...font(600), fontSize: 11, color: colors.text },

  progressBlock: { marginTop: spacing.md + 2 },
  progressLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 7,
  },
  progressLabel: { ...font(500), fontSize: 12.5, color: colors.text, opacity: 0.75 },
  progressPct: { ...font(700), fontSize: 13, color: colors.text },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: colors.text },

  heroDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  heroStatsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  heroStat: { alignItems: 'center', flex: 1 },
  heroStatIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  heroStatValue: { ...font(700), fontSize: 17, color: colors.text },
  heroStatLabel: {
    ...font(400),
    fontSize: 10.5,
    color: colors.text,
    opacity: 0.7,
    marginTop: 1,
  },

  // ── Quick tiles ──
  tileRow: { flexDirection: 'row', gap: 10, marginBottom: spacing.md },
  tile: { flex: 1, borderRadius: radius.md, padding: spacing.md },
  tileIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  tileValue: { ...font(700), fontSize: 22, color: colors.text, letterSpacing: -0.4 },
  tileLabel: { ...font(500), fontSize: 12, color: colors.text, opacity: 0.7, marginTop: 1 },

  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  iconSquare: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { ...font(600), fontSize: 16, color: colors.text },
  mutedText: { ...font(400), fontSize: 12.5, color: colors.textMuted, lineHeight: 18 },

  inputWrap: { justifyContent: 'center' },
  input: {
    backgroundColor: TILES.neutral,
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
    fontSize: 13.5,
    color: colors.textMuted,
    marginBottom: 8,
  },

  langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  langChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 50,
    backgroundColor: TILES.neutral,
  },
  langChipActive: { backgroundColor: colors.primary },
  langChipText: { ...font(600), fontSize: 13.5, color: colors.primary },
  langChipTextActive: { color: colors.primaryText },
  langChipMore: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  langChipMoreText: { ...font(600), fontSize: 13.5, color: colors.textMuted },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
  },
  linkText: { flex: 1, ...font(600), fontSize: 14.5, color: colors.text },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 50,
    paddingVertical: 15,
  },
  ghostBtnText: { ...font(500), fontSize: 14, color: colors.primary },
});
