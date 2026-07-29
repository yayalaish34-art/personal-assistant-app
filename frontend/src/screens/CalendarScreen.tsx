import { useCallback, useMemo, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  LayoutAnimation,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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
import { api } from '../lib/api';
import {
  parsePriority,
  statusOf,
  to12h,
  toDateStr,
  eventToItem,
  taskToItem,
  type AgendaItem,
} from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, ACCENT_GRADIENT } from '../theme';
import { t } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const AVATAR_COLORS = ['#F2A0B5', '#9D8BFA', '#F1C46B'];

const STATUS_CHIP = {
  inprogress: { bg: '#ECE7FE', color: '#7B68F0', labelKey: 'calendar.status.inprogress' },
  todo: { bg: '#E5EFFE', color: '#3D7BF7', labelKey: 'calendar.status.todo' },
  done: { bg: '#E8F5EE', color: '#3EA06B', labelKey: 'calendar.status.done' },
} as const;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * The full month grid containing `anchor`, as weeks of 7 days. Leading and
 * trailing days from the neighbouring months pad the grid so every row is
 * complete; `inMonth` distinguishes them so they can render dimmed.
 */
function monthGrid(anchor: Date): { date: Date; inMonth: boolean }[][] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  // Monday-first: how many days of the previous month lead the grid.
  const lead = (first.getDay() + 6) % 7;

  const start = new Date(year, month, 1 - lead);
  const weeks: { date: Date; inMonth: boolean }[][] = [];
  const cursor = new Date(start);

  // Emit whole weeks until we've passed the end of the month.
  do {
    const week = [...Array(7)].map(() => {
      const date = new Date(cursor);
      cursor.setDate(cursor.getDate() + 1);
      return { date, inMonth: date.getMonth() === month };
    });
    weeks.push(week);
  } while (cursor.getMonth() === month && weeks.length < 6);

  return weeks;
}

