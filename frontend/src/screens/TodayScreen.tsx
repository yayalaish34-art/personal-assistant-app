import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Bell, Plus, ArrowUpRight, Clock, ClipboardList } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { ProgressRing } from '../components/ProgressRing';
import { api, CalendarEvent } from '../lib/api';
import { storage } from '../lib/storage';
import {
  parsePriority,
  statusOf,
  to12h,
  plusHour,
  toDateStr,
  type TaskStatus,
} from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, ACCENT_GRADIENT, PRIORITY_COLORS } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const AVATAR_COLORS = ['#F2A0B5', '#9D8BFA', '#F1C46B'];

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

function greetingNow(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

// Decorative collaborator stack, as in the mockup.
function AvatarStack() {
  return (
    <View style={styles.avatarRow}>
      {AVATAR_COLORS.map((c, i) => (
        <View key={c} style={[styles.avatarDot, { backgroundColor: c, marginLeft: i ? -10 : 0 }]} />
      ))}
      <View style={[styles.avatarDot, styles.avatarMore]}>
        <Text style={styles.avatarMoreText}>+4</Text>
      </View>
    </View>
  );
}

function StatRow({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.statRow}>
      <View style={styles.statIcon}>
        <ClipboardList color="#FFFFFF" size={17} />
      </View>
      <View>
        <Text style={styles.statValue}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    </View>
  );
}

