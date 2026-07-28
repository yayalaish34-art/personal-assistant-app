import { useCallback, useState } from 'react';
import { FlatList, ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Plus, ArrowUpRight, Clock, Check } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { AddSheet } from '../components/AddSheet';
import { api, ApiError, type Task } from '../lib/api';
import { parsePriority, isLive } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, ACCENT_GRADIENT, PRIORITY_COLORS } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// The backend has no journal resource, so this screen is the task list —
// GET/PATCH/DELETE /tasks. Priority still rides in the notes field as a
// "[High] " prefix, since the schema has no priority column.
const PRIORITY_CHIP = {
  High: { label: 'High', ...PRIORITY_COLORS.High },
  Medium: { label: 'Medium', ...PRIORITY_COLORS.Medium },
  Low: { label: 'Low', ...PRIORITY_COLORS.Low },
} as const;

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'done', label: 'Done' },
] as const;

type Filter = (typeof FILTERS)[number]['key'];

export default function JournalScreen() {
  const navigation = useNavigation<Nav>();
  const [entries, setEntries] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const { tasks } = await api.listTasks();
        if (active) {
          // Sync responses include soft-deleted rows; drop them.
          setEntries(tasks.filter(isLive));
          setError(null);
        }
      } catch (e) {
        if (active) {
          setError(
            e instanceof ApiError && e.isAuthError
              ? 'Sign in required — open Profile to connect your account.'
              : (e as Error).message,
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const toggleDone = async (task: Task) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await api.updateTask(task.id, {
        isDone: !task.isDone,
        updatedAt: new Date().toISOString(),
      });
      load();
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
    }
  };

  const confirmDelete = (entry: Task) => {
    Alert.alert('Delete task', `Delete "${entry.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteTask(entry.id);
            load();
          } catch (e) {
            Alert.alert('Error', (e as Error).message);
          }
        },
      },
    ]);
  };

  const matches = (t: Task, f: Filter) =>
    f === 'all' ? true : f === 'done' ? t.isDone : !t.isDone;
  const countOf = (f: Filter) => entries.filter((e) => matches(e, f)).length;
  const visible = entries.filter((e) => matches(e, filter));

  return (
    <Screen>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            {/* ── Headline + add button ── */}
            <View style={styles.headerRow}>
              <Text style={styles.headline}>My{'\n'}Journal</Text>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  setAddOpen(true);
                }}
              >
                <LinearGradient
                  colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
                  start={ACCENT_GRADIENT.start}
                  end={ACCENT_GRADIENT.end}
                  style={styles.circleBtn}
                >
                  <Plus color="#fff" size={24} />
                </LinearGradient>
              </Pressable>
            </View>

            {/* ── Status filter chips (same pattern as Today's Tasks) ── */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10, paddingBottom: 4 }}
              style={{ marginBottom: spacing.md }}
            >
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
                  >
                    <View style={[styles.chipCount, active && styles.chipCountActive]}>
                      <Text style={styles.chipCountText}>{countOf(f.key)}</Text>
                    </View>
                    <Text style={styles.chipLabel}>{f.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </>
        }
        ListEmptyComponent={
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {error ? 'Couldn’t load tasks' : 'No tasks yet'}
            </Text>
            <Text style={styles.cardBody}>
              {error ?? 'Tap + to add your first task.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const { priority, text } = parsePriority(item.notes);
          const chip = PRIORITY_CHIP[priority ?? 'Medium'];
          const due = item.dueAt ? new Date(item.dueAt) : null;
          return (
            <Pressable
              onPress={() => toggleDone(item)}
              onLongPress={() => confirmDelete(item)}
              style={styles.card}
            >
              <View style={styles.cardTopRow}>
                <View style={[styles.moodChip, { backgroundColor: chip.bg }]}>
                  <View style={[styles.moodDot, { backgroundColor: chip.color }]} />
                  <Text style={[styles.moodText, { color: chip.color }]}>{chip.label}</Text>
                </View>
                <View style={styles.arrowBtn}>
                  {item.isDone ? (
                    <Check color="#3EA06B" size={18} />
                  ) : (
                    <ArrowUpRight color={colors.text} size={18} />
                  )}
                </View>
              </View>
              <Text style={[styles.cardTitle, item.isDone && styles.cardTitleDone]}>
                {item.title}
              </Text>
              {text ? (
                <Text style={styles.cardBody} numberOfLines={3}>
                  {text}
                </Text>
              ) : null}
              <View style={styles.cardBottomRow}>
                <Clock color={colors.textMuted} size={15} />
                <Text style={styles.cardDate}>
                  {due
                    ? `${due.toLocaleDateString('en-US', {
                        weekday: 'short',
                        month: 'long',
                        day: 'numeric',
                      })}  ·  ${due.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}`
                    : 'No due date'}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />

      <AddSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onManual={() => {
          setAddOpen(false);
          navigation.navigate('EntryForm', { kind: 'task' });
        }}
        onAssistant={() => {
          setAddOpen(false);
          navigation.navigate('Assistant');
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  headline: {
    ...font(400),
    fontSize: 34,
    lineHeight: 42,
    color: colors.text,
    letterSpacing: -0.6,
  },
  headlineStrong: { ...font(600) },
  circleBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingVertical: 10,
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
  chipCountText: { ...font(600), fontSize: 14, color: colors.text },
  chipLabel: { ...font(500), fontSize: 14, color: colors.text },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: spacing.md + 4,
    marginBottom: 14,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  moodChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 50,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  moodDot: { width: 7, height: 7, borderRadius: 4 },
  moodText: { ...font(500), fontSize: 12 },
  arrowBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F4F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { ...font(600), fontSize: 17, color: colors.text, marginBottom: 6 },
  cardTitleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
  cardBody: {
    ...font(400),
    fontSize: 14,
    color: colors.textMuted,
    lineHeight: 20,
    marginBottom: 12,
  },
  cardBottomRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardDate: { ...font(400), fontSize: 13, color: colors.textMuted },
});
