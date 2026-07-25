import { useCallback, useState } from 'react';
import { FlatList, ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Plus, ArrowUpRight, Clock } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api, JournalEntry } from '../lib/api';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, ACCENT_GRADIENT, PRIORITY_COLORS } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const MOOD_CHIP: Record<string, { label: string; color: string; bg: string }> = {
  good: { label: 'Good', ...PRIORITY_COLORS.Low },
  neutral: { label: 'Okay', ...PRIORITY_COLORS.Medium },
  bad: { label: 'Low', ...PRIORITY_COLORS.High },
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'good', label: 'Good' },
  { key: 'neutral', label: 'Okay' },
  { key: 'bad', label: 'Low' },
] as const;

type Filter = (typeof FILTERS)[number]['key'];

export default function JournalScreen() {
  const navigation = useNavigation<Nav>();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const data = await api.listJournal();
        if (active) {
          setEntries(data);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const confirmDelete = (entry: JournalEntry) => {
    Alert.alert('Delete entry', `Delete "${entry.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteJournal(entry.id);
            load();
          } catch (e) {
            Alert.alert('Error', (e as Error).message);
          }
        },
      },
    ]);
  };

  const countOf = (f: Filter) =>
    f === 'all' ? entries.length : entries.filter((e) => e.mood === f).length;
  const visible = filter === 'all' ? entries : entries.filter((e) => e.mood === filter);

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
                  navigation.navigate('EntryForm', { kind: 'journal' });
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

            {/* ── Mood filter chips (same pattern as Today's Tasks) ── */}
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
              {error ? 'Couldn’t load entries' : 'No entries yet'}
            </Text>
            <Text style={styles.cardBody}>
              {error ?? 'Tap + to write your first journal entry.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const chip = MOOD_CHIP[item.mood];
          const created = new Date(item.createdAt);
          return (
            <Pressable onLongPress={() => confirmDelete(item)} style={styles.card}>
              <View style={styles.cardTopRow}>
                {chip ? (
                  <View style={[styles.moodChip, { backgroundColor: chip.bg }]}>
                    <View style={[styles.moodDot, { backgroundColor: chip.color }]} />
                    <Text style={[styles.moodText, { color: chip.color }]}>{chip.label}</Text>
                  </View>
                ) : (
                  <View />
                )}
                <View style={styles.arrowBtn}>
                  <ArrowUpRight color={colors.text} size={18} />
                </View>
              </View>
              <Text style={styles.cardTitle}>{item.title}</Text>
              {item.body ? (
                <Text style={styles.cardBody} numberOfLines={3}>
                  {item.body}
                </Text>
              ) : null}
              <View style={styles.cardBottomRow}>
                <Clock color={colors.textMuted} size={15} />
                <Text style={styles.cardDate}>
                  {created.toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'long',
                    day: 'numeric',
                  })}
                  {'  ·  '}
                  {created.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
            </Pressable>
          );
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
    fontWeight: '500',
    fontSize: 28,
    lineHeight: 34,
    color: colors.text,
    letterSpacing: -0.3,
  },
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

  card: {
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
  moodText: { fontWeight: '500', fontSize: 12 },
  arrowBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F4F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontWeight: '600', fontSize: 17, color: colors.text, marginBottom: 6 },
  cardBody: {
    fontWeight: '400',
    fontSize: 14,
    color: colors.textMuted,
    lineHeight: 20,
    marginBottom: 12,
  },
  cardBottomRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardDate: { fontWeight: '400', fontSize: 13, color: colors.textMuted },
});
