import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet, Alert, LayoutAnimation } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { Ellipsis, ChevronLeft, ChevronRight, Clock } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api } from '../lib/api';
import {
  parsePriority,
  statusOf,
  to12h,
  plusHour,
  toDateStr,
  toTimeStr,
  eventToItem,
  taskToItem,
  type AgendaItem,
  type TaskStatus,
} from '../lib/tasks';
import { useTheme } from '../lib/theme';
import { spacing, radius, font, cardStyle, priorityColors, type Palette } from '../theme';
import { t, isRTL, locale } from '../lib/i18n';

const AVATAR_COLORS = ['#F2A0B5', '#9D8BFA', '#F1C46B'];

/**
 * Monday-first weekday abbreviations in the active language. Derived rather
 * than hardcoded: the literal English list rendered untranslated in all six
 * other locales, while the week strip directly above it was already
 * locale-aware — the two rows disagreed.
 */
function weekdayLabels(): string[] {
  // 2024-01-01 was a Monday, so this walks Mon→Sun.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: 'short' }),
  );
}

const STATUS_LABEL_KEY: Record<TaskStatus, string> = {
  todo: 'calendar.status.todo',
  inprogress: 'calendar.status.inprogress',
  done: 'calendar.status.done',
};

function statusColor(c: Palette, s: TaskStatus): string {
  if (s === 'done') return c.success;
  if (s === 'inprogress') return c.primary;
  return c.lavender;
}

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

/** The Sun–Sat week containing `d`. */
function weekOf(d: Date): Date[] {
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
}

