import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import Svg, { Circle } from 'react-native-svg';
import { ChevronLeft, SlidersHorizontal, Plus, Check, Star } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api, type Task } from '../lib/api';
import { parsePriority, withPriority, isLive, toDateStr } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, radius, TILES, ROW_TILES, TILE_INK } from '../theme';
import { t, locale, alignStart } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const FILTERS = [
  { key: 'all', labelKey: 'tasks.filter.all' },
  { key: 'today', labelKey: 'today.tile.today' },
  { key: 'upcoming', labelKey: 'tasks.filter.upcoming' },
  { key: 'done', labelKey: 'tasks.completed' },
] as const;

type Filter = (typeof FILTERS)[number]['key'];

/** The ring on the Completed card. */
function PercentRing({ progress, size = 54 }: { progress: number; size?: number }) {
  const p = Math.min(1, Math.max(0, progress));
  const stroke = 6;
  const half = size / 2;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={half} cy={half} r={r} stroke={colors.surface} strokeWidth={stroke} fill="none" />
        {p > 0 ? (
          <Circle
            cx={half}
            cy={half}
            r={r}
            stroke={TILE_INK.green}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            // Dash the stroke to the filled fraction and start it at 12 o'clock.
            strokeDasharray={`${circumference * p} ${circumference}`}
            transform={`rotate(-90 ${half} ${half})`}
          />
        ) : null}
      </Svg>
      <Text style={styles.ringText}>{Math.round(p * 100)}%</Text>
    </View>
  );
}

