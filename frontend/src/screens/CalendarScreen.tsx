import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Users,
  FileText,
  Smile,
} from 'lucide-react-native';

import { Screen, GreetingHeader } from '../components/ui';
import { Entrance } from '../components/motion';
import { api } from '../lib/api';
import { storage } from '../lib/storage';
import {
  statusOf,
  to12h,
  toDateStr,
  eventToItem,
  taskToItem,
  type AgendaItem,
} from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, radius, AURA_CYCLE, AURA } from '../theme';
import { t, locale, isRTL } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PROFILE_PHOTO_URI = 'https://i.pravatar.cc/220?img=47';

type ViewMode = 'day' | 'week' | 'month';

/** The hours the timeline covers. Anything earlier is clamped to the top. */
const FIRST_HOUR = 8;
const LAST_HOUR = 20;
/** Height of one hour row — an entry's block is sized from its duration. */
const HOUR_HEIGHT = 62;
/** The rail the hour labels live in. Entry blocks start after it. */
const GUTTER = 58;

/**
 * Where the blocks start, and where they stop.
 *
 * The hour rail is a flex row, so it mirrors on its own and the label moves to
 * the right in Hebrew. The block layer is absolutely positioned, and a logical
 * inset does not follow the layout the same way — it stayed on the left, so the
 * blocks ran straight over the labels. Naming the physical side keeps the two
 * halves of the timeline agreeing on which edge the rail is.
 */
function gutterSide(): { left: number; right: number } {
  return isRTL() ? { left: 0, right: GUTTER } : { left: GUTTER, right: 0 };
}

