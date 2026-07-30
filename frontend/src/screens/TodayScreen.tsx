import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import {
  Search,
  Bell,
  Calendar as CalendarIcon,
  ArrowUpRight,
  Clock,
  Check,
  LoaderCircle,
} from 'lucide-react-native';

import { Screen } from '../components/ui';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';
import { storage } from '../lib/storage';
import {
  parsePriority,
  statusOf,
  to12h,
  plusHour,
  toDateStr,
  eventToItem,
  taskToItem,
  type AgendaItem,
  type TaskStatus,
} from '../lib/tasks';
import {
  spacing,
  radius,
  font,
  cardStyle,
  chipStyle,
  AI_GRADIENT,
  priorityColors,
  type Palette,
} from '../theme';
import { t, isRTL, locale } from '../lib/i18n';

const AVATAR_COLORS = ['#F2A0B5', '#9D8BFA', '#F1C46B'];

function greetingNow(): string {
  const h = new Date().getHours();
  if (h < 12) return t('today.greeting.morning');
  if (h < 17) return t('today.greeting.afternoon');
  return t('today.greeting.evening');
}

/** Adds an alpha channel to a `#rrggbb` colour, e.g. for a translucent stroke. */
function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

/** 'YYYY-MM-DD' -> '12 Dec', in the local calendar and active language. */
function formatShortDate(dateStr: string): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

// Decorative collaborator stack, as in the mockup.
function AvatarStack({ c }: { c: Palette }) {
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.avatarRow}>
      {AVATAR_COLORS.map((color, i) => (
        <View
          key={color}
          style={[styles.avatarDot, { backgroundColor: color, marginStart: i ? -10 : 0 }]}
        />
      ))}
      <View style={[styles.avatarDot, styles.avatarMore]}>
        <Text style={styles.avatarMoreText}>+4</Text>
      </View>
    </View>
  );
}

/** Small ring: track in `c.surfaceAlt`, progress arc in `c.pink`. */
function CompletionRing({ pct, c }: { pct: number; c: Palette }) {
  const size = 62;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, pct));
  const dashoffset = circumference * (1 - clamped);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg
        width={size}
        height={size}
        style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}
      >
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.surfaceAlt} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={c.pink}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashoffset}
          strokeLinecap="round"
        />
      </Svg>
      <Text style={{ ...font(700), fontSize: 15, color: c.onAccent }}>{Math.round(clamped * 100)}%</Text>
    </View>
  );
}

/** Mini bar chart: one bar per day, height proportional to that day's task count. */
function MiniBars({ counts, c }: { counts: number[]; c: Palette }) {
  const max = Math.max(1, ...counts);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, height: 28 }}>
      {counts.map((n, i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: Math.max(4, Math.round((n / max) * 28)),
            borderRadius: 3,
            backgroundColor: c.cyan,
          }}
        />
      ))}
    </View>
  );
}

