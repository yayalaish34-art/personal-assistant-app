import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  Animated,
  Easing,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';
import {
  X,
  Plus,
  CalendarDays,
  CalendarClock,
  ChevronsRight,
  CircleCheckBig,
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
import {
  colors,
  spacing,
  font,
  radius,
  AURA,
  AURA_CYCLE,
  IRIDESCENT,
  TAB_BAR_CLEARANCE,
  type AuraKey,
} from '../theme';
import { t, locale, alignStart, isRTL } from '../lib/i18n';
import { getWeather, type Weather } from '../lib/weather';

// The home screen: greeting, the completion ring, a strip of day pills, the
// pastel stat tiles, and the day's agenda on a white sheet running to the
// bottom edge. Everything arrives with a staggered spring, and picking a day
// re-springs everything that depends on it — the selection is a performance,
// not a swap.

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PROFILE_PHOTO_URI = 'https://i.pravatar.cc/220?img=47';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** "Good morning" / "Good afternoon" / "Good evening", by the clock. */
function greetingNow(): string {
  const h = new Date().getHours();
  if (h < 12) return t('today.greeting.morning');
  if (h < 17) return t('today.greeting.afternoon');
  return t('today.greeting.evening');
}

// ── The hero ring ───────────────────────────────────────────────────────────

/**
 * The day's completion, as a ring that fills and a number that counts up to
 * meet it. The stroke is a sweep through the three tile inks; the number is
 * ink, because values wear text colour, never series colour.
 */
function HeroRing({ progress, onPress }: { progress: number; onPress: () => void }) {
  const anim = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const id = anim.addListener(({ value }) => setShown(Math.round(value)));
    Animated.timing(anim, {
      toValue: progress,
      duration: 1100,
      easing: Easing.out(Easing.cubic),
      // SVG props can't ride the native driver; the ring is the one JS-driven
      // animation on the screen and it is short-lived.
      useNativeDriver: false,
    }).start();
    return () => anim.removeListener(id);
  }, [progress, anim]);

  const size = 132;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.ringCard, pressed && styles.pressedDim]}
      accessibilityRole="button"
      accessibilityLabel={`${progress}% ${t('today.tile.productivity')}`}
    >
      <Svg width={size} height={size}>
        <Defs>
          {/* The same sweep as the mic button and the chosen day, in the
              deeper inks so it holds up as a 12px stroke. */}
          <SvgGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={AURA.sky.ink} />
            <Stop offset="0.5" stopColor={AURA.lilac.ink} />
            <Stop offset="1" stopColor={AURA.peach.ink} />
          </SvgGradient>
        </Defs>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="rgba(20, 21, 15, 0.08)"
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#ring)"
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={anim.interpolate({ inputRange: [0, 100], outputRange: [c, 0] })}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.ringCenter}>
        <Text style={styles.ringPercent}>{shown}%</Text>
      </View>
    </Pressable>
  );
}

// ── The metrics beside the ring ─────────────────────────────────────────────

/** A number that counts up to its value, and counts again when it changes. */
function useCountUp(target: number, duration = 800): number {
  const anim = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = anim.addListener(({ value }) => setShown(Math.round(value)));
    Animated.timing(anim, {
      toValue: target,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    return () => anim.removeListener(id);
  }, [target, duration, anim]);
  return shown;
}

/**
 * One figure in the hero card: a rule in its accent colour, the number, and
 * the word underneath. No chips, no icons — the rule carries the colour, the
 * type carries the meaning, and the three read as one row of a dashboard.
 */
