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
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import {
  User,
  Globe,
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
} from 'lucide-react-native';

import { Screen } from '../components/ui';
import { storage, defaultSettings, Settings } from '../lib/storage';
import { api, type Task, type Event } from '../lib/api';
import { toDateStr, isLive } from '../lib/tasks';
import { colors, spacing, font, ACCENT_GRADIENT, TILES, TILE_INK } from '../theme';
import { t, LANGUAGES, getLanguage, setLanguage, type Language } from '../lib/i18n';

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

// Lavender icon square, same pattern as the Today's Progress stat rows.
function IconSquare({ children }: { children: React.ReactNode }) {
  return <View style={styles.iconSquare}>{children}</View>;
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

/** Glass panel used by every settings card, matching the other screens. */
function GlassCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  return (
    <LinearGradient
      colors={[colors.surface, colors.surface, colors.surface]}
      locations={[0, 0.55, 1]}
      start={{ x: 0.05, y: 0 }}
      end={{ x: 0.95, y: 1 }}
      style={[styles.card, style]}
    >
      {children}
    </LinearGradient>
  );
}

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [events, setEvents] = useState<Event[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [lang, setLang] = useState<Language>(getLanguage());

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
      const s = await storage.getSettings();
      if (active) setSettings(s);
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
        setOnline(true);
        setNeedsAuth(false);
      } catch (e) {
        if (!active) return;
        setOnline(false);
        setNeedsAuth(false);
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

  const save = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await storage.saveSettings(settings);
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
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ── Headline: light first line, heavier second ── */}
        <Text style={styles.headline}>
          Your{'\n'}
          <Text style={styles.headlineStrong}>Profile</Text>
        </Text>

        {/* ── Hero: purple gradient identity card ── */}
        <LinearGradient
          colors={[TILES.green, TILES.green, TILES.green]}
          locations={[0, 0.5, 1]}
          start={{ x: 0.05, y: 0 }}
          end={{ x: 0.95, y: 1 }}
          style={styles.hero}
        >
          {/* Soft highlight so the panel reads as glass, not flat fill. */}
          <LinearGradient
            colors={['rgba(255,255,255,0.35)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.75, y: 0.9 }}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          />

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
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: TILE_INK.green },
                  ]}
                />
                <Text style={styles.statusText}>
                  On this device
                </Text>
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
              <LinearGradient
                colors={[colors.surface, colors.surface]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.progressFill, { width: `${Math.max(completion, 2)}%` }]}
              />
            </View>
          </View>

          <View style={styles.heroDivider} />

          <View style={styles.heroStatsRow}>
            <HeroStat Icon={ListTodo} value={stats.total} label={t('profile.stat.tasks')} />
            <HeroStat Icon={CheckCircle2} value={stats.done} label={t('profile.stat.done')} />
            <HeroStat Icon={Flame} value={stats.streak} label={t('profile.stat.streak')} />
            <HeroStat Icon={CalendarDays} value={stats.events} label={t('profile.stat.events')} />
          </View>
        </LinearGradient>

        {/* ── Quick stat tiles ── */}
        <View style={styles.tileRow}>
          <GlassCard style={styles.tile}>
            <View style={[styles.tileIcon, { backgroundColor: TILES.blue }]}>
              <ListTodo color={colors.primary} size={17} />
            </View>
            <Text style={styles.tileValue}>{stats.open}</Text>
            <Text style={styles.tileLabel}>{t('profile.openTasks')}</Text>
          </GlassCard>
          <GlassCard style={styles.tile}>
            <View style={[styles.tileIcon, { backgroundColor: TILES.green }]}>
              <CheckCircle2 color={TILE_INK.green} size={17} />
            </View>
            <Text style={styles.tileValue}>{stats.done}</Text>
            <Text style={styles.tileLabel}>{t('profile.completed')}</Text>
          </GlassCard>
        </View>

        {/* ── Display name ── */}
        <GlassCard>
          <View style={styles.cardHeaderRow}>
            <IconSquare>
              <User color={colors.primary} size={18} />
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
        </GlassCard>

        {/* ── Notifications ── */}
        <GlassCard>
          <View style={[styles.cardHeaderRow, { marginBottom: 0 }]}>
            <IconSquare>
              <Bell color={colors.primary} size={18} />
            </IconSquare>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.notifications')}</Text>
              <Text style={styles.mutedText}>{t('profile.notificationsBody')}</Text>
            </View>
            <Switch
              value={settings.notifications}
              onValueChange={(notifications) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSettings((s) => ({ ...s, notifications }));
              }}
              trackColor={{ true: colors.primary, false: '#E3E3DE' }}
              thumbColor="#FFFFFF"
            />
          </View>
        </GlassCard>

        {/* ── Language ── */}
        <GlassCard>
          <View style={styles.cardHeaderRow}>
            <IconSquare>
              <Languages color={colors.primary} size={18} />
            </IconSquare>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.language')}</Text>
              <Text style={styles.mutedText}>{t('profile.languageBody')}</Text>
            </View>
          </View>
          <View style={styles.langGrid}>
            {(Object.keys(LANGUAGES) as Language[]).map((code) => {
              const active = code === lang;
              return (
                <Pressable
                  key={code}
                  onPress={() => pickLanguage(code)}
                  style={[styles.langChip, active && styles.langChipActive]}
                >
                  <Text style={[styles.langChipText, active && { color: '#FFFFFF' }]}>
                    {LANGUAGES[code].native}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </GlassCard>

        {/* ── Local data ── */}
        <GlassCard>
          <View style={styles.cardHeaderRow}>
            <IconSquare>
              <Database color={colors.primary} size={18} />
            </IconSquare>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.storage')}</Text>
              <Text style={styles.mutedText}>
                {t('profile.storageBody')}
              </Text>
            </View>
          </View>
          <Pressable onPress={clearData} style={styles.ghostBtn}>
            <Trash2 color={colors.danger} size={16} />
            <Text style={[styles.ghostBtnText, { color: colors.danger }]}>
              {t('profile.clearData')}
            </Text>
          </Pressable>
        </GlassCard>

        {/* ── Legal and support ──
             The App Store requires a reachable privacy policy and a way to
             erase everything; the rest is the usual footer. LEGAL_URLS and
             SUPPORT_EMAIL at the top of this file are what these open. */}
        <GlassCard>
          <View style={styles.cardHeaderRow}>
            <IconSquare>
              <FileText color={colors.primary} size={18} />
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
        </GlassCard>

        {/* ── Save ── */}
        <Pressable onPress={save} style={({ pressed }) => [{ opacity: pressed ? 0.88 : 1 }]}>
          <LinearGradient
            colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
            start={ACCENT_GRADIENT.start}
            end={ACCENT_GRADIENT.end}
            style={styles.saveBtn}
          >
            <Text style={styles.saveBtnText}>{t('profile.save')}</Text>
          </LinearGradient>
        </Pressable>

      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headline: {
    ...font(400),
    fontSize: 34,
    lineHeight: 42,
    color: colors.text,
    letterSpacing: -0.6,
    marginBottom: spacing.lg,
  },
  headlineStrong: { ...font(600) },

  // ── Hero ──
  hero: {
    borderRadius: 28,
    padding: spacing.md + 4,
    marginBottom: 14,
    overflow: 'hidden',
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 18,
    elevation: 3,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center' },
  avatarRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
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
    backgroundColor: 'rgba(255,255,255,0.6)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4 },

  heroDivider: {
    height: 1,
    backgroundColor: 'rgba(20,21,15,0.08)',
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

  // ── Cards ──
  card: {
    borderRadius: 24,
    padding: spacing.md + 2,
    marginBottom: 14,
    overflow: 'hidden',
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },

  tileRow: { flexDirection: 'row', gap: 14 },
  tile: { flex: 1, padding: spacing.md },
  tileIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  tileValue: { ...font(600), fontSize: 24, color: colors.text, letterSpacing: -0.5 },
  tileLabel: { ...font(400), fontSize: 12, color: colors.textMuted, marginTop: 1 },

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
    backgroundColor: TILES.neutral,
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

  langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  langChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 50,
    backgroundColor: TILES.neutral,
  },
  langChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  langChipText: { ...font(600), fontSize: 13.5, color: colors.primary },

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
    backgroundColor: colors.surface,
    borderRadius: 50,
    paddingVertical: 15,
  },
  ghostBtnText: { ...font(500), fontSize: 14, color: colors.primary },

  saveBtn: {
    borderRadius: 50,
    paddingVertical: 19,
    alignItems: 'center',
    marginTop: 2,
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 4,
  },
  saveBtnText: { ...font(600), fontSize: 15.5, color: colors.primaryText },
});