export default function CalendarScreen() {
  const { palette: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const pColors = useMemo(() => priorityColors(c), [c]);

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
  // The month grid is collapsed until the header button opens it.
  const [monthOpen, setMonthOpen] = useState(false);
  // All task dates, for the "has tasks" dots under the day cells.
  const [markedDates, setMarkedDates] = useState<Set<string>>(new Set());

  const selectedStr = toDateStr(selected);
  const todayStr = toDateStr(new Date());
  const grid = useMemo(
    () => monthGrid(visibleMonth),
    [visibleMonth.getFullYear(), visibleMonth.getMonth()], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const week = useMemo(() => weekOf(selected), [selectedStr]); // eslint-disable-line react-hooks/exhaustive-deps

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
          setError((e as Error).message);
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

  const selectDay = (d: Date) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelected(new Date(d));
    setVisibleMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const toggleMonthOpen = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Opening always lands on the selected day's month, so the grid never
    // appears showing a month the selection isn't in.
    if (!monthOpen) {
      setVisibleMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    }
    LayoutAnimation.configureNext(
      LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, 'opacity'),
    );
    setMonthOpen((v) => !v);
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

  const monthLabel = visibleMonth.toLocaleDateString(locale(), { month: 'long' });
  const dayTitle = `${selected.toLocaleDateString(locale(), { weekday: 'long' })} ${selected.getDate()}`;
  const meetingsCount = events.filter((e) => e.kind === 'event').length;
  const tasksCount = events.filter((e) => e.kind === 'task').length;

  // ── Timeline rows: an event/task card, with a spare-time block inserted
  // whenever two consecutive timed items are more than an hour apart. ──
  const timelineNodes: ReactNode[] = [];
  events.forEach((e, idx) => {
    const isEvent = e.kind === 'event';
    const status = statusOf(e, now);
    const { priority } = parsePriority(e.notes);
    const pc = pColors[priority ?? 'High'];
    const timeLabel = e.time ? to12h(e.time) : null;
    const rangeLabel = e.time
      ? `${to12h(e.time)} - ${to12h(e.endsAt ? toTimeStr(new Date(e.endsAt)) : plusHour(e.time))}`
      : null;
    const dueLabel = e.date
      ? new Date(`${e.date}T00:00:00`).toLocaleDateString(locale(), {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : null;
    const onDark = isEvent; // event cards are filled c.cyan, so their text uses c.onLight
    const titleColor = onDark ? c.onLight : c.text;
    const mutedColor = onDark ? c.onLight : c.textMuted;
    const avatarBorder = isEvent ? c.cyan : c.surface;

    timelineNodes.push(
      <View key={e.id} style={styles.timelineRow}>
        <View style={styles.gutter}>
          <Text style={styles.gutterText}>{timeLabel ?? t('tasks.noDue')}</Text>
        </View>
        <Pressable
          onLongPress={() => confirmDelete(e)}
          style={isEvent ? styles.eventCard : styles.taskCardRow}
        >
          <View style={styles.cardTopRow}>
            <View style={[styles.priorityPill, { backgroundColor: pc.bg }]}>
              <View style={[styles.priorityDot, { backgroundColor: pc.color }]} />
              <Text style={[styles.priorityText, { color: pc.color }]}>
                {t('today.priority', { level: priority ?? 'High' })}
              </Text>
            </View>
            <View style={styles.statusTag}>
              <View style={[styles.statusDot, { backgroundColor: statusColor(c, status) }]} />
              <Text style={[styles.statusLabel, { color: mutedColor }]}>
                {t(STATUS_LABEL_KEY[status])}
              </Text>
            </View>
          </View>

          <Text style={[styles.cardTitle, { color: titleColor }]}>{e.title}</Text>

          {rangeLabel ? (
            <View style={styles.clockRow}>
              <Clock color={mutedColor} size={14} />
              <Text style={[styles.clockText, { color: mutedColor }]}>{rangeLabel}</Text>
            </View>
          ) : null}

          {dueLabel ? (
            <Text style={[styles.dueText, { color: mutedColor }]}>
              {t('calendar.dueDate', { date: dueLabel })}
            </Text>
          ) : null}

          <View style={styles.cardBottomRow}>
            <View style={styles.avatarRow}>
              {AVATAR_COLORS.map((ac, i) => (
                <View
                  key={ac}
                  style={[
                    styles.avatarDot,
                    { backgroundColor: ac, borderColor: avatarBorder, marginStart: i ? -9 : 0 },
                  ]}
                />
              ))}
              <View style={[styles.avatarDot, styles.avatarMore, { borderColor: avatarBorder }]}>
                <Text style={styles.avatarMoreText}>+4</Text>
              </View>
            </View>
          </View>
        </Pressable>
      </View>,
    );

    const next = events[idx + 1];
    if (e.time && next?.time) {
      const endMin = e.endsAt
        ? minutesOf(toTimeStr(new Date(e.endsAt)))
        : minutesOf(e.time) + 60;
      const gapMin = minutesOf(next.time) - endMin;
      if (gapMin > 60) {
        const fromH = String(Math.floor((endMin % 1440) / 60)).padStart(2, '0');
        const fromM = String(endMin % 60).padStart(2, '0');
        const fromLabel = to12h(`${fromH}:${fromM}`);
        const toLabel = to12h(next.time);
        timelineNodes.push(
          <View key={`${e.id}-spare`} style={styles.timelineRow}>
            <View style={styles.gutter} />
            <View style={styles.spareBlock}>
              <Text style={styles.spareText}>
                {t('calendar.spareTime', { from: fromLabel, to: toLabel })}
              </Text>
            </View>
          </View>,
        );
      }
    }
  });

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ── Header: centred title + month-grid toggle ── */}
        <View style={styles.headerRow}>
          <View style={styles.headerSpacer} />
          <Text style={styles.headerTitle}>{t('calendar.headline.line2')}</Text>
          <Pressable onPress={toggleMonthOpen} style={styles.headerBtn}>
            <Ellipsis color={c.text} size={20} />
          </Pressable>
        </View>

        {/* ── Month row: advances one month forward ── */}
        <Pressable onPress={() => shiftMonth(1)} style={styles.monthRow} hitSlop={8}>
          <Text style={styles.monthRowText}>
            {monthLabel} {visibleMonth.getFullYear()}
          </Text>
          <ChevronRight color={c.textMuted} size={15} />
        </Pressable>

        {/* ── Week strip ── */}
        <View style={styles.weekStripRow}>
          {week.map((d) => {
            const dStr = toDateStr(d);
            const active = dStr === selectedStr;
            const initial = d.toLocaleDateString(locale(), { weekday: 'narrow' });
            return (
              <Pressable key={dStr} onPress={() => selectDay(d)} style={styles.weekCol}>
                <Text style={styles.weekInitial}>{initial}</Text>
                {active ? <View style={styles.weekDot} /> : <View style={styles.weekDotSpacer} />}
                <View style={[styles.weekCircle, active && styles.weekCircleActive]}>
                  <Text style={[styles.weekDayNum, active && styles.weekDayNumActive]}>
                    {d.getDate()}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.grabHandleWrap}>
          <View style={styles.grabHandle} />
        </View>

        {/* ── Month grid: only mounted once the header button opens it ── */}
        {monthOpen ? (
          <View style={styles.monthCard}>
            <View style={styles.monthNav}>
              <Pressable onPress={() => shiftMonth(-1)} style={styles.monthArrow} hitSlop={8}>
                <ChevronLeft color={c.text} size={19} />
              </Pressable>
              <View style={styles.monthLabelBox}>
                <Text style={styles.monthLabel}>
                  {monthLabel} <Text style={styles.monthLabelYear}>{visibleMonth.getFullYear()}</Text>
                </Text>
              </View>
              <Pressable onPress={() => shiftMonth(1)} style={styles.monthArrow} hitSlop={8}>
                <ChevronRight color={c.text} size={19} />
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {weekdayLabels().map((w) => (
                <Text key={w} style={styles.weekdayLabel}>
                  {w}
                </Text>
              ))}
            </View>

            {grid.map((gWeek, wi) => (
              <View key={wi} style={styles.weekRow}>
                {gWeek.map(({ date, inMonth }) => {
                  const dStr = toDateStr(date);
                  const active = dStr === selectedStr;
                  const isToday = dStr === todayStr;
                  const marked = markedDates.has(dStr);
                  return (
                    <Pressable key={dStr} onPress={() => selectDay(date)} style={styles.dayCell}>
                      {active ? (
                        <View style={styles.dayCellFill} />
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
                        <View style={[styles.dayDot, active && styles.dayDotActive]} />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        ) : null}

        {/* ── Day summary card ── */}
        <View style={styles.summaryCard}>
          <Text style={styles.summaryMuted}>
            {t('calendar.summary', { meetings: meetingsCount, tasks: tasksCount })}
          </Text>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryTitle, { textAlign: isRTL() ? 'right' : 'left' }]}>
              {dayTitle}
            </Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => shiftDay(-1)} style={styles.summaryBtn} hitSlop={6}>
              <ChevronLeft color={c.text} size={18} />
            </Pressable>
            <Pressable
              onPress={() => shiftDay(1)}
              style={[styles.summaryBtn, { marginStart: spacing.xs }]}
              hitSlop={6}
            >
              <ChevronRight color={c.text} size={18} />
            </Pressable>
          </View>
        </View>

        {/* ── Filter chips ── */}
        <View style={styles.filterRow}>
          {(
            [
              { key: 'all', label: t('calendar.filter.all') },
              { key: 'work', label: t('calendar.filter.work') },
              { key: 'personal', label: t('calendar.filter.personal') },
            ] as const
          ).map(({ key, label }) => {
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
                <Text style={[styles.filterText, active && styles.filterTextActive]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* ── Timeline ── */}
        {error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>{t('tasks.error.title')}</Text>
            <Text style={styles.emptyBody}>{error}</Text>
          </View>
        ) : events.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>{t('calendar.empty.title')}</Text>
            <Text style={styles.emptyBody}>{t('calendar.empty.body')}</Text>
          </View>
        ) : (
          timelineNodes
        )}
      </ScrollView>
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
    headerSpacer: { width: 40, height: 40 },
    headerTitle: { flex: 1, textAlign: 'center', ...font(700), fontSize: 22, color: c.text },
    headerBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    monthRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      alignSelf: 'flex-start',
      marginBottom: spacing.md,
    },
    monthRowText: { ...font(500), fontSize: 13, color: c.textMuted },

    weekStripRow: { flexDirection: 'row', justifyContent: 'space-between' },
    weekCol: { alignItems: 'center', width: 40 },
    weekInitial: { ...font(500), fontSize: 11, color: c.textMuted, marginBottom: 6 },
    weekDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: c.onAccent, marginBottom: 4 },
    weekDotSpacer: { width: 5, height: 5, marginBottom: 4 },
    weekCircle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    weekCircleActive: { backgroundColor: c.primary },
    weekDayNum: { ...font(600), fontSize: 14, color: c.text },
    weekDayNumActive: { color: c.onAccent },

    grabHandleWrap: { alignItems: 'center', marginTop: spacing.sm, marginBottom: spacing.md },
    grabHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border },

    monthCard: { ...cardStyle(c), marginBottom: spacing.md },
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
      backgroundColor: c.surfaceAlt,
    },
    monthLabelBox: { flex: 1, alignItems: 'center' },
    monthLabel: { ...font(600), fontSize: 17, color: c.text, letterSpacing: -0.2 },
    monthLabelYear: { ...font(400), color: c.textMuted },

    weekRow: { flexDirection: 'row', justifyContent: 'space-between' },
    weekdayLabel: {
      ...font(500),
      fontSize: 11,
      color: c.textMuted,
      width: 38,
      textAlign: 'center',
      marginBottom: 6,
    },
    dayCell: { width: 38, height: 43, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
    dayCellFill: { ...StyleSheet.absoluteFillObject, borderRadius: 13, backgroundColor: c.primary },
    dayCellToday: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: 13,
      borderWidth: 1.5,
      borderColor: c.primary,
    },
    dayCellText: { ...font(500), fontSize: 14, color: c.text },
    dayCellTextMuted: { color: c.textMuted },
    dayCellTextActive: { ...font(600), color: c.onAccent },
    dayCellTextToday: { ...font(600), color: c.primary },
    dayDot: { position: 'absolute', bottom: 4, width: 4, height: 4, borderRadius: 2, backgroundColor: c.primary },
    dayDotActive: { backgroundColor: c.onAccent },

    summaryCard: { ...cardStyle(c), marginBottom: spacing.lg },
    summaryMuted: { ...font(400), fontSize: 12, color: c.textMuted, marginBottom: 6 },
    summaryRow: { flexDirection: 'row', alignItems: 'center' },
    summaryTitle: { ...font(700), fontSize: 22, color: c.text },
    summaryBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    filterRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: spacing.lg },
    filterChip: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      paddingHorizontal: 18,
      paddingVertical: 12,
    },
    filterChipActive: { backgroundColor: c.primary },
    filterText: { ...font(500), fontSize: 14, color: c.textMuted },
    filterTextActive: { color: c.onAccent },

    timelineRow: { flexDirection: 'row', marginBottom: spacing.md },
    gutter: { width: 58, alignItems: 'flex-start', paddingTop: 4 },
    gutterText: { ...font(500), fontSize: 11, color: c.textMuted },

    eventCard: {
      flex: 1,
      backgroundColor: c.cyan,
      borderRadius: radius.lg,
      padding: spacing.md,
      marginStart: spacing.xs,
    },
    taskCardRow: { ...cardStyle(c), flex: 1, marginStart: spacing.xs },

    cardTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    priorityPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: radius.pill,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    priorityDot: { width: 7, height: 7, borderRadius: 4 },
    priorityText: { ...font(500), fontSize: 12 },
    statusTag: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusLabel: { ...font(500), fontSize: 12 },

    cardTitle: { ...font(600), fontSize: 16, marginBottom: 8 },
    clockRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
    clockText: { ...font(400), fontSize: 13 },
    dueText: { ...font(400), fontSize: 12, marginBottom: 8 },

    cardBottomRow: { flexDirection: 'row', alignItems: 'center' },
    avatarRow: { flexDirection: 'row', alignItems: 'center' },
    avatarDot: { width: 26, height: 26, borderRadius: 13, borderWidth: 2 },
    avatarMore: { backgroundColor: c.text, marginStart: -9, alignItems: 'center', justifyContent: 'center' },
    avatarMoreText: { ...font(500), fontSize: 9, color: c.bg },

    spareBlock: {
      flex: 1,
      backgroundColor: c.lavender + '22',
      borderTopWidth: 1,
      borderStyle: 'dashed',
      borderTopColor: c.pink,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginStart: spacing.xs,
      justifyContent: 'center',
    },
    spareText: { ...font(500), fontSize: 12, color: c.textMuted },

    emptyCard: { ...cardStyle(c) },
    emptyTitle: { ...font(600), fontSize: 15.5, color: c.text, marginBottom: 4 },
    emptyBody: { ...font(400), fontSize: 13, color: c.textMuted, lineHeight: 18 },
  });
}
