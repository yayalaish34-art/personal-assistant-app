import { useCallback, useMemo, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  Switch,
  StyleSheet,
  Alert,
  Pressable,
  Image,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import {
  Ellipsis,
  ChevronDown,
  ChevronRight,
  Moon,
  CircleUser,
  Bell,
  CirclePlus,
  ShieldCheck,
  Users,
  UserPlus,
  Paperclip,
  Languages,
  Database,
  Trash2,
  type LucideIcon,
} from 'lucide-react-native';

import { Screen } from '../components/ui';
import { useTheme } from '../lib/theme';
import { storage, defaultSettings, Settings } from '../lib/storage';
import { api, type Task, type Event } from '../lib/api';
import { toDateStr, isLive } from '../lib/tasks';
import { spacing, radius, font, cardStyle, chipStyle, ACCENT_GRADIENT, type Palette } from '../theme';
import { t, LANGUAGES, getLanguage, setLanguage, type Language } from '../lib/i18n';

// Placeholder portrait, matching the Today header avatar.
const PROFILE_PHOTO_URI = 'https://i.pravatar.cc/220?img=47';

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

type SettingsRowSpec = { key: string; Icon: LucideIcon; label: string };

export default function SettingsScreen() {
  const { mode, palette: c, toggle } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [email, setEmail] = useState('');
  const [events, setEvents] = useState<Event[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [lang, setLang] = useState<Language>(getLanguage());

  const pickLanguage = async (code: Language) => {
    if (code === lang) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const directionChanged = await setLanguage(code);
    setLang(code);
    if (directionChanged) {
      // React Native reads the RTL flag once at startup, so an already-mounted
      // tree keeps the old direction — the text would translate while the
      // layout stayed mirrored the wrong way.
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
        setEmail(me.user.email || '');
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

  // Segmented bar: completed / open / events / streak, as real proportions of
  // one another. An all-zero total would collapse every segment to nothing,
  // so it falls back to four even slivers instead.
  const barTotal = stats.done + stats.open + stats.events + stats.streak;
  const segments = [
    { key: 'done', flex: barTotal ? stats.done : 1, color: c.lime },
    { key: 'open', flex: barTotal ? stats.open : 1, color: c.cyan },
    { key: 'events', flex: barTotal ? stats.events : 1, color: c.pink },
    { key: 'streak', flex: barTotal ? stats.streak : 1, color: c.lavender },
  ];

  const gridStats = [
    { key: 'total', label: t('profile.stat.tasks'), value: String(stats.total), color: c.lime },
    { key: 'completion', label: t('profile.completion'), value: `${completion}%`, color: c.cyan },
    { key: 'open', label: t('profile.openTasks'), value: String(stats.open), color: c.pink },
    {
      key: 'events',
      label: t('profile.stat.events'),
      value: String(stats.events),
      color: c.lavender,
    },
  ];

  // Presentational only — there is nowhere in this app for these to go yet.
  const accountRows: SettingsRowSpec[] = [
    { key: 'personal', Icon: CircleUser, label: t('profile.personalInfo') },
    { key: 'notifications', Icon: Bell, label: t('profile.notifications') },
    { key: 'subscribe', Icon: CirclePlus, label: t('profile.subscribe') },
    { key: 'security', Icon: ShieldCheck, label: t('profile.security') },
  ];
  const projectRows: SettingsRowSpec[] = [
    { key: 'friends', Icon: Users, label: t('profile.friends') },
    { key: 'invitations', Icon: UserPlus, label: t('profile.invitations') },
    { key: 'attachments', Icon: Paperclip, label: t('profile.attachments') },
  ];
  const onRowPress = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

  const save = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await storage.saveSettings(settings);
    // Mirror the name onto the device profile so other screens can read it.
    if (settings.displayName.trim()) {
      await api.updateMe({ name: settings.displayName.trim() });
    }
    Alert.alert(t('profile.saved'), t('profile.savedBody'));
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
        {/* ── Header: centred title, trailing overflow button ── */}
        <View style={styles.headerRow}>
          <View style={styles.headerSpacer} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {t('profile.headline.line1')} {t('profile.headline.line2')}
          </Text>
          <Pressable
            onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
            style={styles.headerBtn}
          >
            <Ellipsis color={c.text} size={20} />
          </Pressable>
        </View>

        {/* ── Identity row: not a card, directly on the ground ── */}
        <View style={styles.identityRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initialsOf(settings.displayName || 'You')}</Text>
            <Image source={{ uri: PROFILE_PHOTO_URI }} style={styles.avatarPhoto} />
          </View>
          <View style={styles.identityText}>
            <Text style={styles.identityName} numberOfLines={1}>
              {settings.displayName || t('profile.yourName')}
            </Text>
            {email ? (
              <Text style={styles.identityEmail} numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>
          <View style={styles.proPill}>
            <Text style={styles.proPillText}>{t('profile.pro')}</Text>
          </View>
        </View>

        {/* ── Analytics ── */}
        <View style={styles.card}>
          <View style={styles.analyticsHeader}>
            <Text style={styles.cardTitle}>{t('profile.analytics')}</Text>
            <Pressable
              onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
              style={styles.monthRow}
              hitSlop={6}
            >
              <Text style={styles.monthLabel}>{t('profile.thisMonth')}</Text>
              <ChevronDown color={c.textMuted} size={14} />
            </Pressable>
          </View>

          <View style={styles.segmentBar}>
            {segments.map((seg) => (
              <View
                key={seg.key}
                style={[styles.segment, { flex: seg.flex, backgroundColor: seg.color }]}
              />
            ))}
          </View>

          <View style={styles.statGrid}>
            {gridStats.map((g) => (
              <View key={g.key} style={styles.statCell}>
                <View style={[styles.statRule, { backgroundColor: g.color }]} />
                <View style={styles.statCellBody}>
                  <Text style={styles.statLabel} numberOfLines={1}>
                    {g.label}
                  </Text>
                  <Text style={styles.statValue}>{g.value}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* ── Appearance: the theme toggle ── */}
        <View style={styles.card}>
          <Text style={[styles.cardTitle, { marginBottom: spacing.md }]}>
            {t('profile.appearance')}
          </Text>
          <View style={styles.appearanceRow}>
            <View style={styles.appearanceIcon}>
              <Moon color={c.text} size={18} />
            </View>
            <View style={styles.appearanceText}>
              <Text style={styles.rowLabel}>{t('profile.darkMode')}</Text>
              <Text style={styles.rowDesc}>{t('profile.darkModeBody')}</Text>
            </View>
            <Switch
              value={mode === 'dark'}
              onValueChange={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                toggle();
              }}
              trackColor={{ true: c.primary, false: c.surfaceAlt }}
              thumbColor="#FFFFFF"
            />
          </View>
        </View>

        {/* ── Account settings ── */}
        <View style={styles.card}>
          <Text style={[styles.cardTitle, { marginBottom: spacing.xs }]}>
            {t('profile.accountSettings')}
          </Text>
          {accountRows.map((r, i) => (
            <Pressable
              key={r.key}
              onPress={onRowPress}
              style={[styles.row, i < accountRows.length - 1 && styles.rowDivider]}
            >
              <r.Icon color={c.textMuted} size={20} />
              <Text style={styles.rowText} numberOfLines={1}>
                {r.label}
              </Text>
              <ChevronRight color={c.textMuted} size={18} />
            </Pressable>
          ))}
        </View>

        {/* ── Project setting ── */}
        <View style={styles.card}>
          <Text style={[styles.cardTitle, { marginBottom: spacing.xs }]}>
            {t('profile.projectSetting')}
          </Text>
          {projectRows.map((r, i) => (
            <Pressable
              key={r.key}
              onPress={onRowPress}
              style={[styles.row, i < projectRows.length - 1 && styles.rowDivider]}
            >
              <r.Icon color={c.textMuted} size={20} />
              <Text style={styles.rowText} numberOfLines={1}>
                {r.label}
              </Text>
              <ChevronRight color={c.textMuted} size={18} />
            </Pressable>
          ))}
        </View>

        {/* ── Language ── */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={styles.iconSquare}>
              <Languages color={c.primary} size={18} />
            </View>
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
                  <Text style={[styles.langChipText, active && styles.langChipTextActive]}>
                    {LANGUAGES[code].native}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Local data ── */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={styles.iconSquare}>
              <Database color={c.primary} size={18} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{t('profile.storage')}</Text>
              <Text style={styles.mutedText}>{t('profile.storageBody')}</Text>
            </View>
          </View>
          <Pressable onPress={clearData} style={styles.ghostBtn}>
            <Trash2 color={c.danger} size={16} />
            <Text style={[styles.ghostBtnText, { color: c.danger }]}>
              {t('profile.clearData')}
            </Text>
          </Pressable>
        </View>

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

function makeStyles(c: Palette) {
  return StyleSheet.create({
    // ── Header ──
    headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
    headerSpacer: { width: 40 },
    headerTitle: {
      flex: 1,
      ...font(700),
      fontSize: 22,
      color: c.text,
      textAlign: 'center',
    },
    headerBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── Identity row ──
    identityRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
    avatar: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    avatarText: { ...font(600), fontSize: 17, color: c.text },
    avatarPhoto: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
    identityText: { flex: 1, marginStart: spacing.md - 4 },
    identityName: { ...font(700), fontSize: 17, color: c.text, textAlign: 'auto' },
    identityEmail: {
      ...font(400),
      fontSize: 13,
      color: c.textMuted,
      marginTop: 2,
      textAlign: 'auto',
    },
    proPill: { ...chipStyle(), backgroundColor: c.lime, marginStart: spacing.sm },
    proPillText: { ...font(700), fontSize: 12, color: c.onLight },

    // ── Cards ──
    card: { ...cardStyle(c), marginBottom: spacing.md },
    cardTitle: { ...font(700), fontSize: 17, color: c.text },
    mutedText: { ...font(400), fontSize: 12.5, color: c.textMuted, lineHeight: 18 },

    // ── Analytics ──
    analyticsHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    monthRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    monthLabel: { ...font(500), fontSize: 12.5, color: c.textMuted },

    segmentBar: {
      flexDirection: 'row',
      height: 8,
      gap: 4,
      marginBottom: spacing.md,
    },
    segment: { height: '100%', borderRadius: 4 },

    statGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.md, columnGap: spacing.sm + 2 },
    statCell: { flexDirection: 'row', width: '47%' },
    statRule: { width: 2, borderRadius: 1, marginEnd: 8 },
    statCellBody: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
    },
    statLabel: { ...font(400), fontSize: 11.5, color: c.textMuted, flexShrink: 1 },
    statValue: { ...font(700), fontSize: 15, color: c.text },

    // ── Appearance ──
    appearanceRow: { flexDirection: 'row', alignItems: 'center' },
    appearanceIcon: {
      width: 38,
      height: 38,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    appearanceText: { flex: 1, marginStart: spacing.sm + 2 },
    rowLabel: { ...font(600), fontSize: 15, color: c.text, textAlign: 'auto' },
    rowDesc: { ...font(400), fontSize: 12.5, color: c.textMuted, marginTop: 2, textAlign: 'auto' },

    // ── Settings list rows ──
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm + 2,
      height: 48,
    },
    rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    rowText: { flex: 1, ...font(500), fontSize: 15, color: c.text, textAlign: 'auto' },

    // ── Language / storage card headers ──
    cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
    iconSquare: {
      width: 38,
      height: 38,
      borderRadius: radius.sm,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    langChip: {
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: radius.pill,
      backgroundColor: c.surfaceAlt,
      borderWidth: 1,
      borderColor: c.border,
    },
    langChipActive: { backgroundColor: c.primary, borderColor: c.primary },
    langChipText: { ...font(600), fontSize: 13.5, color: c.text },
    langChipTextActive: { color: c.onAccent },

    ghostBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 12,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      paddingVertical: 15,
      borderWidth: 1,
      borderColor: c.border,
    },
    ghostBtnText: { ...font(600), fontSize: 14 },

    // ── Save ──
    saveBtn: {
      borderRadius: radius.pill,
      paddingVertical: 19,
      alignItems: 'center',
      marginTop: 2,
      shadowColor: c.primary,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35,
      shadowRadius: 14,
      elevation: 5,
    },
    saveBtnText: { ...font(700), fontSize: 15.5, color: c.onAccent },
  });
}