/** The seven days of the week `anchor` falls in, Sunday first. */
function weekOf(anchor: Date): Date[] {
  const start = new Date(anchor);
  start.setDate(start.getDate() - start.getDay());
  return [...Array(7)].map((_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** A trailing icon per entry, so blocks read as distinct as in the design. */
function entryIcon(item: AgendaItem, done: boolean) {
  if (done) return CircleCheck;
  if (item.kind === 'task') return FileText;
  if (/lunch|coffee|dinner|ארוחה|צהריים|קפה/i.test(item.title)) return Smile;
  if (/standup|meeting|sync|פגישה|סטנדאפ/i.test(item.title)) return Users;
  return CircleCheck;
}

export default function CalendarScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Date>(new Date());
  const [mode, setMode] = useState<ViewMode>('day');
  const [items, setItems] = useState<AgendaItem[]>([]);

  const selectedStr = toDateStr(selected);
  const todayStr = toDateStr(new Date());
  const week = useMemo(() => weekOf(selected), [selectedStr]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const settings = await storage.getSettings();
      if (active) setName(settings.displayName);
      try {
        if (mode === 'day') {
          const { events, tasks } = await api.agendaForDate(selectedStr);
          if (!active) return;
          setItems(
            [...events.map(eventToItem), ...tasks.map(taskToItem)].sort((a, b) =>
              (a.time || '').localeCompare(b.time || ''),
            ),
          );
          return;
        }
        // Week and month share the range endpoint; only the window differs.
        const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
        const last = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
        const from = mode === 'week' ? toDateStr(week[0]) : toDateStr(first);
        const to = mode === 'week' ? toDateStr(week[6]) : toDateStr(last);
        const { events, tasks } = await api.agendaForRange(from, to);
        if (!active) return;
        setItems(
          [...events.map(eventToItem), ...tasks.map(taskToItem)].sort((a, b) =>
            `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
          ),
        );
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStr, mode]);

  useFocusEffect(load);

  const shiftMonth = (delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const d = new Date(selected);
    d.setMonth(d.getMonth() + delta);
    setSelected(d);
  };

  const pickDay = (d: Date) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelected(d);
  };

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

  const hours = useMemo(
    () => [...Array(LAST_HOUR - FIRST_HOUR + 1)].map((_, i) => FIRST_HOUR + i),
    [],
  );

  /** Day view: entries positioned against the hour rail. */
  const dayEntries = useMemo(
    () =>
      items
        .filter((i) => i.time)
        .map((item, index) => {
          const [h, m] = item.time.split(':').map(Number);
          const startMinutes = Math.max(FIRST_HOUR * 60, (h || 0) * 60 + (m || 0));
          const startMs = new Date(`${item.date}T${item.time}:00`).getTime();
          const endMs = item.endsAt ? new Date(item.endsAt).getTime() : NaN;
          const minutes =
            !Number.isNaN(endMs) && !Number.isNaN(startMs) && endMs > startMs
              ? Math.round((endMs - startMs) / 60000)
              : 60;
          return {
            item,
            index,
            top: ((startMinutes - FIRST_HOUR * 60) / 60) * HOUR_HEIGHT,
            height: Math.max(46, (Math.min(minutes, 240) / 60) * HOUR_HEIGHT - 6),
          };
        }),
    [items],
  );

  const undated = items.filter((i) => !i.time);
  const monthLabel = selected.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });

  return (
    <Screen>
      <GreetingHeader
        name={t('today.hello', { name: name || t('today.friend') })}
        photoUri={PROFILE_PHOTO_URI}
        onBellPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      />

      <Entrance delay={40}>
        <Text style={styles.headline}>{t('tab.calendar')}</Text>
      </Entrance>

      {/* ── Day / Week / Month ── */}
      <Entrance delay={100} from={18}>
      <View style={styles.segment}>
        {(['day', 'week', 'month'] as ViewMode[]).map((m) => {
          const active = mode === m;
          return (
            <Pressable
              key={m}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setMode(m);
              }}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {t(`calendar.view.${m}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      </Entrance>

      {/* ── Month, with arrows ── */}
      <Entrance delay={160} from={18}>
      <View style={styles.monthRow}>
        <Text style={styles.monthLabel}>{monthLabel}</Text>
        <View style={styles.monthArrows}>
          <Pressable
            onPress={() => shiftMonth(-1)}
            style={styles.arrowBtn}
            accessibilityRole="button"
          >
            <ChevronLeft color={colors.text} size={20} />
          </Pressable>
          <Pressable
            onPress={() => shiftMonth(1)}
            style={styles.arrowBtn}
            accessibilityRole="button"
          >
            <ChevronRight color={colors.text} size={20} />
          </Pressable>
        </View>
      </View>
      </Entrance>

      {/* ── The week strip ── */}
      <Entrance delay={220} from={18}>
      <View style={styles.weekRow}>
        {week.map((d) => {
          const str = toDateStr(d);
          const isSelected = str === selectedStr;
          return (
            <Pressable key={str} onPress={() => pickDay(d)} style={styles.weekCell}>
              <Text style={styles.weekName}>
                {d.toLocaleDateString(locale(), { weekday: 'short' })}
              </Text>
              <View style={[styles.weekDay, isSelected && styles.weekDaySelected]}>
                <Text style={[styles.weekDayText, str === todayStr && styles.weekDayToday]}>
                  {d.getDate()}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      </Entrance>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.timeline}>
        {mode === 'day' ? (
          <View style={styles.timelineBody}>
            {/* The hour rail */}
            <View>
              {hours.map((h) => (
                <View key={h} style={styles.hourRow}>
                  <Text style={styles.hourLabel}>
                    {to12h(`${String(h).padStart(2, '0')}:00`).replace(':00', '')}
                  </Text>
                  <View style={styles.hourLine} />
                </View>
              ))}
            </View>

            {/* Entries floating over it */}
            <View style={[styles.entryLayer, gutterSide()]} pointerEvents="box-none">
              {dayEntries.map(({ item, index, top, height }) => {
                const done = statusOf(item) === 'done';
                const Icon = entryIcon(item, done);
                return (
                  <Pressable
                    key={`${item.kind}-${item.id}`}
                    onPress={() => navigation.navigate('EntryForm', { kind: item.kind, id: item.id })}
                    onLongPress={() => confirmDelete(item)}
                    style={[
                      styles.entry,
                      { top, height, backgroundColor: AURA[AURA_CYCLE[index % AURA_CYCLE.length]].tint },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.entryTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.entryTime}>{to12h(item.time)}</Text>
                    </View>
                    <Icon color={colors.text} size={20} strokeWidth={1.8} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : (
          // Week and month are a plain chronological list — the hour rail only
          // makes sense for a single day.
          <View style={styles.list}>
            {items.map((item, index) => {
              const Icon = entryIcon(item, statusOf(item) === 'done');
              return (
                <Pressable
                  key={`${item.kind}-${item.id}`}
                  onPress={() => navigation.navigate('EntryForm', { kind: item.kind, id: item.id })}
                    onLongPress={() => confirmDelete(item)}
                  style={[
                    styles.listRow,
                    { backgroundColor: AURA[AURA_CYCLE[index % AURA_CYCLE.length]].tint },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.entryTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={styles.entryTime}>
                      {new Date(`${item.date}T00:00:00`).toLocaleDateString(locale(), {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                      {item.time ? ` · ${to12h(item.time)}` : ''}
                    </Text>
                  </View>
                  <Icon color={colors.text} size={20} strokeWidth={1.8} />
                </Pressable>
              );
            })}
          </View>
        )}

        {mode === 'day' && undated.length > 0 ? (
          <View style={styles.list}>
            <Text style={styles.sectionLabel}>{t('calendar.section.allDay')}</Text>
            {undated.map((item, index) => (
              <Pressable
                key={`${item.kind}-${item.id}`}
                onPress={() => navigation.navigate('EntryForm', { kind: item.kind, id: item.id })}
                    onLongPress={() => confirmDelete(item)}
                style={[
                  styles.listRow,
                  { backgroundColor: AURA[AURA_CYCLE[index % AURA_CYCLE.length]].tint },
                ]}
              >
                <Text style={[styles.entryTitle, { flex: 1 }]} numberOfLines={1}>
                  {item.title}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {items.length === 0 ? <Text style={styles.empty}>{t('today.noEvents')}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headline: {
    fontSize: 32,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.8,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },

  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 100,
    padding: 5,
    marginBottom: spacing.md,
  },
  segmentItem: { flex: 1, paddingVertical: 11, borderRadius: 100, alignItems: 'center' },
  segmentItemActive: { backgroundColor: AURA.green.tint },
  segmentText: { fontSize: 15, ...font(500), color: colors.textMuted },
  segmentTextActive: { ...font(700), color: colors.text },

  monthRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  monthLabel: { flex: 1, fontSize: 18, ...font(700), color: colors.text },
  monthArrows: { flexDirection: 'row', gap: 4 },
  arrowBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },

  weekRow: { flexDirection: 'row', marginBottom: spacing.sm },
  weekCell: { flex: 1, alignItems: 'center', gap: 6 },
  weekName: { fontSize: 13, ...font(500), color: colors.textMuted },
  weekDay: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  weekDaySelected: { backgroundColor: AURA.green.tint },
  weekDayText: { fontSize: 15, ...font(600), color: colors.text },
  weekDayToday: { ...font(700) },

  timeline: { paddingBottom: spacing.lg },
  timelineBody: { position: 'relative', paddingTop: 4 },
  hourRow: { flexDirection: 'row', alignItems: 'flex-start', height: HOUR_HEIGHT },
  hourLabel: {
    width: GUTTER - 6,
    fontSize: 12,
    ...font(500),
    color: colors.textMuted,
    marginTop: -6,
  },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  // The side is chosen at render — see `gutterSide`.
  entryLayer: { position: 'absolute', top: 4 },
  entry: {
    position: 'absolute',
    insetInlineStart: 0,
    insetInlineEnd: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  entryTitle: { fontSize: 15, ...font(700), color: colors.text },
  entryTime: { fontSize: 13, ...font(500), color: colors.text, opacity: 0.7, marginTop: 2 },

  list: { gap: 10, marginTop: spacing.sm },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  sectionLabel: { fontSize: 13, ...font(600), color: colors.textMuted, marginTop: spacing.sm },
  empty: {
    textAlign: 'center',
    marginTop: spacing.xl,
    fontSize: 15,
    ...font(500),
    color: colors.textMuted,
  },
});