export default function TodayScreen() {
  const { palette: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const pColors = useMemo(() => priorityColors(c), [c]);

  const [name, setName] = useState('');
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [weekCounts, setWeekCounts] = useState<number[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('todo');

  const today = toDateStr(new Date());

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const settings = await storage.getSettings();
      if (active) setName(settings.displayName);
      try {
        // /agenda?date= resolves the day in the user's timezone server-side and
        // returns both events and tasks due that day.
        const { events, tasks } = await api.agendaForDate(today);
        if (!active) return;
        setItems([...events.map(eventToItem), ...tasks.map(taskToItem)]);
        setOnline(true);
        setNeedsAuth(false);
      } catch (err) {
        if (!active) return;
        setOnline(false);
        setNeedsAuth(false);
      }
      // Per-day counts for the mini bar chart — decorative only, so a failure
      // here must not clobber the state above.
      try {
        const from = toDateStr(new Date(Date.now() - 6 * 86400000));
        const { events: wEvents, tasks: wTasks } = await api.agendaForRange(from, today);
        if (!active) return;
        const all = [...wEvents.map(eventToItem), ...wTasks.map(taskToItem)];
        const counts: number[] = [];
        for (let i = 6; i >= 0; i--) {
          const d = toDateStr(new Date(Date.now() - i * 86400000));
          counts.push(all.filter((it) => it.date === d).length);
        }
        setWeekCounts(counts);
      } catch {
        /* bars stay flat */
      }
    })();
    return () => {
      active = false;
    };
  }, [today]);

  useFocusEffect(load);

  const now = new Date();
  const stats = useMemo(() => {
    const done = items.filter((i) => statusOf(i, now) === 'done').length;
    const total = items.length;
    return { total, done, pending: total - done, progress: total ? done / total : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const chips: { key: TaskStatus; label: string }[] = [
    { key: 'todo', label: t('today.filter.todo') },
    { key: 'inprogress', label: t('today.filter.inprogress') },
    { key: 'done', label: t('today.filter.done') },
  ];
  const countOf = (s: TaskStatus) => items.filter((i) => statusOf(i, now) === s).length;
  const visible = filter === 'all' ? items : items.filter((i) => statusOf(i, now) === filter);
  const checklist = items.slice(0, 5);
  const aiDate = new Date().toLocaleDateString(locale(), { day: 'numeric', month: 'short' });

  const confirmDelete = (item: AgendaItem) => {
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: item.title }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            // Tasks and events are separate resources with separate ids.
            if (item.kind === 'task') await api.deleteTask(item.id);
            else await api.deleteEvent(item.id);
            load();
          } catch (err) {
            Alert.alert(t('common.error'), (err as Error).message);
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ── Header: greeting + name, search & bell ── */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greeting}>{greetingNow()}</Text>
            <Text
              style={[styles.greetingName, { textAlign: isRTL() ? 'right' : 'left' }]}
              numberOfLines={1}
            >
              {name || t('today.setName')}
            </Text>
          </View>
          <Pressable
            onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
            style={styles.iconBtn}
          >
            <Search color={c.text} size={19} />
          </Pressable>
          <Pressable
            onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
            style={[styles.iconBtn, { marginStart: spacing.sm }]}
          >
            <Bell color={c.text} size={19} />
          </Pressable>
        </View>

        {/* ── AI analysis panel ── */}
        <LinearGradient
          colors={AI_GRADIENT.colors as unknown as [string, string, ...string[]]}
          locations={AI_GRADIENT.locations as unknown as [number, number, ...number[]]}
          start={AI_GRADIENT.start}
          end={AI_GRADIENT.end}
          style={styles.aiCard}
        >
          <View style={styles.aiTopRow}>
            <View style={styles.aiDateRow}>
              <CalendarIcon color={c.onLight} size={14} />
              <Text style={styles.aiDate}>{aiDate}</Text>
            </View>
            <View style={styles.aiPill}>
              <Text style={styles.aiPillText}>{t('today.ai.report')}</Text>
            </View>
          </View>

          <Text style={styles.aiSubtitle}>{t('today.ai.subtitle')}</Text>

          <Text style={[styles.aiStatement, { textAlign: isRTL() ? 'right' : 'left' }]}>
            {t('today.ai.statement', { count: stats.pending })}{' '}
            <Text style={styles.urgentPill}>
              {t('today.ai.urgent')} ↗
            </Text>
          </Text>
        </LinearGradient>

        {/* ── Priority task + completion column ── */}
        <View style={styles.columnsRow}>
          {/* Leading: Priority Task checklist, on a lime card */}
          <View style={[styles.limeCard, { flex: 1 }]}>
            <Text style={styles.limeTitle}>{t('today.priorityCard.title')}</Text>
            {checklist.map((item) => {
              const done = statusOf(item, now) === 'done';
              return (
                <View key={item.id} style={styles.checklistRow}>
                  <View style={[styles.checkCircle, done && styles.checkCircleDone]}>
                    {done ? <Check color={c.onAccent} size={12} strokeWidth={3} /> : null}
                  </View>
                  <Text style={styles.checklistText} numberOfLines={1}>
                    {item.title}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Trailing: completion ring + mini chart, and an in-progress card */}
          <View style={[styles.trailingCol, { flex: 1 }]}>
            <View style={styles.ringCard}>
              <View style={styles.ringRow}>
                <CompletionRing pct={stats.progress} c={c} />
                <View style={{ marginStart: spacing.sm }}>
                  <Text style={styles.ringTitle}>{t('today.completedCard.title')}</Text>
                  <Text style={styles.ringSubtitle}>
                    {t('today.completedCard.count', { done: stats.done, total: stats.total })}
                  </Text>
                </View>
              </View>
              <View style={{ marginTop: spacing.sm }}>
                <MiniBars counts={weekCounts} c={c} />
              </View>
            </View>

            <View style={styles.inProgressCard}>
              <View style={styles.inProgressIconWrap}>
                <LoaderCircle color={c.primary} size={18} />
              </View>
              <View>
                <Text style={styles.ringTitle}>{t('today.filter.inprogress')}</Text>
                <Text style={styles.ringSubtitle}>
                  {t('today.inProgressCard.count', { count: countOf('inprogress') })}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* ── All Tasks ── */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>{t('today.allTasks.title')}</Text>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setFilter('all');
            }}
            style={styles.sectionBtn}
          >
            <ArrowUpRight color={c.text} size={17} />
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, paddingBottom: 4 }}
          style={{ marginBottom: spacing.md }}
        >
          {chips.map((chip) => {
            const active = filter === chip.key;
            return (
              <Pressable
                key={chip.key}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setFilter(chip.key);
                }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <View style={[styles.chipCount, active && styles.chipCountActive]}>
                  <Text style={[styles.chipCountText, active && styles.chipCountTextActive]}>
                    {countOf(chip.key)}
                  </Text>
                </View>
                <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
                  {chip.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {online === false ? (
          <Text style={styles.offline}>
            {needsAuth ? t('today.offline.authRequired') : t('today.offline.serverUnavailable')}
          </Text>
        ) : null}

        {visible.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.taskTitle}>{t('today.empty.title')}</Text>
            <Text style={styles.emptyBody}>{t('today.empty.body')}</Text>
          </View>
        ) : (
          visible.map((e) => {
            const { priority } = parsePriority(e.notes);
            const pc = pColors[priority ?? 'High'];
            const isZoom = e.id.charCodeAt(0) % 2 === 0;
            const providerLabel = isZoom ? t('today.provider.zoom') : t('today.provider.google');
            const providerDot = isZoom ? c.lavender : c.success;
            return (
              <Pressable key={e.id} onLongPress={() => confirmDelete(e)} style={styles.taskCard}>
                <View style={styles.taskTopRow}>
                  <View style={[styles.priorityPill, { backgroundColor: pc.bg }]}>
                    <Text style={[styles.priorityText, { color: pc.color }]}>
                      {t('today.priority', { level: priority ?? 'High' })}
                    </Text>
                  </View>
                  <View style={styles.providerRow}>
                    <View style={[styles.providerDot, { backgroundColor: providerDot }]} />
                    <Text style={styles.providerLabel}>{providerLabel}</Text>
                  </View>
                </View>

                <Text style={styles.taskTitle}>{e.title}</Text>

                <View style={styles.taskTimeRow}>
                  <Clock color={c.textMuted} size={14} />
                  <Text style={styles.taskTime}>
                    {e.time ? `${to12h(e.time)} - ${to12h(plusHour(e.time))}` : t('today.allDay')}
                  </Text>
                </View>

                <View style={styles.taskBottomRow}>
                  <Text style={styles.taskDue}>
                    {t('today.dueDate', { date: e.date ? formatShortDate(e.date) : t('tasks.noDue') })}
                  </Text>
                  <AvatarStack c={c} />
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
    greeting: { ...font(500), fontSize: 13, color: c.textMuted },
    greetingName: { ...font(700), fontSize: 22, color: c.text, marginTop: 2 },
    iconBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── AI panel ──
    aiCard: {
      borderRadius: radius.lg,
      padding: spacing.md + 4,
      marginBottom: spacing.lg,
    },
    aiTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    aiDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    aiDate: { ...font(600), fontSize: 13, color: c.onLight },
    aiPill: {
      ...chipStyle(),
      backgroundColor: withAlpha(c.onAccent, 0.55),
    },
    aiPillText: { ...font(600), fontSize: 11, color: c.onLight },
    aiSubtitle: { ...font(500), fontSize: 12.5, color: withAlpha(c.onLight, 0.62), marginBottom: 8 },
    aiStatement: { ...font(600), fontSize: 22, lineHeight: 29, color: c.onLight },
    urgentPill: {
      ...font(700),
      fontSize: 13,
      color: c.onAccent,
      backgroundColor: c.onLight,
      borderRadius: radius.pill,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },

    // ── Two-column row ──
    columnsRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', marginBottom: spacing.lg },
    limeCard: {
      ...cardStyle(c),
      backgroundColor: c.lime,
    },
    limeTitle: { ...font(700), fontSize: 15, color: c.onLight, marginBottom: spacing.sm + 2 },
    checklistRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    checkCircle: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: withAlpha(c.onLight, 0.35),
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkCircleDone: {
      backgroundColor: c.onLight,
      borderColor: c.onLight,
    },
    checklistText: { ...font(500), fontSize: 13, color: c.onLight, flexShrink: 1 },

    trailingCol: { gap: spacing.md },
    ringCard: { ...cardStyle(c) },
    ringRow: { flexDirection: 'row', alignItems: 'center' },
    ringTitle: { ...font(700), fontSize: 14, color: c.text },
    ringSubtitle: { ...font(400), fontSize: 11.5, color: c.textMuted, marginTop: 2 },

    inProgressCard: {
      ...cardStyle(c),
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    inProgressIconWrap: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── Section header ──
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    sectionTitle: { ...font(700), fontSize: 20, color: c.text },
    sectionBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── Filter chips ──
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      paddingVertical: 8,
      paddingStart: 6,
      paddingEnd: 16,
    },
    chipActive: { backgroundColor: c.primary },
    chipCount: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: c.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chipCountActive: { backgroundColor: withAlpha(c.onAccent, 0.25) },
    chipCountText: { ...font(600), fontSize: 13, color: c.text },
    chipCountTextActive: { color: c.onAccent },
    chipLabel: { ...font(500), fontSize: 13.5, color: c.textMuted },
    chipLabelActive: { color: c.onAccent },

    offline: { ...font(400), fontSize: 13, color: c.danger, marginBottom: spacing.md },

    // ── Task cards ──
    taskCard: { ...cardStyle(c), marginBottom: spacing.md },
    taskTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    priorityPill: {
      ...chipStyle(),
    },
    priorityText: { ...font(700), fontSize: 11 },
    providerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    providerDot: { width: 7, height: 7, borderRadius: 4 },
    providerLabel: { ...font(500), fontSize: 12, color: c.textMuted },

    taskTitle: { ...font(700), fontSize: 16.5, color: c.text, marginBottom: 8 },
    taskTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    taskTime: { ...font(400), fontSize: 12.5, color: c.textMuted },
    taskBottomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    taskDue: { ...font(400), fontSize: 12.5, color: c.textMuted },

    emptyCard: { ...cardStyle(c) },
    emptyBody: { ...font(400), fontSize: 13, color: c.textMuted },

    avatarRow: { flexDirection: 'row', alignItems: 'center' },
    avatarDot: {
      width: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: 2,
      borderColor: c.surface,
    },
    avatarMore: {
      backgroundColor: c.text,
      marginStart: -10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarMoreText: { ...font(600), fontSize: 9, color: c.bg },
  });
}