/** "Today, 9:00 AM" · "Tomorrow, 7:00 AM" · "Mon, 3 Aug" · "No due date". */
function dueLabel(dueAt: string | null): string {
  if (!dueAt) return t('tasks.noDue');
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return t('tasks.noDue');

  const day = toDateStr(d);
  const today = toDateStr(new Date());
  const tomorrow = toDateStr(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

  if (day === today) return `${t('calendar.today')}, ${time}`;
  if (day === tomorrow) return `${t('tasks.tomorrow')}, ${time}`;
  return `${d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

export default function JournalScreen() {
  const navigation = useNavigation<Nav>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const { tasks: rows } = await api.listTasks();
        // Sync responses include soft-deleted rows; drop them.
        if (active) setTasks(rows.filter(isLive));
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const toggleDone = async (task: Task) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Optimistic: the row flips now, and a failure reloads the truth.
    setTasks((prev) => prev.map((r) => (r.id === task.id ? { ...r, isDone: !r.isDone } : r)));
    try {
      await api.updateTask(task.id, {
        isDone: !task.isDone,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      load();
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  /**
   * The star is High priority. There is no favourites column, and priority is
   * already carried as a "[High] " prefix in the notes, so this reuses it
   * rather than inventing a second flag with nowhere to live.
   */
  const toggleStar = async (task: Task) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const { priority, text } = parsePriority(task.notes);
    const next = priority === 'High' ? null : 'High';
    const notes = withPriority(text, next);
    setTasks((prev) => prev.map((r) => (r.id === task.id ? { ...r, notes } : r)));
    try {
      await api.updateTask(task.id, { notes, updatedAt: new Date().toISOString() });
    } catch (e) {
      load();
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const confirmDelete = (task: Task) => {
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: task.title }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteTask(task.id);
            load();
          } catch (e) {
            Alert.alert(t('common.error'), (e as Error).message);
          }
        },
      },
    ]);
  };

  const today = toDateStr(new Date());
  const visible = useMemo(() => {
    const byDue = (a: Task, b: Task) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999');
    switch (filter) {
      case 'today':
        return tasks.filter((r) => r.dueAt && toDateStr(new Date(r.dueAt)) === today).sort(byDue);
      case 'upcoming':
        return tasks.filter((r) => r.dueAt && toDateStr(new Date(r.dueAt)) > today).sort(byDue);
      case 'done':
        return tasks.filter((r) => r.isDone).sort(byDue);
      default:
        return [...tasks].sort(byDue);
    }
  }, [tasks, filter, today]);

  const doneCount = tasks.filter((r) => r.isDone).length;
  const progress = tasks.length ? doneCount / tasks.length : 0;

  return (
    <Screen>
      {/* ── Back, filter, add ── */}
      <View style={styles.headerRow}>
        <Pressable
          onPress={() =>
            // This is a tab, so there is nothing to pop — "back" means home.
            (
              navigation as unknown as {
                navigate: (name: string, params: { screen: string }) => void;
              }
            ).navigate('Tabs', { screen: 'Today' })
          }
          style={styles.iconBtn}
          accessibilityRole="button"
        >
          <ChevronLeft color={colors.text} size={22} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            // Cycles the filter — the same job the sliders icon implies.
            const order: Filter[] = ['all', 'today', 'upcoming', 'done'];
            setFilter(order[(order.indexOf(filter) + 1) % order.length]);
          }}
          style={[styles.iconBtn, styles.iconBtnRaised]}
          accessibilityRole="button"
        >
          <SlidersHorizontal color={colors.text} size={20} />
        </Pressable>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            navigation.navigate('Assistant');
          }}
          style={[styles.iconBtn, styles.iconBtnRaised, { marginStart: 10 }]}
          accessibilityRole="button"
          accessibilityLabel={t('voice.title')}
        >
          <Plus color={colors.text} size={22} strokeWidth={2.2} />
        </Pressable>
      </View>

      <Text style={styles.headline}>{t('tasks.title')}</Text>

      {/* ── Filter chips ── */}
      <View style={styles.chipRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setFilter(f.key);
              }}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {t(f.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
        {visible.map((task, index) => {
          const starred = parsePriority(task.notes).priority === 'High';
          return (
            <View
              key={task.id}
              style={[
                styles.row,
                { backgroundColor: TILES[ROW_TILES[index % ROW_TILES.length]] },
              ]}
            >
              <Pressable
                onPress={() => toggleDone(task)}
                hitSlop={8}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: task.isDone }}
              >
                <View style={[styles.checkbox, task.isDone && styles.checkboxDone]}>
                  {task.isDone ? <Check color={colors.text} size={13} strokeWidth={3} /> : null}
                </View>
              </Pressable>

              <Pressable
                style={{ flex: 1 }}
                // Tap to edit, hold to delete — the form does both, but a
                // deletion should not be one stray tap away.
                onPress={() => navigation.navigate('EntryForm', { kind: 'task', id: task.id })}
                onLongPress={() => confirmDelete(task)}
                accessibilityRole="button"
              >
                <Text
                  style={[styles.rowTitle, { textAlign: alignStart() }, task.isDone && styles.rowTitleDone]}
                  numberOfLines={1}
                >
                  {task.title}
                </Text>
                <Text style={[styles.rowMeta, { textAlign: alignStart() }]}>{dueLabel(task.dueAt)}</Text>
              </Pressable>

              <Pressable onPress={() => toggleStar(task)} hitSlop={8} accessibilityRole="button">
                <Star
                  color={starred ? colors.star : colors.text}
                  fill={starred ? colors.star : 'transparent'}
                  size={22}
                  strokeWidth={1.8}
                />
              </Pressable>
            </View>
          );
        })}

        {visible.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t('tasks.empty.title')}</Text>
            <Text style={styles.emptyBody}>{t('tasks.empty.body')}</Text>
          </View>
        ) : null}

        {/* ── Completed summary ── */}
        <View style={[styles.completedCard, { backgroundColor: TILES.yellow }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.completedTitle}>{t('tasks.completed')}</Text>
            <Text style={styles.completedMeta}>{t('tasks.countTasks', { count: doneCount })}</Text>
          </View>
          <PercentRing progress={progress} />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  iconBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  iconBtnRaised: {
    backgroundColor: colors.surface,
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },

  headline: {
    fontSize: 32,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.8,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },

  chipRow: { flexDirection: 'row', gap: 8, marginBottom: spacing.md },
  chip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 100,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { fontSize: 13, ...font(600), color: colors.textMuted },
  chipTextActive: { color: colors.primaryText },

  list: { gap: 10, paddingBottom: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.6,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.85,
  },
  checkboxDone: { backgroundColor: colors.surface, opacity: 1 },
  rowTitle: { fontSize: 16, ...font(700), color: colors.text },
  rowTitleDone: { textDecorationLine: 'line-through', opacity: 0.55 },
  rowMeta: { fontSize: 13, ...font(500), color: colors.text, opacity: 0.7, marginTop: 2 },

  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: 6 },
  emptyTitle: { fontSize: 17, ...font(700), color: colors.text },
  emptyBody: { fontSize: 14, ...font(500), color: colors.textMuted, textAlign: 'center' },

  completedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    marginTop: spacing.sm,
  },
  completedTitle: { fontSize: 18, ...font(700), color: colors.text },
  completedMeta: { fontSize: 14, ...font(500), color: colors.text, opacity: 0.7, marginTop: 2 },
  ringText: { fontSize: 13, ...font(700), color: colors.text },
});
