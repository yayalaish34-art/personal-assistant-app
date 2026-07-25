import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import {
  ArrowLeft,
  Plus,
  Calendar as CalendarIcon,
  Sun,
  Sunset,
  Moon,
  Briefcase,
  User,
  Star,
} from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api, CalendarEvent } from '../lib/api';
import { parsePriority, statusOf, to12h, toDateStr } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, ACCENT_GRADIENT } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const AVATAR_COLORS = ['#F2A0B5', '#9D8BFA', '#F1C46B'];

const STATUS_CHIP = {
  inprogress: { bg: '#ECE7FE', color: '#7B68F0', label: 'In Progress' },
  todo: { bg: '#E5EFFE', color: '#3D7BF7', label: 'Upcoming' },
  done: { bg: '#E8F5EE', color: '#3EA06B', label: 'Done' },
} as const;

function weekOf(anchor: Date): Date[] {
  const monOffset = (anchor.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - monOffset);
  return [...Array(7)].map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function sectionOf(e: CalendarEvent): 'All Day' | 'Morning' | 'Afternoon' | 'Evening' {
  if (!e.time) return 'All Day';
  const h = parseInt(e.time.split(':')[0], 10);
  if (Number.isNaN(h)) return 'All Day';
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

const SECTION_ICON = {
  'All Day': Star,
  Morning: Sun,
  Afternoon: Sunset,
  Evening: Moon,
} as const;

export default function CalendarScreen() {
  const navigation = useNavigation<Nav>();
  const [selected, setSelected] = useState<Date>(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'work' | 'personal'>('all');

  const selectedStr = toDateStr(selected);
  const todayStr = toDateStr(new Date());
  const week = useMemo(() => weekOf(selected), [selectedStr]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const data = await api.listEvents(selectedStr);
        if (active) {
          setEvents(data.sort((a, b) => (a.time || '').localeCompare(b.time || '')));
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedStr]);

  useFocusEffect(load);

  const shiftDay = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const d = new Date(selected);
    d.setDate(d.getDate() + delta);
    setSelected(d);
  };

  const openAddTask = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate('EntryForm', { kind: 'event' });
  };

  const confirmDelete = (evt: CalendarEvent) => {
    Alert.alert('Delete task', `Delete "${evt.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteEvent(evt.id);
            load();
          } catch (e) {
            Alert.alert('Error', (e as Error).message);
          }
        },
      },
    ]);
  };

  const now = new Date();
  const sections = useMemo(() => {
    const order = ['All Day', 'Morning', 'Afternoon', 'Evening'] as const;
    return order
      .map((title) => ({ title, data: events.filter((e) => sectionOf(e) === title) }))
      .filter((s) => s.data.length > 0);
  }, [events]);

  const headerDate = selected.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
  });

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ── Header row ── */}
        <View style={styles.headerRow}>
          <Pressable onPress={() => shiftDay(-1)} style={styles.circleWhite}>
            <ArrowLeft color={colors.text} size={20} />
          </Pressable>
          <View style={styles.datePill}>
            <Text style={styles.datePillText}>{headerDate}</Text>
          </View>
          <View style={{ flex: 1 }} />
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
            style={[styles.circleWhite, { marginLeft: 10 }]}
          >
            <View style={styles.dotsRow}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={styles.dot} />
              ))}
            </View>
          </Pressable>
        </View>

        {/* ── Headline ── */}
        <View style={styles.headlineRow}>
          <Text style={styles.headline}>Task{'\n'}Schedule</Text>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setSelected(new Date());
            }}
            style={styles.calendarPill}
          >
            <CalendarIcon color={colors.text} size={17} />
            <Text style={styles.calendarPillText}>Calendar</Text>
          </Pressable>
        </View>

        {/* ── Week selector ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 9, paddingBottom: 4 }}
          style={{ marginBottom: spacing.md }}
        >
          {week.map((d) => {
            const dStr = toDateStr(d);
            const active = dStr === selectedStr;
            return (
              <Pressable
                key={dStr}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelected(new Date(d));
                }}
                style={styles.dayPill}
              >
                <Text style={styles.dayName}>
                  {d.toLocaleDateString('en-US', { weekday: 'short' })}
                </Text>
                <View style={[styles.dayNum, active && styles.dayNumActive]}>
                  <Text style={[styles.dayNumText, active && styles.dayNumTextActive]}>
                    {d.getDate()}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* ── Filter chips ── */}
        <View style={styles.filterRow}>
          {(
            [
              { key: 'all', label: 'All', Icon: null },
              { key: 'work', label: 'Work', Icon: Briefcase },
              { key: 'personal', label: 'Personal', Icon: User },
            ] as const
          ).map(({ key, label, Icon }) => {
            const active = filter === key;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setFilter(key);
                }}
                style={[styles.filterChip, active && styles.filterChipActive]}
              >
                {Icon ? <Icon color={active ? '#fff' : colors.text} size={15} /> : null}
                <Text style={[styles.filterText, active && { color: '#fff' }]}>{label}</Text>
              </Pressable>
            );
          })}
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
            style={styles.starBtn}
          >
            <Star color={colors.text} size={17} />
          </Pressable>
        </View>

        {/* ── Timeline ── */}
        {error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.cardTitle}>Couldn{'’'}t load tasks</Text>
            <Text style={styles.cardNotes}>{error}</Text>
          </View>
        ) : sections.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.cardTitle}>Nothing scheduled</Text>
            <Text style={styles.cardNotes}>Tap + to plan something for this day.</Text>
          </View>
        ) : (
          sections.map((section) => {
            const SIcon = SECTION_ICON[section.title];
            return (
              <View key={section.title} style={{ marginBottom: spacing.sm }}>
                <View style={styles.sectionHeader}>
                  <SIcon color={colors.text} size={17} />
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  <View style={{ flex: 1 }} />
                  {selectedStr === todayStr ? <Text style={styles.sectionRight}>Today</Text> : null}
                </View>

                {section.data.map((e) => {
                  const st = STATUS_CHIP[statusOf(e, now)];
                  const { text: notesText } = parsePriority(e.notes);
                  const hourLabel = e.time ? to12h(e.time).split(' ') : null;
                  return (
                    <Pressable
                      key={e.id}
                      onLongPress={() => confirmDelete(e)}
                      style={styles.timelineRow}
                    >
                      <View style={styles.timeCol}>
                        {hourLabel ? (
                          <>
                            <Text style={styles.timeHour}>{hourLabel[0]}</Text>
                            <Text style={styles.timeAmPm}>{hourLabel[1]}</Text>
                          </>
                        ) : (
                          <Text style={styles.timeAmPm}>—</Text>
                        )}
                        <View style={styles.timeLine} />
                      </View>
                      <View style={styles.taskCard}>
                        <Text style={styles.cardTitle}>{e.title}</Text>
                        {notesText ? (
                          <Text style={styles.cardNotes} numberOfLines={2}>
                            {notesText}
                          </Text>
                        ) : null}
                        <View style={styles.cardBottom}>
                          <View style={styles.avatarRow}>
                            {AVATAR_COLORS.map((c, i) => (
                              <View
                                key={c}
                                style={[
                                  styles.avatarDot,
                                  { backgroundColor: c, marginLeft: i ? -9 : 0 },
                                ]}
                              />
                            ))}
                            <View style={[styles.avatarDot, styles.avatarMore]}>
                              <Text style={styles.avatarMoreText}>+4</Text>
                            </View>
                          </View>
                          <View style={[styles.statusChip, { backgroundColor: st.bg }]}>
                            <Text style={[styles.statusChipText, { color: st.color }]}>
                              {st.label}
                            </Text>
                          </View>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg },
  circleWhite: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  circleBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  datePill: {
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginLeft: 10,
  },
  datePillText: { fontWeight: '500', fontSize: 14, color: colors.text },
  dotsRow: { flexDirection: 'row', gap: 3 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.text },

  headlineRow: {
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
  calendarPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  calendarPillText: { fontWeight: '500', fontSize: 15, color: colors.text },

  dayPill: {
    backgroundColor: '#FFFFFF',
    borderRadius: 26,
    paddingTop: 10,
    paddingBottom: 6,
    paddingHorizontal: 6,
    alignItems: 'center',
    width: 52,
  },
  dayName: { fontWeight: '400', fontSize: 12, color: colors.textMuted, marginBottom: 6 },
  dayNum: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumActive: { backgroundColor: '#17171B' },
  dayNumText: { fontWeight: '600', fontSize: 15, color: colors.text },
  dayNumTextActive: { color: '#FFFFFF' },

  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginBottom: spacing.lg,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  filterChipActive: { backgroundColor: '#17171B' },
  filterText: { fontWeight: '500', fontSize: 14, color: colors.text },
  starBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: spacing.md,
  },
  sectionTitle: { fontWeight: '600', fontSize: 16, color: colors.text },
  sectionRight: { fontWeight: '400', fontSize: 13, color: colors.textMuted },

  timelineRow: { flexDirection: 'row', marginBottom: spacing.md },
  timeCol: { width: 48, alignItems: 'center', paddingTop: 2 },
  timeHour: { fontWeight: '600', fontSize: 16, color: colors.text },
  timeAmPm: { fontWeight: '400', fontSize: 11, color: colors.textMuted, marginTop: 1 },
  timeLine: {
    flex: 1,
    width: 1.5,
    backgroundColor: '#E5DCE5',
    marginTop: 8,
    borderRadius: 1,
  },

  taskCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: spacing.md,
    marginLeft: 6,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 14,
    elevation: 2,
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: spacing.lg,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 14,
    elevation: 2,
  },
  cardTitle: { fontWeight: '600', fontSize: 15.5, color: colors.text, marginBottom: 4 },
  cardNotes: {
    fontWeight: '400',
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: 6,
  },
  cardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  avatarRow: { flexDirection: 'row', alignItems: 'center' },
  avatarDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  avatarMore: {
    backgroundColor: '#17171B',
    marginLeft: -9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarMoreText: { fontWeight: '500', fontSize: 9, color: '#FFFFFF' },
  statusChip: { borderRadius: 50, paddingHorizontal: 13, paddingVertical: 7 },
  statusChipText: { fontWeight: '500', fontSize: 12 },
});
