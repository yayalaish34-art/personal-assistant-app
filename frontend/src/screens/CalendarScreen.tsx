import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  ScrollView,
  View,
  Text,
  StyleSheet,
  Alert,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Users,
  FileText,
  Smile,
  ChartPie,
} from 'lucide-react-native';

import { Screen, GreetingHeader } from '../components/ui';
import {
  Entrance,
  PopIn,
  Pressable,
  animateLayout,
  useFloat,
  useReducedMotion,
} from '../components/motion';
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
import {
  colors,
  spacing,
  font,
  AURA_CYCLE,
  AURA,
  NIGHT,
  TAB_BAR_CLEARANCE,
  themed,
} from '../theme';
import { t, locale, isRTL, ltr } from '../lib/i18n';

// The diary, on the dark: the same greeting as Home, a headline, the view as a
// glass rail of three, the month, the week as a rail of days with the chosen
// one lit blue, and under it the day against its hours — or, for a week or a
// month, the entries as rows.

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PROFILE_PHOTO_URI = 'https://i.pravatar.cc/220?img=47';

type ViewMode = 'day' | 'week' | 'month';
const MODES: ViewMode[] = ['day', 'week', 'month'];

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

/**
 * The side a coloured edge sits on, named physically for the same reason as
 * `gutterSide`: react-native-web turns a logical inset into `left` or `right`
 * from its own idea of direction, which the document's `dir` never reaches, so
 * in Hebrew an edge at the inline start would sit at the row's far end.
 */
function edgeSide(): { left: number } | { right: number } {
  return isRTL() ? { right: 0 } : { left: 0 };
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

/**
 * The chosen cell of a rail: the app's blue, lit from the top, with a soft
 * glow — the same fill as the chosen day on Home. It runs a hair past its cell
 * so it covers the rail's edge.
 *
 * The gradient is rounded itself rather than clipped, because clipping on iOS
 * takes the glow with it. No elevation either: on Android that lifts the fill
 * above the label drawn after it.
 *
 * Only the chosen cell has one, so it mounts as the choice is made — and pops
 * in as it mounts. Choosing is what animates; nothing has to watch for it.
 */
function SelectedFill() {
  return (
    <PopIn style={styles.selected}>
      <LinearGradient
        colors={NIGHT.blue}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFill, styles.selectedGradient]}
      />
    </PopIn>
  );
}

/** How far the month and the week travel in after an arrow, in px. */
const SHIFT_NUDGE = 22;

/**
 * Slides its children in sideways as it mounts, from `from` px off to one side.
 *
 * Keyed by what it shows, it plays each time that changes: after an arrow the
 * month and its week arrive from the side the arrow points, so the diary reads
 * as turning a page rather than swapping one. With `from` at 0 — the page's
 * own build, which `Entrance` already carries — it simply stands there.
 *
 * Physical on purpose: the chevrons are drawn pointing left and right whatever
 * the language, and the travel follows the glyph that was pressed.
 */
