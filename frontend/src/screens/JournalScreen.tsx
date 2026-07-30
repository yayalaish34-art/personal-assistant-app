import { useCallback, useMemo, useState } from 'react';
import { FlatList, ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { Plus, ArrowUpRight, Clock, Check } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { useTheme } from '../lib/theme';
import { api, type Task } from '../lib/api';
import { parsePriority, isLive } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { spacing, radius, font, cardStyle, chipStyle, priorityColors, type Palette } from '../theme';
import { t, isRTL } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// The backend has no journal resource, so this screen is the task list —
// GET/PATCH/DELETE /tasks. Priority still rides in the notes field as a
// "[High] " prefix, since the schema has no priority column.

const FILTERS = [
  { key: 'all', labelKey: 'tasks.filter.all' },
  { key: 'open', labelKey: 'tasks.filter.open' },
  { key: 'done', labelKey: 'tasks.filter.done' },
] as const;

type Filter = (typeof FILTERS)[number]['key'];

export default function JournalScreen() {
  const navigation = useNavigation<Nav>();
  const { palette: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const priorities = useMemo(() => priorityColors(c), [c]);

  const [entries, setEntries] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

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
          setError( (e as Error).message,
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
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const confirmDelete = (entry: Task) => {
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: entry.title }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteTask(entry.id);
            load();
          } catch (e) {
            Alert.alert(t('common.error'), (e as Error).message);
          }
        },
      },
    ]);
  };

  const matches = (task: Task, f: Filter) =>
    f === 'all' ? true : f === 'done' ? task.isDone : !task.isDone;
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
              <Text style={[styles.headline, { textAlign: isRTL() ? 'right' : 'left' }]}>
                {t('tasks.headline.line1')}{'\n'}
                <Text style={styles.headlineStrong}>{t('tasks.headline.line2')}</Text>
              </Text>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  navigation.navigate('Assistant');
                }}
                style={styles.circleBtn}
              >
                <Plus color={c.onAccent} size={24} />
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
                      <Text style={[styles.chipCountText, active && styles.chipCountTextActive]}>
                        {countOf(f.key)}
                      </Text>
                    </View>
                    <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
                      {t(f.labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </>
        }
        ListEmptyComponent={
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {error ? t('tasks.error.title') : t('tasks.empty.title')}
            </Text>
            <Text style={styles.cardBody}>
              {error ?? t('tasks.empty.body')}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const { priority, text } = parsePriority(item.notes);
          const pc = priorities[priority ?? 'Medium'];
          const due = item.dueAt ? new Date(item.dueAt) : null;
          return (
            <Pressable
              onPress={() => toggleDone(item)}
              onLongPress={() => confirmDelete(item)}
              style={styles.card}
            >
              <View style={styles.cardTopRow}>
                <View style={[styles.priorityPill, { backgroundColor: pc.bg }]}>
                  <Text style={[styles.priorityText, { color: pc.color }]}>
                    {t('today.priority', { level: priority ?? 'Medium' })}
                  </Text>
                </View>
                <View style={styles.arrowBtn}>
                  {item.isDone ? (
                    <Check color={c.success} size={18} />
                  ) : (
                    <ArrowUpRight color={c.textMuted} size={18} />
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
                <Clock color={c.textMuted} size={15} />
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
                    : t('tasks.noDue')}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />

    </Screen>
  );
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.lg,
    },
    headline: {
      ...font(400),
      fontSize: 30,
      lineHeight: 36,
      color: c.text,
      letterSpacing: -0.5,
      flex: 1,
    },
    headlineStrong: { ...font(600) },
    circleBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginStart: spacing.md,
    },

    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      paddingVertical: 10,
      paddingStart: 8,
      paddingEnd: 18,
    },
    chipActive: { backgroundColor: c.primary },
    chipCount: {
      width: 28,
      height: 28,
      borderRadius: radius.sm - 4,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chipCountActive: { backgroundColor: `${c.onAccent}33` },
    chipCountText: { ...font(600), fontSize: 13, color: c.text },
    chipCountTextActive: { color: c.onAccent },
    chipLabel: { ...font(500), fontSize: 14, color: c.textMuted },
    chipLabelActive: { color: c.onAccent },

    card: { ...cardStyle(c), marginBottom: 14 },
    cardTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    priorityPill: {
      ...chipStyle(),
    },
    priorityText: { ...font(500), fontSize: 12 },
    arrowBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardTitle: { ...font(600), fontSize: 16.5, color: c.text, marginBottom: 6 },
    cardTitleDone: { textDecorationLine: 'line-through', color: c.textMuted },
    cardBody: {
      ...font(400),
      fontSize: 14,
      color: c.textMuted,
      lineHeight: 20,
      marginBottom: 12,
    },
    cardBottomRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    cardDate: { ...font(400), fontSize: 12.5, color: c.textMuted },
  });
}