function sectionOf(e: AgendaItem): 'All Day' | 'Morning' | 'Afternoon' | 'Evening' {
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
  const [events, setEvents] = useState<AgendaItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'work' | 'personal'>('all');

  // The month currently on screen, anchored to its 1st. Kept separate from
  // `selected` so paging months doesn't move the selected day.
  const [visibleMonth, setVisibleMonth] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // The month grid is collapsed until the Calendar button opens it.
  const [monthOpen, setMonthOpen] = useState(false);
  // All task dates, for the "has tasks" dots under the day cells.
  const [markedDates, setMarkedDates] = useState<Set<string>>(new Set());

  const selectedStr = toDateStr(selected);
  const todayStr = toDateStr(new Date());
  const grid = useMemo(
    () => monthGrid(visibleMonth),
    [visibleMonth.getFullYear(), visibleMonth.getMonth()], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        // The day list: /agenda resolves the date in the user's timezone.
        const { events: ev, tasks } = await api.agendaForDate(selectedStr);
        if (active) {
          const items = [...ev.map(eventToItem), ...tasks.map(taskToItem)];
          setEvents(items.sort((a, b) => (a.time || '').localeCompare(b.time || '')));
          setError(null);
        }
      } catch (e) {
        if (active) {
          setError( (e as Error).message,
          );
        }
      }
      // Dots for the visible month, fetched as one range request. A failure
      // here only means no dots, so it must not clobber the list's error.
      try {
        const y = visibleMonth.getFullYear();
        const m = visibleMonth.getMonth();
        const from = toDateStr(new Date(y, m, 1));
        const to = toDateStr(new Date(y, m + 1, 0));
        const { events: mev, tasks: mtasks } = await api.agendaForRange(from, to);
        if (active) {
          setMarkedDates(
            new Set(
              [...mev.map(eventToItem), ...mtasks.map(taskToItem)]
                .map((i) => i.date)
                .filter(Boolean),
            ),
          );
        }
      } catch {
        /* dots are decorative — ignore */
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStr, visibleMonth.getFullYear(), visibleMonth.getMonth()]);

  useFocusEffect(load);

  const shiftMonth = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setVisibleMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  };

  const shiftDay = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const d = new Date(selected);
    d.setDate(d.getDate() + delta);
    setSelected(d);
    // Follow the day into a new month so the grid never shows a selection
    // that isn't visible.
    setVisibleMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const openAddTask = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate('Assistant');
  };

  const confirmDelete = (evt: AgendaItem) => {
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: evt.title }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            // Tasks and events are distinct resources with distinct ids.
            if (evt.kind === 'task') await api.deleteTask(evt.id);
            else await api.deleteEvent(evt.id);
            load();
          } catch (e) {
            Alert.alert(t('common.error'), (e as Error).message);
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
            style={[styles.circleWhite, { marginStart: 10 }]}
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
          {/* Light first line, heavier second — same treatment as
              "Let's Make / Today Productive" on the Today screen. */}
          <Text style={styles.headline}>
            Task{'\n'}
            <Text style={styles.headlineStrong}>Schedule</Text>
          </Text>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              // Opening always lands on the selected day's month, so the grid
              // never appears showing a month the selection isn't in.
              if (!monthOpen) {
                setVisibleMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
              }
              LayoutAnimation.configureNext(
                LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, 'opacity'),
              );
              setMonthOpen((v) => !v);
            }}
            style={[styles.calendarPill, monthOpen && styles.calendarPillActive]}
          >
            <CalendarIcon color={monthOpen ? '#FFFFFF' : colors.text} size={17} />
            <Text style={[styles.calendarPillText, monthOpen && { color: '#FFFFFF' }]}>
              {t('calendar.button')}
            </Text>
            <ChevronDown
              color={monthOpen ? '#FFFFFF' : colors.textMuted}
              size={15}
              style={{ transform: [{ rotate: monthOpen ? '180deg' : '0deg' }] }}
            />
          </Pressable>
        </View>

        {/* ── Month calendar: only mounted once the Calendar button opens it ── */}
        {monthOpen ? (
        <LinearGradient
          colors={[
            'rgba(255,255,255,0.96)',
            'rgba(248,242,254,0.86)',
            'rgba(234,220,251,0.76)',
          ]}
          locations={[0, 0.55, 1]}
          start={{ x: 0.05, y: 0 }}
          end={{ x: 0.95, y: 1 }}
          style={styles.monthCard}
        >
          {/* Month nav: ‹ July 2026 › + a Today shortcut */}
          <View style={styles.monthNav}>
            <Pressable onPress={() => shiftMonth(-1)} style={styles.monthArrow} hitSlop={8}>
              <ChevronLeft color={colors.text} size={19} />
            </Pressable>
            <View style={styles.monthLabelBox}>
              <Text style={styles.monthLabel}>
                {visibleMonth.toLocaleDateString('en-US', { month: 'long' })}{' '}
                <Text style={styles.monthLabelYear}>{visibleMonth.getFullYear()}</Text>
              </Text>
            </View>
            <Pressable onPress={() => shiftMonth(1)} style={styles.monthArrow} hitSlop={8}>
              <ChevronRight color={colors.text} size={19} />
            </Pressable>
          </View>

          {/* Weekday header */}
          <View style={styles.weekRow}>
            {WEEKDAYS.map((w) => (
              <Text key={w} style={styles.weekdayLabel}>
                {w}
              </Text>
            ))}
          </View>

          {/* Day grid */}
          {grid.map((week, wi) => (
            <View key={wi} style={styles.weekRow}>
              {week.map(({ date, inMonth }) => {
                const dStr = toDateStr(date);
                const active = dStr === selectedStr;
                const isToday = dStr === todayStr;
                const marked = markedDates.has(dStr);
                return (
                  <Pressable
                    key={dStr}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setSelected(new Date(date));
                      // Tapping a spill-over day follows it into its month.
                      if (!inMonth) {
                        setVisibleMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                      }
                    }}
                    style={styles.dayCell}
                  >
                    {active ? (
                      <LinearGradient
                        colors={['#A98CF8', '#7C57EE']}
                        start={{ x: 0.15, y: 0 }}
                        end={{ x: 0.85, y: 1 }}
                        style={styles.dayCellFill}
                      />
                    ) : isToday ? (
                      <View style={styles.dayCellToday} />
                    ) : null}
                    <Text
                      style={[
                        styles.dayCellText,
                        !inMonth && styles.dayCellTextMuted,
                        active && styles.dayCellTextActive,
                        !active && isToday && styles.dayCellTextToday,
                      ]}
                    >
                      {date.getDate()}
                    </Text>
                    {marked ? (
                      <View
                        style={[styles.dayDot, active && styles.dayDotActive]}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </LinearGradient>
        ) : null}

        {/* ── Filter chips ── */}
        <View style={styles.filterRow}>
          {(
            [
              { key: 'all', label: t('calendar.filter.all'), Icon: null },
              { key: 'work', label: t('calendar.filter.work'), Icon: Briefcase },
              { key: 'personal', label: t('calendar.filter.personal'), Icon: User },
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
                                  { backgroundColor: c, marginStart: i ? -9 : 0 },
                                ]}
                              />
                            ))}
                            <View style={[styles.avatarDot, styles.avatarMore]}>
                              <Text style={styles.avatarMoreText}>+4</Text>
                            </View>
                          </View>
                          <View style={[styles.statusChip, { backgroundColor: st.bg }]}>
                            <Text style={[styles.statusChipText, { color: st.color }]}>
                              {t(st.labelKey)}
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
    paddingVertical: 14,
    marginStart: 10,
  },
  datePillText: { ...font(500), fontSize: 14, color: colors.text },
  dotsRow: { flexDirection: 'row', gap: 3 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.text },

  headlineRow: {
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
  calendarPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingStart: 16,
    paddingEnd: 13,
    paddingVertical: 15,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },
  calendarPillActive: {
    backgroundColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 3,
  },
  calendarPillText: { ...font(500), fontSize: 15, color: colors.text },

  monthCard: {
    borderRadius: 28,
    padding: spacing.md,
    paddingBottom: spacing.sm + 2,
    marginBottom: spacing.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.75)',
    shadowColor: '#5B3FA8',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 4,
  },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  monthArrow: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)',
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 1,
  },
  monthLabelBox: { flex: 1, alignItems: 'center' },
  // "July" heavier, the year lighter — the same weight pairing as the headline.
  monthLabel: { ...font(600), fontSize: 17, color: colors.text, letterSpacing: -0.2 },
  monthLabelYear: { ...font(400), color: colors.textMuted },

  weekRow: { flexDirection: 'row', justifyContent: 'space-between' },
  weekdayLabel: {
    ...font(500),
    fontSize: 11,
    color: colors.textMuted,
    width: 38,
    textAlign: 'center',
    marginBottom: 6,
  },
  dayCell: {
    width: 38,
    height: 43,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  dayCellFill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 13,
    shadowColor: '#6B4CC4',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 7,
  },
  dayCellToday: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: 'rgba(136,117,246,0.5)',
  },
  dayCellText: { ...font(500), fontSize: 14, color: colors.text },
  dayCellTextMuted: { color: 'rgba(142,139,150,0.45)' },
  dayCellTextActive: { ...font(600), color: '#FFFFFF' },
  dayCellTextToday: { ...font(600), color: colors.primary },
  dayDot: {
    position: 'absolute',
    bottom: 4,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  dayDotActive: { backgroundColor: 'rgba(255,255,255,0.9)' },

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
    paddingVertical: 13,
  },
  filterChipActive: { backgroundColor: '#17171B' },
  filterText: { ...font(500), fontSize: 14, color: colors.text },
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
  sectionTitle: { ...font(600), fontSize: 16, color: colors.text },
  sectionRight: { ...font(400), fontSize: 13, color: colors.textMuted },

  timelineRow: { flexDirection: 'row', marginBottom: spacing.md },
  timeCol: { width: 48, alignItems: 'center', paddingTop: 2 },
  timeHour: { ...font(600), fontSize: 16, color: colors.text },
  timeAmPm: { ...font(400), fontSize: 11, color: colors.textMuted, marginTop: 1 },
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
    padding: spacing.md + 2,
    marginStart: 6,
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
  cardTitle: { ...font(600), fontSize: 15.5, color: colors.text, marginBottom: 4 },
  cardNotes: {
    ...font(400),
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
    marginStart: -9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarMoreText: { ...font(500), fontSize: 9, color: '#FFFFFF' },
  statusChip: { borderRadius: 50, paddingHorizontal: 13, paddingVertical: 7 },
  statusChipText: { ...font(500), fontSize: 12 },
});