function Metric({
  value,
  label,
  accent,
  suffix,
}: {
  value: number;
  label: string;
  accent: string;
  suffix?: string;
}) {
  const shown = useCountUp(value);
  return (
    <View style={styles.metric}>
      <View style={[styles.metricRule, { backgroundColor: accent }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.metricValue}>
          {shown}
          {suffix ? <Text style={styles.metricSuffix}>{suffix}</Text> : null}
        </Text>
        <Text style={styles.metricLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </View>
  );
}

// ── The week strip ──────────────────────────────────────────────────────────

function DayPill({
  date,
  selected,
  index,
  onPress,
}: {
  date: Date;
  selected: boolean;
  index: number;
  onPress: () => void;
}) {
  // The strip mirrors itself for RTL (see the ScrollView below), so each pill
  // flips back or its digits would read reversed.
  const mirror = isRTL() ? [{ scaleX: -1 }] : undefined;
  const isToday = toDateStr(date) === toDateStr(new Date());

  // Selection is a spring, not a swap: the holographic fill fades in while the
  // pill lifts and grows, and a ring of the same light blooms outward once.
  const sel = useRef(new Animated.Value(selected ? 1 : 0)).current;
  const bloom = useRef(new Animated.Value(1)).current; // 1 = already spent
  useEffect(() => {
    Animated.spring(sel, {
      toValue: selected ? 1 : 0,
      friction: 6,
      tension: 70,
      useNativeDriver: true,
    }).start();
    if (selected) {
      bloom.setValue(0);
      Animated.timing(bloom, {
        toValue: 1,
        duration: 560,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }
  }, [selected, sel, bloom]);

  return (
    <Entrance delay={220 + index * 45}>
      <Pressable
        onPress={onPress}
        style={{ transform: mirror }}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={date.toLocaleDateString(locale(), {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
      >
        <Animated.View
          style={{
            transform: [
              { translateY: sel.interpolate({ inputRange: [0, 1], outputRange: [0, -7] }) },
              { scale: sel.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
            ],
          }}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              styles.pillBloom,
              {
                opacity: bloom.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
                transform: [
                  { scale: bloom.interpolate({ inputRange: [0, 1], outputRange: [1, 1.65] }) },
                ],
              },
            ]}
          />
          <View style={[styles.pill, selected && styles.pillSelectedEdge]}>
            <Animated.View style={[styles.pillGradient, { opacity: sel }]}>
              <LinearGradient
                colors={IRIDESCENT}
                start={{ x: 0, y: 0 }}
                end={{ x: 0.9, y: 1 }}
                style={{ flex: 1 }}
              />
            </Animated.View>
            <Text style={styles.pillDay}>{date.getDate()}</Text>
            <Text style={[styles.pillWd, selected && styles.pillWdSelected]} numberOfLines={1}>
              {date.toLocaleDateString(locale(), { weekday: 'short' })}
            </Text>
            {isToday && !selected ? <View style={styles.pillDot} /> : null}
          </View>
        </Animated.View>
      </Pressable>
    </Entrance>
  );
}

// ── The Left / Done toggle ──────────────────────────────────────────────────

const THUMB_TRAVEL = 72;

function SegToggle({
  value,
  onChange,
}: {
  value: 'left' | 'done';
  onChange: (v: 'left' | 'done') => void;
}) {
  const anim = useRef(new Animated.Value(value === 'left' ? 0 : 1)).current;
  useEffect(() => {
    Animated.spring(anim, {
      toValue: value === 'left' ? 0 : 1,
      friction: 9,
      tension: 90,
      useNativeDriver: true,
    }).start();
  }, [value, anim]);

  // translateX is physical; in RTL the second option sits to the left, so the
  // thumb travels the other way.
  const dir = isRTL() ? -1 : 1;

  return (
    <View style={styles.toggle}>
      <Animated.View
        style={[
          styles.toggleThumb,
          {
            transform: [
              {
                translateX: anim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, THUMB_TRAVEL * dir],
                }),
              },
            ],
          },
        ]}
      />
      {(['left', 'done'] as const).map((k) => (
        <Pressable
          key={k}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onChange(k);
          }}
          style={styles.toggleHalf}
          accessibilityRole="button"
          accessibilityState={{ selected: value === k }}
        >
          <Text style={[styles.toggleText, value === k && styles.toggleTextActive]}>
            {t(k === 'left' ? 'today.filter.left' : 'today.filter.done')}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── Task rows ───────────────────────────────────────────────────────────────

type RowStatus = { key: 'done' | 'inprogress' | 'overdue' | 'scheduled'; dot: string; pct: number };

/** What the small ring and the status line say about one row. */
function rowStatus(item: AgendaItem, now: Date): RowStatus {
  const s = statusOf(item, now);
  // Sky for settled, lilac for live, grey for not-yet, red for late. Peach is
  // deliberately absent: beside `colors.danger` it is the same mark to a
  // deuteranope (see AURA), and "scheduled" must never read as "overdue".
  if (s === 'done') return { key: 'done', dot: AURA.sky.ink, pct: 100 };
  if (s === 'inprogress') return { key: 'inprogress', dot: AURA.lilac.ink, pct: 55 };
  if (item.date) {
    const due = new Date(`${item.date}T${(item.time || '23:59').padStart(5, '0')}:00`);
    if (!Number.isNaN(due.getTime()) && due < now) {
      return { key: 'overdue', dot: colors.danger, pct: 0 };
    }
  }
  return { key: 'scheduled', dot: colors.textMuted, pct: 0 };
}

/** A row's progress, drawn small: fills on mount, colour from its status. */
function RowRing({ pct, color, delay }: { pct: number; color: string; delay: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: pct,
      duration: 700,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pct, delay, anim]);

  const size = 50;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <View style={styles.rowRing}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="rgba(20, 21, 15, 0.08)"
          strokeWidth={stroke}
          fill="none"
        />
        {pct > 0 ? (
          <AnimatedCircle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${c} ${c}`}
            strokeDashoffset={anim.interpolate({ inputRange: [0, 100], outputRange: [c, 0] })}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>
      <Text style={[styles.rowRingText, { color: pct > 0 ? colors.text : colors.textMuted }]}>
        {pct}%
      </Text>
    </View>
  );
}

// ── Explaining sheets (ring → the numbers, bell → what's still ahead) ───────

function Sheet({
  open,
  title,
  body,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  body?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" />
      <View style={styles.sheet}>
        <View style={styles.sheetGrip} />
        <View style={styles.sheetHead}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sheetTitle, { textAlign: alignStart() }]}>{title}</Text>
            {body ? (
              <Text style={[styles.sheetBody, { textAlign: alignStart() }]}>{body}</Text>
            ) : null}
          </View>
          <Pressable onPress={onClose} style={styles.sheetClose} accessibilityRole="button">
            <X color={colors.text} size={18} strokeWidth={2.4} />
          </Pressable>
        </View>
        {children}
      </View>
    </Modal>
  );
}

function SheetStat({
  label,
  value,
  tile,
}: {
  label: string;
  value: string;
  // The summary row takes 'neutral': it is the total of the three above it,
  // not a fourth category, and giving it a hue of its own would say otherwise.
  tile: AuraKey | 'neutral';
}) {
  return (
    <View
      style={[
        styles.sheetStat,
        { backgroundColor: tile === 'neutral' ? colors.surfaceAlt : AURA[tile].tint },
      ]}
    >
      <Text style={[styles.sheetStatLabel, { textAlign: alignStart() }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.sheetStatValue}>{value}</Text>
    </View>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────

const PILL_W = 56;
const PILL_GAP = 10;
/** Days shown in the strip, and where today sits in them. */
const STRIP_BEFORE = 3;
const STRIP_LENGTH = 10;

export default function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const { width } = useWindowDimensions();
  const [name, setName] = useState('');
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [filter, setFilter] = useState<'left' | 'done'>('left');
  const [sheet, setSheet] = useState<'progress' | 'alerts' | null>(null);

  const today = toDateStr(new Date());
  const [selectedStr, setSelectedStr] = useState(today);

  // First mount builds the page slowly, in order; once it has settled, day
  // changes re-spring the dependent cards with short delays instead.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setBooted(true), 900);
    return () => clearTimeout(timer);
  }, []);

  const week = useMemo(() => {
    const base = new Date();
    return Array.from({ length: STRIP_LENGTH }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i - STRIP_BEFORE);
      return d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const refresh = useCallback(async () => {
    try {
      const { events, tasks } = await api.agendaForDate(selectedStr);
      setItems([...events.map(eventToItem), ...tasks.map(taskToItem)]);
    } catch {
      /* local storage; nothing to retry against */
    }
  }, [selectedStr]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      storage.getSettings().then((s) => {
        if (active) setName(s.displayName);
      });
      void refresh();
      return () => {
        active = false;
      };
    }, [refresh]),
  );

  // Weather is network; fetched once and never waited on.
  useEffect(() => {
    let active = true;
    getWeather().then((w) => {
      if (active && w) setWeather(w);
    });
    return () => {
      active = false;
    };
  }, []);

  // The strip keeps the chosen day in the middle of the rail.
  const stripRef = useRef<ScrollView>(null);
  const centerPill = useCallback(
    (index: number, animated = true) => {
      const viewport = width - (spacing.md + 4) * 2;
      const x = Math.max(0, index * (PILL_W + PILL_GAP) - viewport / 2 + PILL_W / 2);
      stripRef.current?.scrollTo({ x, animated });
    },
    [width],
  );
  useEffect(() => {
    const timer = setTimeout(() => centerPill(STRIP_BEFORE), 500);
    return () => clearTimeout(timer);
  }, [centerPill]);

  const now = new Date();
  const selDate = useMemo(() => new Date(`${selectedStr}T12:00:00`), [selectedStr]);
  const viewingToday = selectedStr === today;

  const stats = useMemo(() => {
    const done = items.filter((i) => statusOf(i, now) === 'done').length;
    const total = items.length;
    return {
      done,
      total,
      pct: total ? Math.round((done / total) * 100) : 0,
      tasks: items.filter((i) => i.kind === 'task').length,
      events: items.filter((i) => i.kind === 'event').length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const visible = useMemo(() => {
    return items
      .filter((i) => (statusOf(i, now) === 'done') === (filter === 'done'))
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter]);

  /** The next thing on the clock for the chosen day. */
  const upcoming = useMemo(() => {
    const timed = items
      .filter((i) => i.kind === 'event' && i.time)
      .sort((a, b) => a.time.localeCompare(b.time));
    if (!viewingToday) return timed[0] ?? null;
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return timed.find((i) => i.time >= nowTime) ?? timed[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, viewingToday]);

  /** What the bell shows: the rest of today, in clock order. */
  const ahead = useMemo(() => {
    if (!viewingToday) return [];
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return items
      .filter((i) => i.time && i.time >= nowTime)
      .sort((a, b) => a.time.localeCompare(b.time));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, viewingToday]);

  const toggleDone = (item: AgendaItem) => {
    if (item.kind !== 'task') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = !item.isDone;
    // Optimistic: the ring fills now, and a failure reloads the truth.
    setItems((prev) =>
      prev.map((r) => (r.kind === 'task' && r.id === item.id ? { ...r, isDone: next } : r)),
    );
    api
      .updateTask(item.id, { isDone: next, updatedAt: new Date().toISOString() })
      .catch(() => void refresh());
  };

  const pickDay = (d: Date, index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedStr(toDateStr(d));
    centerPill(index);
  };

  const openSheet = (which: 'progress' | 'alerts') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSheet(which);
  };

  const openAssistant = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate('Assistant');
  };

  const goToCalendar = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    (
      navigation as unknown as {
        navigate: (name: string, params: { screen: string }) => void;
      }
    ).navigate('Tabs', { screen: 'Calendar' });
  };

  const start = { textAlign: alignStart() } as const;
  const stripMirror = isRTL() ? [{ scaleX: -1 as number }] : undefined;

  const dateChipLabel =
    now.toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) +
    (weather ? ` · ${weather.temperature}°` : '');
  const dayWord = viewingToday
    ? t('calendar.today')
    : selDate.toLocaleDateString(locale(), { weekday: 'long' });

  const rowTile = (index: number) => AURA_CYCLE[index % AURA_CYCLE.length];

  return (
    <Screen clearTabBar={false}>
      <GreetingHeader
        name={`${greetingNow()}, ${name || t('today.friend')}!`}
        photoUri={PROFILE_PHOTO_URI}
        onBellPress={() => openSheet('alerts')}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Entrance delay={40}>
          <Text style={[styles.explore, start]}>{t('today.explore')}</Text>
        </Entrance>

        {/* ── The hero: one card — the ring, and the day's figures beside it ── */}
        <Entrance delay={100} from={26}>
          <View style={styles.heroCard}>
            <View style={styles.heroTop}>
              <Text style={[styles.heroKicker, start]}>{t('today.overview')}</Text>
              <Pressable
                onPress={goToCalendar}
                style={({ pressed }) => [styles.dateChip, pressed && styles.pressedDim]}
                accessibilityRole="button"
              >
                <CalendarDays color={colors.textMuted} size={14} strokeWidth={2.2} />
                <Text style={styles.dateChipText}>{dateChipLabel}</Text>
              </Pressable>
            </View>

            <View style={styles.heroBody}>
              <HeroRing progress={stats.pct} onPress={() => openSheet('progress')} />
              <View style={styles.metricStack}>
                <Metric
                  value={stats.done}
                  label={t('today.progress.completed')}
                  accent={AURA.sky.ink}
                />
                <Metric
                  value={Math.max(0, stats.total - stats.done)}
                  label={t('today.progress.pending')}
                  accent={AURA.lilac.ink}
                />
                <Metric
                  value={stats.events}
                  label={t('today.tile.events')}
                  accent={AURA.peach.ink}
                />
              </View>
            </View>
          </View>
        </Entrance>

        {/* ── The week, one pill a day, the chosen one in the holographic fill ── */}
        <ScrollView
          ref={stripRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          // A horizontal ScrollView doesn't inherit the mirrored direction, so
          // in Hebrew and Arabic the rail is flipped by hand — and every pill
          // flipped back (see DayPill).
          style={[styles.strip, { transform: stripMirror }]}
          contentContainerStyle={styles.stripContent}
        >
          {week.map((d, i) => (
            <DayPill
              key={toDateStr(d)}
              date={d}
              index={i}
              selected={toDateStr(d) === selectedStr}
              onPress={() => pickDay(d, i)}
            />
          ))}
        </ScrollView>

        {/* ── The pastel tiles: how the chosen day is shaped ──
            Keyed on the day, so picking one re-springs them with fresh
            numbers instead of quietly swapping the text. */}
        <Entrance key={`tiles-${selectedStr}`} delay={booted ? 40 : 340} from={18}>
          <View style={styles.gridRow}>
            <Pressable
              onPress={goToCalendar}
              style={({ pressed }) => [
                styles.gridTile,
                { backgroundColor: AURA.sky.tint },
                pressed && styles.pressedDim,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${stats.tasks} ${t('today.tile.tasks')}`}
            >
              <Text style={[styles.gridNumber, start]}>{stats.tasks}</Text>
              <Text style={[styles.gridLabelPrimary, start]} numberOfLines={1}>
                {t('today.tile.tasks')}
              </Text>
              <Text style={[styles.gridLabelSecondary, start]} numberOfLines={1}>
                {dayWord}
              </Text>
            </Pressable>

            <Pressable
              onPress={goToCalendar}
              style={({ pressed }) => [
                styles.gridTile,
                { backgroundColor: AURA.lilac.tint },
                pressed && styles.pressedDim,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${stats.events} ${t('today.tile.events')}`}
            >
              <View style={styles.gridTileTop}>
                <Text style={[styles.gridNumber, start]}>{stats.events}</Text>
                <CalendarDays color={AURA.lilac.ink} size={22} strokeWidth={1.8} />
              </View>
              <Text style={[styles.gridLabelPrimary, start]} numberOfLines={1}>
                {t('today.tile.events')}
              </Text>
              <Text style={[styles.gridLabelSecondary, start]} numberOfLines={1}>
                {dayWord}
              </Text>
            </Pressable>
          </View>
        </Entrance>

        {/* ── The next thing in the diary ── */}
        <Entrance key={`up-${selectedStr}`} delay={booted ? 100 : 400} from={18}>
          <Pressable
            onPress={goToCalendar}
            style={({ pressed }) => [
              styles.wideCard,
              { backgroundColor: AURA.sky.tint },
              pressed && styles.pressedDim,
            ]}
            accessibilityRole="button"
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.wideCardKicker, start]}>{t('today.upcomingEvent')}</Text>
              <Text style={[styles.wideCardTitle, start]} numberOfLines={1}>
                {upcoming ? upcoming.title : t('today.noEvents')}
              </Text>
              <Text style={[styles.wideCardMeta, start]}>
                {upcoming
                  ? `${dayWord}, ${to12h(upcoming.time)}`
                  : selDate.toLocaleDateString(locale(), {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}
              </Text>
            </View>
            <View style={styles.wideCardIcon}>
              <CalendarClock color={colors.text} size={30} strokeWidth={1.6} />
            </View>
          </Pressable>
        </Entrance>

        {/* ── Hand the day to her ── */}
        <Entrance key={`add-${selectedStr}`} delay={booted ? 160 : 460} from={18}>
          <Pressable
            onPress={openAssistant}
            style={({ pressed }) => [
              styles.addBar,
              { backgroundColor: AURA.peach.tint },
              pressed && styles.pressedDim,
            ]}
            accessibilityRole="button"
          >
            <View style={styles.addCircle}>
              <Plus color={colors.text} size={24} strokeWidth={2.4} />
            </View>
            <Text style={styles.addLabel}>{t('today.addNewTask')}</Text>
            <ChevronsRight color={colors.text} size={20} strokeWidth={2} />
          </Pressable>
        </Entrance>

        {/* ── The day itself, on its own sheet ── */}
        <Entrance delay={520} from={40} style={styles.panelWrap}>
          <View style={styles.panel}>
            <View style={styles.panelHead}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.panelTitle, start]}>{t('today.yourTasks')}</Text>
                <Text style={[styles.panelSub, start]}>
                  {t('today.completedOf', { done: stats.done, total: stats.total })}
                </Text>
              </View>
              <SegToggle value={filter} onChange={setFilter} />
            </View>

            {visible.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>{t('today.empty.title')}</Text>
                <Text style={styles.emptyBody}>{t('today.empty.body')}</Text>
              </View>
            ) : (
              visible.map((item, index) => {
                const st = rowStatus(item, now);
                const tile = rowTile(index);
                return (
                  <Entrance
                    // Rows re-stagger when the day or the filter changes: the
                    // key remounts them, and mounting is what animates.
                    key={`${selectedStr}-${filter}-${item.kind}-${item.id}`}
                    delay={80 + index * 60}
                  >
                    <Pressable
                      onPress={() =>
                        navigation.navigate('EntryForm', { kind: item.kind, id: item.id })
                      }
                      style={({ pressed }) => [styles.row, pressed && styles.pressedDim]}
                      accessibilityRole="button"
                    >
                      <Pressable
                        onPress={item.kind === 'task' ? () => toggleDone(item) : undefined}
                        hitSlop={6}
                        accessibilityRole={item.kind === 'task' ? 'checkbox' : 'none'}
                        accessibilityState={
                          item.kind === 'task' ? { checked: Boolean(item.isDone) } : undefined
                        }
                      >
                        <RowRing pct={st.pct} color={st.dot} delay={140 + index * 60} />
                      </Pressable>

                      <View style={{ flex: 1 }}>
                        <Text
                          style={[styles.rowTitle, start, st.key === 'done' && styles.rowTitleDone]}
                          numberOfLines={1}
                        >
                          {item.title}
                        </Text>
                        <View style={styles.rowMeta}>
                          <View style={[styles.statusDot, { backgroundColor: st.dot }]} />
                          <Text
                            style={[
                              styles.rowMetaText,
                              st.key === 'overdue' && { color: colors.danger },
                            ]}
                          >
                            {t(`today.status.${st.key}`)}
                          </Text>
                          {item.time ? (
                            <Text style={styles.rowMetaText}> · {to12h(item.time)}</Text>
                          ) : null}
                        </View>
                      </View>

                      <View style={[styles.rowIcon, { backgroundColor: AURA[tile].tint }]}>
                        {item.kind === 'event' ? (
                          <CalendarDays color={AURA[tile].ink} size={18} strokeWidth={2} />
                        ) : (
                          <CircleCheckBig color={AURA[tile].ink} size={18} strokeWidth={2} />
                        )}
                      </View>
                    </Pressable>
                  </Entrance>
                );
              })
            )}
          </View>
        </Entrance>
      </ScrollView>

      {/* ── What the number on the ring is made of ── */}
      <Sheet
        open={sheet === 'progress'}
        title={t('today.progress.title')}
        onClose={() => setSheet(null)}
      >
        <SheetStat label={t('today.progress.completed')} value={String(stats.done)} tile="sky" />
        <SheetStat
          label={t('today.progress.pending')}
          value={String(Math.max(0, stats.total - stats.done))}
          tile="lilac"
        />
        <SheetStat label={t('today.progress.total')} value={String(stats.total)} tile="peach" />
        <SheetStat label={t('today.tile.productivity')} value={`${stats.pct}%`} tile="neutral" />
      </Sheet>

      {/* ── What the bell is about: everything still ahead today ── */}
      <Sheet
        open={sheet === 'alerts'}
        title={t('profile.notifications')}
        body={t('profile.notificationsBody')}
        onClose={() => setSheet(null)}
      >
        {ahead.length === 0 ? (
          <Text style={[styles.sheetEmpty, start]}>{t('today.noEvents')}</Text>
        ) : (
          ahead.slice(0, 6).map((item) => (
            <Pressable
              key={`${item.kind}-${item.id}`}
              onPress={() => {
                setSheet(null);
                navigation.navigate('EntryForm', { kind: item.kind, id: item.id });
              }}
              style={styles.sheetRow}
              accessibilityRole="button"
            >
              <Text style={styles.sheetRowTime}>{to12h(item.time)}</Text>
              <Text style={[styles.sheetRowTitle, start]} numberOfLines={1}>
                {item.title}
              </Text>
              <ChevronsRight color={colors.textMuted} size={16} strokeWidth={2} />
            </Pressable>
          ))
        )}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  /** A press that reads as a press without moving anything under the finger. */
  pressedDim: { opacity: 0.72 },

  content: { paddingTop: spacing.md, flexGrow: 1 },

  explore: {
    fontSize: 26,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.6,
    marginBottom: spacing.md,
  },

  // ── Hero ──
  heroCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: spacing.md,
  },
  heroKicker: {
    fontSize: 12,
    ...font(700),
    color: colors.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  heroBody: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ringCard: {
    width: 132,
    height: 132,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCenter: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  ringPercent: { fontSize: 28, ...font(700), color: colors.text, letterSpacing: -0.8 },

  metricStack: { flex: 1, gap: 14 },
  metric: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  /** The only colour in the block — a hairline rule, not a filled chip. */
  metricRule: { width: 3, height: 30, borderRadius: 2 },
  metricValue: { fontSize: 21, ...font(700), color: colors.text, letterSpacing: -0.5 },
  metricSuffix: { fontSize: 14, ...font(600), color: colors.textMuted },
  metricLabel: { fontSize: 12.5, ...font(500), color: colors.textMuted, marginTop: 1 },

  dateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 100,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  dateChipText: { fontSize: 12.5, ...font(600), color: colors.textMuted },

  // ── Week strip ──
  strip: { marginTop: spacing.md, flexGrow: 0 },
  stripContent: { alignItems: 'center', gap: PILL_GAP, paddingVertical: 12 },
  pill: {
    width: PILL_W,
    height: 74,
    borderRadius: 25,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillSelectedEdge: { borderColor: 'transparent' },
  pillGradient: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 25,
    overflow: 'hidden',
  },
  pillBloom: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: IRIDESCENT[1],
  },
  pillDay: { fontSize: 18, ...font(700), color: colors.text },
  pillWd: { fontSize: 11.5, ...font(600), color: colors.textMuted },
  pillWdSelected: { color: colors.text },
  pillDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.alert,
    marginTop: 2,
  },

  // ── Pastel tiles ──
  gridRow: { flexDirection: 'row', gap: 10, marginTop: spacing.sm },
  gridTile: { flex: 1, minHeight: 104, borderRadius: radius.md, padding: 14 },
  gridTileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gridNumber: { fontSize: 30, ...font(700), color: colors.text, letterSpacing: -0.5 },
  gridLabelPrimary: { fontSize: 14, ...font(600), color: colors.text, marginTop: 6 },
  gridLabelSecondary: {
    fontSize: 13,
    ...font(500),
    color: colors.text,
    opacity: 0.55,
    marginTop: 1,
  },

  wideCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.lg,
    padding: 14,
    marginTop: 10,
  },
  wideCardKicker: { fontSize: 13, ...font(500), color: colors.text, opacity: 0.7 },
  wideCardTitle: { fontSize: 19, ...font(700), color: colors.text, marginTop: 2 },
  wideCardMeta: { fontSize: 14, ...font(500), color: colors.text, opacity: 0.7, marginTop: 2 },
  wideCardIcon: {
    width: 58,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  addBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 100,
    padding: 10,
    marginTop: 10,
  },
  addCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addLabel: { fontSize: 16, ...font(600), color: colors.text },

  // ── The sheet the day sits on ──
  panelWrap: {
    flexGrow: 1,
    marginTop: spacing.md,
    marginHorizontal: -(spacing.md + 4),
  },
  panel: {
    flex: 1,
    backgroundColor: colors.surface,
    borderTopStartRadius: 30,
    borderTopEndRadius: 30,
    paddingHorizontal: spacing.md + 4,
    paddingTop: spacing.lg,
    paddingBottom: TAB_BAR_CLEARANCE,
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 4,
  },
  panelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: spacing.md,
  },
  panelTitle: { fontSize: 22, ...font(700), color: colors.text, letterSpacing: -0.5 },
  panelSub: { fontSize: 13, ...font(500), color: colors.textMuted, marginTop: 2 },

  toggle: {
    width: THUMB_TRAVEL * 2 + 8,
    height: 40,
    borderRadius: 100,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    padding: 4,
  },
  toggleThumb: {
    position: 'absolute',
    top: 4,
    insetInlineStart: 4,
    width: THUMB_TRAVEL,
    height: 32,
    borderRadius: 100,
    backgroundColor: colors.surface,
  },
  toggleHalf: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toggleText: { fontSize: 13, ...font(600), color: 'rgba(255,255,255,0.75)' },
  toggleTextActive: { color: colors.text },

  // ── Rows ──
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowRing: { width: 50, height: 50, alignItems: 'center', justifyContent: 'center' },
  rowRingText: { fontSize: 11, ...font(700) },
  rowTitle: { fontSize: 16, ...font(700), color: colors.text },
  rowTitleDone: { textDecorationLine: 'line-through', opacity: 0.55 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  rowMetaText: { fontSize: 12.5, ...font(600), color: colors.textMuted },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },

  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: 6 },
  emptyTitle: { fontSize: 17, ...font(700), color: colors.text },
  emptyBody: {
    fontSize: 14,
    ...font(500),
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },

  // ── Sheets ──
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 15, 0.35)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopStartRadius: 28,
    borderTopEndRadius: 28,
    paddingHorizontal: spacing.md + 2,
    paddingTop: 10,
    paddingBottom: spacing.xl + spacing.md,
    gap: spacing.md,
  },
  sheetGrip: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  sheetTitle: { fontSize: 20, ...font(700), color: colors.text, letterSpacing: -0.4 },
  sheetBody: { fontSize: 14, ...font(500), color: colors.text, opacity: 0.62, marginTop: 3 },
  sheetClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sheetStatLabel: { flex: 1, fontSize: 15, ...font(600), color: colors.text },
  sheetStatValue: { fontSize: 22, ...font(700), color: colors.text, letterSpacing: -0.4 },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
  },
  sheetRowTime: {
    minWidth: 62,
    fontSize: 13,
    ...font(700),
    color: colors.text,
  },
  sheetRowTitle: { flex: 1, fontSize: 15, ...font(600), color: colors.text },
  sheetEmpty: {
    fontSize: 15,
    ...font(500),
    color: colors.text,
    opacity: 0.55,
    paddingVertical: spacing.md,
  },
});