function SlideIn({
  from,
  style,
  children,
}: {
  from: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const still = reduce || from === 0;
  const v = useRef(new Animated.Value(still ? 1 : 0)).current;

  useEffect(() => {
    if (still) {
      v.setValue(1);
      return;
    }
    const anim = Animated.spring(v, { toValue: 1, friction: 8, tension: 70, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [still, v]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v.interpolate({ inputRange: [0, 0.5], outputRange: [0, 1], extrapolate: 'clamp' }),
          transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Nothing in the view. The note drifts a few px up and back, slowly, so an
 * empty day reads as calm rather than as something that failed to load. It is
 * the one thing on the page that moves at rest, and it only runs while shown.
 */
function EmptyNote() {
  const float = useFloat(4, 2800);
  return (
    <Animated.View style={[styles.empty, { transform: [{ translateY: float }] }]}>
      <Text style={styles.emptyText}>{t('today.noEvents')}</Text>
    </Animated.View>
  );
}

/**
 * One entry in a list — the week, the month, or the day's untimed tasks. Glass,
 * like the rows on Home, with the coloured edge saying which kind — blue a
 * meeting, green a task — until it is done, when the edge goes and the title
 * greys and strikes through.
 */
function EntryRow({
  item,
  meta,
  onOpen,
  onDelete,
}: {
  item: AgendaItem;
  meta?: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const done = statusOf(item) === 'done';
  const Icon = entryIcon(item, done);
  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      style={({ pressed }) => [styles.row, pressed && styles.pressedDim]}
    >
      {!done ? (
        <View
          style={[
            styles.edge,
            edgeSide(),
            { backgroundColor: item.kind === 'event' ? NIGHT.blue[1] : NIGHT.green },
          ]}
        />
      ) : null}
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, done && styles.titleDone]} numberOfLines={1}>
          {item.title}
        </Text>
        {meta ? (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Icon color={colors.textMuted} size={21} strokeWidth={1.7} />
    </Pressable>
  );
}

export default function CalendarScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Date>(new Date());
  const [mode, setMode] = useState<ViewMode>('day');
  const [items, setItems] = useState<AgendaItem[]>([]);
  /** Which way the last arrow pointed: the side the next month slides in from. */
  const [shiftDir, setShiftDir] = useState<-1 | 0 | 1>(0);

  // Whether the reader has changed the view since the page came into view.
  // While the page builds, the content waits for the header above it; once
  // someone is tapping through days it doesn't, because a day's blocks lagging
  // behind the tap that chose them reads as slow. Leaving the page resets it,
  // so the next build is in reading order again.
  const [quick, setQuick] = useState(false);
  useFocusEffect(useCallback(() => () => setQuick(false), []));

  const selectedStr = toDateStr(selected);
  const todayStr = toDateStr(new Date());
  const week = useMemo(() => weekOf(selected), [selectedStr]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The stretch of the diary on show. Rows are keyed by it, so they build again
   * when it changes — another day, week or month, or another view — and stay
   * put when it doesn't, as when a day is picked inside the week being listed.
   */
  const shown =
    mode === 'day'
      ? selectedStr
      : mode === 'week'
        ? `week-${toDateStr(week[0])}`
        : `month-${selectedStr.slice(0, 7)}`;

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
    setShiftDir(delta > 0 ? 1 : -1);
    setQuick(true);
    setSelected(d);
  };

  const pickDay = (d: Date) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setQuick(true);
    setSelected(d);
  };

  const openItem = (item: AgendaItem) =>
    navigation.navigate('EntryForm', { kind: item.kind, id: item.id });

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
            // Take it out here rather than wait for the reload, so the layout
            // animation is sure to land on this change: the entry fades and
            // what was under it closes the gap. The reload then finds the list
            // already as it should be.
            animateLayout();
            setItems((prev) => prev.filter((r) => !(r.kind === item.kind && r.id === item.id)));
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

  /**
   * When a piece of the content starts in. On a build — the page opening, or
   * coming back — it waits `base` ms for the rails above it; after the reader
   * has changed the view it comes almost straight away. Rows step 45 ms apart
   * and stop stepping after eight, so a full month doesn't keep its end waiting.
   */
  const stagger = (base: number, i: number) => (quick ? 80 : base) + Math.min(i, 8) * 45;
  /** The hour rail comes in at 280; the day's blocks follow it, a list doesn't wait. */
  const contentBase = mode === 'day' ? 340 : 280;

  return (
    <Screen>
      <Entrance delay={0} from={12}>
        <GreetingHeader
          name={t('today.hello', { name: name || t('today.friend') })}
          photoUri={PROFILE_PHOTO_URI}
          onBellPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
        />
      </Entrance>

      <Entrance delay={40}>
        <View style={styles.headlineRow}>
          <Text style={styles.headline}>{t('tab.calendar')}</Text>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.navigate('Stats', { kind: 'calendar' });
            }}
            style={({ pressed }) => [styles.statsBtn, pressed && styles.pressedDim]}
            accessibilityRole="button"
            accessibilityLabel={t('stats.button')}
          >
            <ChartPie color={colors.text} size={19} strokeWidth={1.9} />
          </Pressable>
        </View>
      </Entrance>

      {/* ── Day / Week / Month ── */}
      <Entrance delay={100} from={18}>
        <View style={[styles.rail, styles.segment]}>
          {MODES.map((m, i) => {
            const active = mode === m;
            // The hairlines either side of the lit cell go clear rather than
            // away, so the cells keep their widths.
            const besideActive = active || (i > 0 && MODES[i - 1] === mode);
            return (
              <Fragment key={m}>
                {i > 0 ? (
                  <View style={[styles.railDivider, besideActive && styles.railDividerClear]} />
                ) : null}
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    if (m !== mode) {
                      setQuick(true);
                      // The hour rail and the list are different shapes; let
                      // the page reflow into the new one instead of cutting.
                      // Only on a real change, or the animation would wait
                      // for whatever commits next.
                      animateLayout();
                    }
                    setMode(m);
                  }}
                  style={styles.segmentItem}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  {active ? <SelectedFill /> : null}
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                    {t(`calendar.view.${m}`)}
                  </Text>
                </Pressable>
              </Fragment>
            );
          })}
        </View>
      </Entrance>

      {/* ── Month, with arrows ── */}
      <Entrance delay={160} from={18}>
        <View style={styles.monthRow}>
          {/* Only the name turns with the arrows; the arrows stay under the finger. */}
          <SlideIn key={monthLabel} from={shiftDir * SHIFT_NUDGE} style={styles.monthLabelSlot}>
            <Text style={styles.monthLabel}>{monthLabel}</Text>
          </SlideIn>
          <View style={styles.monthArrows}>
            <Pressable
              onPress={() => shiftMonth(-1)}
              style={({ pressed }) => [styles.arrowBtn, pressed && styles.pressedDim]}
              accessibilityRole="button"
            >
              <ChevronLeft color={colors.text} size={20} strokeWidth={2} style={{ transform: [{ scaleX: isRTL() ? -1 : 1 }] }} />
            </Pressable>
            <Pressable
              onPress={() => shiftMonth(1)}
              style={({ pressed }) => [styles.arrowBtn, pressed && styles.pressedDim]}
              accessibilityRole="button"
            >
              <ChevronRight color={colors.text} size={20} strokeWidth={2} style={{ transform: [{ scaleX: isRTL() ? -1 : 1 }] }} />
            </Pressable>
          </View>
        </View>
      </Entrance>

      {/* ── The week, as a rail of days ── */}
      <Entrance delay={220} from={18}>
        <View style={[styles.rail, styles.weekRail]}>
          {/* The days slide with the month; the glass they sit on stays put.
              Only an arrow changes the week, so this plays on nothing else. */}
          <SlideIn
            key={toDateStr(week[0])}
            from={shiftDir * SHIFT_NUDGE}
            style={[styles.rail, styles.weekRun]}
          >
            {week.map((d, i) => {
              const str = toDateStr(d);
              const isSelected = str === selectedStr;
              const besideSelected =
                isSelected || (i > 0 && toDateStr(week[i - 1]) === selectedStr);
              return (
                <Fragment key={str}>
                  {i > 0 ? (
                    <View
                      style={[styles.railDivider, besideSelected && styles.railDividerClear]}
                    />
                  ) : null}
                  <Pressable
                    onPress={() => pickDay(d)}
                    style={styles.weekCell}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                  >
                    {isSelected ? <SelectedFill /> : null}
                    <Text
                      style={[styles.weekName, isSelected && styles.weekNameOn]}
                      numberOfLines={1}
                    >
                      {d.toLocaleDateString(locale(), { weekday: 'short' })}
                    </Text>
                    <Text
                      style={[
                        styles.weekDayText,
                        str === todayStr && styles.weekDayToday,
                        isSelected && styles.weekDayOn,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </Pressable>
                </Fragment>
              );
            })}
          </SlideIn>
        </View>
      </Entrance>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.timeline}>
        {mode === 'day' ? (
          <View style={styles.timelineBody}>
            {/* The hour rail. It arrives with the view and stays while days
                change over it — the hours are the same hours. */}
            <Entrance delay={quick ? 0 : 280} from={18}>
              {hours.map((h) => (
                <View key={h} style={styles.hourRow}>
                  <Text style={styles.hourLabel}>
                    {ltr(to12h(`${String(h).padStart(2, '0')}:00`).replace(':00', ''))}
                  </Text>
                  <View style={styles.hourLine} />
                </View>
              ))}
            </Entrance>

            {/* Entries floating over it */}
            <View style={[styles.entryLayer, gutterSide()]} pointerEvents="box-none">
              {dayEntries.map(({ item, index, top, height }) => {
                const done = statusOf(item) === 'done';
                const Icon = entryIcon(item, done);
                const aura = AURA[AURA_CYCLE[index % AURA_CYCLE.length]];
                return (
                  <Entrance
                    // Keyed by the day, so another day's blocks rise into their
                    // hours one after another instead of swapping in place.
                    // The block's place is on the wrapper, which is what moves.
                    key={`${shown}-${item.kind}-${item.id}`}
                    delay={stagger(contentBase, index)}
                    from={14}
                    style={[styles.entrySlot, { top, height }]}
                  >
                    <Pressable
                      onPress={() => openItem(item)}
                      onLongPress={() => confirmDelete(item)}
                      style={({ pressed }) => [styles.entry, pressed && styles.pressedDim]}
                    >
                      {/* The hue at a whisper, over the opaque tile. */}
                      <View style={[StyleSheet.absoluteFill, { backgroundColor: aura.tint }]} />
                      {!done ? (
                        <View style={[styles.edge, edgeSide(), { backgroundColor: aura.ink }]} />
                      ) : null}
                      <View style={styles.entryBody}>
                        <Text
                          style={[styles.entryTitle, done && styles.titleDone]}
                          numberOfLines={1}
                        >
                          {item.title}
                        </Text>
                        <Text style={styles.entryTime}>{ltr(to12h(item.time))}</Text>
                      </View>
                      <Icon
                        color={done ? colors.textMuted : aura.ink}
                        size={20}
                        strokeWidth={1.8}
                      />
                    </Pressable>
                  </Entrance>
                );
              })}
            </View>
          </View>
        ) : (
          // Week and month are a plain chronological list — the hour rail only
          // makes sense for a single day.
          <View style={styles.list}>
            {items.map((item, i) => (
              <Entrance
                key={`${shown}-${item.kind}-${item.id}`}
                delay={stagger(contentBase, i)}
                from={16}
              >
                <EntryRow
                  item={item}
                  meta={`${new Date(`${item.date}T00:00:00`).toLocaleDateString(locale(), {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                  })}${item.time ? ` · ${ltr(to12h(item.time))}` : ''}`}
                  onOpen={() => openItem(item)}
                  onDelete={() => confirmDelete(item)}
                />
              </Entrance>
            ))}
          </View>
        )}

        {mode === 'day' && undated.length > 0 ? (
          <View style={styles.list}>
            {/* Carries on the blocks' count, so the page still builds top to
                bottom. The label isn't keyed: it says the same on every day. */}
            <Entrance delay={stagger(contentBase, dayEntries.length)} from={16}>
              <Text style={styles.sectionLabel}>{t('calendar.section.allDay')}</Text>
            </Entrance>
            {undated.map((item, i) => (
              <Entrance
                key={`${shown}-${item.kind}-${item.id}`}
                delay={stagger(contentBase, dayEntries.length + 1 + i)}
                from={16}
              >
                <EntryRow
                  item={item}
                  onOpen={() => openItem(item)}
                  onDelete={() => confirmDelete(item)}
                />
              </Entrance>
            ))}
          </View>
        ) : null}

        {items.length === 0 ? (
          <Entrance key={`empty-${shown}`} delay={stagger(contentBase, 0)} from={16}>
            <EmptyNote />
          </Entrance>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** A glass card: white at a whisper over the page, with a hairline edge. */
const glass = {
  backgroundColor: NIGHT.card,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: NIGHT.line,
} as const;

const styles = themed(() =>
  StyleSheet.create({
    /** A press that reads as a press without moving anything under the finger. */
    pressedDim: { opacity: 0.72 },

    headline: {
      flex: 1,
      fontSize: 36,
      ...font(700),
      color: colors.text,
      letterSpacing: -1,
    },
    headlineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: spacing.md,
      marginBottom: spacing.md,
      gap: 8,
    },
    statsBtn: {
      ...glass,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── The rails: the view, and the week ──
    /** Cells and hairlines in a row; shared by both rails. */
    rail: { flexDirection: 'row', alignItems: 'stretch' },
    railDivider: { width: 1, marginVertical: 11, backgroundColor: NIGHT.line },
    railDividerClear: { backgroundColor: 'transparent' },
    selected: {
      position: 'absolute',
      top: -1,
      bottom: -1,
      left: -1,
      right: -1,
      borderRadius: 12,
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 10,
    },
    selectedGradient: { borderRadius: 12 },

    segment: { ...glass, height: 46, borderRadius: 13, marginBottom: spacing.md + 2 },
    segmentItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    segmentText: { fontSize: 15, ...font(500), color: colors.textMuted },
    segmentTextActive: { ...font(700), color: colors.primaryText },

    monthRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm + 2 },
    /** Takes the row's spare width, so the name can slide inside it. */
    monthLabelSlot: { flex: 1 },
    monthLabel: { fontSize: 21, ...font(700), color: colors.text, letterSpacing: -0.4 },
    monthArrows: { flexDirection: 'row', gap: 8 },
    arrowBtn: {
      ...glass,
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },

    weekRail: { ...glass, height: 50, borderRadius: 13, marginBottom: spacing.sm },
    /** The days inside the glass: the whole rail, as one piece that can slide. */
    weekRun: { flex: 1 },
    weekCell: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 1 },
    weekName: { fontSize: 12.5, ...font(500), color: colors.textMuted },
    weekNameOn: { color: colors.primaryText },
    weekDayText: { fontSize: 19, ...font(600), color: colors.text },
    /** Today, when it isn't the chosen day: the colour of Home's "now" line. */
    weekDayToday: { ...font(700), color: NIGHT.now },
    weekDayOn: { ...font(700), color: colors.primaryText },

    // ── The day against its hours ──
    /** Ends clear of the floating bar: the page runs under it (see `Screen`). */
    timeline: { paddingTop: spacing.sm, paddingBottom: TAB_BAR_CLEARANCE },
    timelineBody: { position: 'relative', paddingTop: 4 },
    hourRow: { flexDirection: 'row', alignItems: 'flex-start', height: HOUR_HEIGHT },
    hourLabel: {
      width: GUTTER - 6,
      fontSize: 12,
      ...font(500),
      color: colors.textMuted,
      marginTop: -6,
    },
    hourLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: NIGHT.line },
    // The side is chosen at render — see `gutterSide`.
    entryLayer: { position: 'absolute', top: 4 },
    /**
     * Where a block sits on the day; its top and height are set at render. The
     * place is on the entrance around the block, so the block rises into it.
     */
    entrySlot: { position: 'absolute', insetInlineStart: 0, insetInlineEnd: 0 },
    /**
     * A block on the day. Opaque underneath, unlike the glass rows: the hour
     * lines run behind it, and through a see-through tile they would cross its
     * title. The tint is laid over it at render.
     */
    entry: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: 13,
      paddingHorizontal: 16,
      paddingVertical: 6,
      overflow: 'hidden',
    },
    entryBody: { flex: 1 },
    entryTitle: { fontSize: 15, ...font(600), color: colors.text },
    entryTime: { fontSize: 13, ...font(500), color: colors.textMuted, marginTop: 1 },

    /** Which kind of thing, or which hue: a lit bar at the start of a row or block. */
    edge: { position: 'absolute', top: 3, bottom: 3, width: 4, borderRadius: 2 },
    titleDone: { textDecorationLine: 'line-through', color: colors.textMuted },

    // ── Lists ──
    list: { gap: 7, marginTop: spacing.sm },
    row: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      minHeight: 60,
      borderRadius: 13,
      paddingVertical: 9,
      paddingHorizontal: 18,
      overflow: 'hidden',
    },
    rowBody: { flex: 1, gap: 2 },
    rowTitle: { fontSize: 16, ...font(600), color: colors.text },
    rowMeta: { fontSize: 14, ...font(500), color: colors.textMuted },
    sectionLabel: {
      fontSize: 21,
      ...font(700),
      color: colors.text,
      letterSpacing: -0.4,
      marginTop: spacing.md,
      marginBottom: 3,
    },

    empty: {
      ...glass,
      borderRadius: 13,
      paddingVertical: spacing.lg,
      alignItems: 'center',
      marginTop: spacing.md,
    },
    emptyText: { fontSize: 15, ...font(600), color: colors.textMuted, textAlign: 'center' },
  }),
);