export default function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('todo');

  const today = toDateStr(new Date());

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const settings = await storage.getSettings();
      if (active) setName(settings.displayName);
      try {
        const list = await api.listEvents(today);
        if (!active) return;
        setEvents(list);
        setOnline(true);
      } catch {
        if (active) setOnline(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [today]);

  useFocusEffect(load);

  const now = new Date();
  const stats = useMemo(() => {
    // Seed with the mockup's demo numbers until real tasks exist.
    if (events.length === 0) return { total: 12, done: 12, pending: 12, progress: 0.72 };
    const done = events.filter((e) => statusOf(e, now) === 'done').length;
    const total = events.length;
    return { total, done, pending: total - done, progress: total ? done / total : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const chips: { key: TaskStatus; label: string }[] = [
    { key: 'todo', label: 'To Do' },
    { key: 'inprogress', label: 'In Progress' },
    { key: 'done', label: 'Done' },
  ];
  const countOf = (s: TaskStatus) => events.filter((e) => statusOf(e, now) === s).length;
  const visible = filter === 'all' ? events : events.filter((e) => statusOf(e, now) === filter);

  const openAddTask = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate('EntryForm', { kind: 'event' });
  };

  const confirmDelete = (e: CalendarEvent) => {
    Alert.alert('Delete task', `Delete "${e.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteEvent(e.id);
            load();
          } catch (err) {
            Alert.alert('Error', (err as Error).message);
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ── Header: avatar, greeting, + and bell ── */}
        <View style={styles.headerRow}>
          <View style={styles.profileAvatar}>
            <Text style={styles.profileInitials}>{initialsOf(name || 'You')}</Text>
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.greeting}>{greetingNow()}</Text>
            <Text style={styles.greetingName}>{name || 'Set your name in Profile'}</Text>
          </View>
          <Pressable onPress={openAddTask}>
            <LinearGradient
              colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
              start={ACCENT_GRADIENT.start}
              end={ACCENT_GRADIENT.end}
              style={styles.circleBtn}
            >
              <Plus color="#fff" size={24} />
            </LinearGradient>
          </Pressable>
          <Pressable
            onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
            style={[styles.circleBtn, styles.circleBtnWhite, { marginLeft: 10 }]}
          >
            <Bell color={colors.text} size={22} />
          </Pressable>
        </View>

        {/* ── Headline: light first line, medium second line ── */}
        <Text style={styles.headline}>
          Let{'’'}s Make{'\n'}
          <Text style={styles.headlineStrong}>Today Productive</Text>
        </Text>

        {/* ── Today's Progress card: translucent gradient glass ── */}
        <LinearGradient
          colors={[
            'rgba(255,255,255,0.92)',
            'rgba(240,226,250,0.55)',
            'rgba(226,203,246,0.5)',
          ]}
          locations={[0, 0.55, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.progressCard}
        >
          <Text style={styles.progressTitle}>Today{'’'}s Progress</Text>
          <View style={styles.progressBody}>
            <ProgressRing progress={stats.progress} />
            <View style={styles.progressDivider} />
            <View style={{ flex: 1, gap: 14 }}>
              <StatRow value={stats.total} label="Total Task" />
              <StatRow value={stats.done} label="Completed Task" />
              <StatRow value={stats.pending} label="Pending Task" />
            </View>
          </View>
        </LinearGradient>

        {/* ── Today's Tasks ── */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>Today{'’'}s Tasks</Text>
          <Pressable onPress={() => setFilter('all')}>
            <Text style={[styles.viewAll, filter === 'all' && { color: colors.primary }]}>
              View All
            </Text>
          </Pressable>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, paddingBottom: 4 }}
          style={{ marginBottom: spacing.md }}
        >
          {chips.map((c) => {
            const active = filter === c.key;
            return (
              <Pressable
                key={c.key}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setFilter(c.key);
                }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <View style={[styles.chipCount, active && styles.chipCountActive]}>
                  <Text style={styles.chipCountText}>{countOf(c.key)}</Text>
                </View>
                <Text style={styles.chipLabel}>{c.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {online === false ? (
          <Text style={styles.offline}>Server unavailable — check the API URL in Profile.</Text>
        ) : null}

        {visible.length === 0 ? (
          <View style={styles.taskCard}>
            <Text style={styles.taskTitle}>No tasks here</Text>
            <Text style={styles.taskEmptyText}>
              Tap the + button to add your first task for today.
            </Text>
          </View>
        ) : (
          visible.map((e) => {
            const { priority } = parsePriority(e.notes);
            const pc = PRIORITY_COLORS[priority ?? 'High'];
            return (
              <Pressable key={e.id} onLongPress={() => confirmDelete(e)} style={styles.taskCard}>
                <View style={styles.taskTopRow}>
                  <View style={[styles.priorityPill, { backgroundColor: pc.bg }]}>
                    <View style={[styles.priorityDot, { backgroundColor: pc.color }]} />
                    <Text style={[styles.priorityText, { color: pc.color }]}>
                      {(priority ?? 'High') + ' Priority'}
                    </Text>
                  </View>
                  <View style={styles.arrowBtn}>
                    <ArrowUpRight color={colors.text} size={18} />
                  </View>
                </View>
                <Text style={styles.taskTitle}>{e.title}</Text>
                <View style={styles.taskBottomRow}>
                  <View style={styles.taskTimeRow}>
                    <Clock color={colors.textMuted} size={15} />
                    <Text style={styles.taskTime}>
                      {e.time ? `${to12h(e.time)} - ${to12h(plusHour(e.time))}` : 'All day'}
                    </Text>
                  </View>
                  <AvatarStack />
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  profileAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E7DBF6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileInitials: { fontWeight: '600', fontSize: 16, color: colors.primary },
  greeting: { fontWeight: '500', fontSize: 15, color: colors.text },
  greetingName: { fontWeight: '400', fontSize: 12, color: colors.textMuted, marginTop: 1 },
  circleBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleBtnWhite: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },

  headline: {
    fontWeight: '400',
    fontSize: 28,
    lineHeight: 36,
    color: colors.text,
    letterSpacing: -0.3,
    marginBottom: spacing.lg,
  },
  headlineStrong: { fontWeight: '500' },

  progressCard: {
    borderRadius: 28,
    padding: spacing.md + 4,
    marginBottom: spacing.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.65)',
  },
  progressTitle: { fontWeight: '500', fontSize: 16, color: colors.text, marginBottom: 14 },
  progressBody: { flexDirection: 'row', alignItems: 'center' },
  progressDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: '#EFE7F6',
    marginHorizontal: 18,
  },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#CBB3F1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statValue: { fontWeight: '600', fontSize: 15, color: colors.text },
  statLabel: { fontWeight: '400', fontSize: 11, color: colors.textMuted, marginTop: 1 },

  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  sectionTitle: { fontWeight: '600', fontSize: 18, color: colors.text },
  viewAll: { fontWeight: '500', fontSize: 14, color: colors.textMuted },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 18,
  },
  chipActive: { backgroundColor: colors.lime },
  chipCount: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F1F1F4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipCountActive: { backgroundColor: '#FFFFFF' },
  chipCountText: { fontWeight: '600', fontSize: 14, color: colors.text },
  chipLabel: { fontWeight: '500', fontSize: 14, color: colors.text },

  offline: {
    fontWeight: '400',
    fontSize: 13,
    color: colors.danger,
    marginBottom: spacing.md,
  },

  taskCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: spacing.md + 2,
    marginBottom: 14,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },
  taskTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  priorityPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 50,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  priorityDot: { width: 7, height: 7, borderRadius: 4 },
  priorityText: { fontWeight: '500', fontSize: 12 },
  arrowBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F4F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskTitle: { fontWeight: '600', fontSize: 17, color: colors.text, marginBottom: 12 },
  taskEmptyText: { fontWeight: '400', fontSize: 13, color: colors.textMuted },
  taskBottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  taskTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  taskTime: { fontWeight: '400', fontSize: 13, color: colors.textMuted },

  avatarRow: { flexDirection: 'row', alignItems: 'center' },
  avatarDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  avatarMore: {
    backgroundColor: '#17171B',
    marginLeft: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarMoreText: { fontWeight: '500', fontSize: 10, color: '#FFFFFF' },
});
