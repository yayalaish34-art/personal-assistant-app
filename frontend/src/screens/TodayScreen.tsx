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
  Check,
  Sun,
  Moon,
  Cloud,
  CloudSun,
  CloudMoon,
  Cloudy,
  CloudFog,
  CloudDrizzle,
  CloudRain,
  CloudSnow,
  CloudLightning,
} from 'lucide-react-native';

import { Screen, GreetingHeader } from '../components/ui';
import { Entrance, useFloat } from '../components/motion';
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
import { getWeather, isDaylightNow, type Sky, type Weather } from '../lib/weather';

/**
 * The glyph for a sky. Clear and near-clear get the sun or the moon, so the
 * card says what time of day it is at a glance; the rest read the same whether
 * it is noon or midnight.
 */
function skyIcon(sky: Sky, isDay: boolean) {
  switch (sky) {
    case 'clear':
      return isDay ? Sun : Moon;
    case 'partly':
      return isDay ? CloudSun : CloudMoon;
    case 'cloud':
      return Cloudy;
    case 'fog':
      return CloudFog;
    case 'drizzle':
      return CloudDrizzle;
    case 'rain':
      return CloudRain;
    case 'snow':
      return CloudSnow;
    case 'storm':
      return CloudLightning;
    default:
      return Cloud;
  }
}

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
  if (s === 'done') return { key: 'done', dot: AURA.green.ink, pct: 100 };
  if (s === 'inprogress') return { key: 'inprogress', dot: AURA.blue.ink, pct: 55 };
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

// ── Weather, at the size it deserves ─────────────────────────────────────────

/**
 * Today's sky: the place, a description, the temperature and the range.
 *
 * This replaced a "· 21°" fragment glued to the date chip, which gave the one
 * thing a bare number can — how warm it is — while omitting everything that
 * makes it useful: where the reading is for, what the sky is doing, and
 * whether the day is going to get colder.
 */
function WeatherCard({ weather, onPress }: { weather: Weather | null; onPress: () => void }) {
  const start = { textAlign: alignStart() } as const;
  const isDay = weather?.isDay ?? isDaylightNow();
  const Icon = weather ? skyIcon(weather.sky, isDay) : isDay ? Sun : Moon;
  const skin = isDay ? AURA.green : AURA.blue;

  // A gentle drift on the glyph, so the card is alive without being busy.
  const float = useFloat(4, 3200, 200);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.weatherCard,
        { backgroundColor: skin.tint },
        pressed && styles.pressedDim,
      ]}
      accessibilityRole="button"
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.weatherPlace, start]} numberOfLines={1}>
          {weather?.place ?? t('today.tile.today')}
        </Text>
        <Text style={[styles.weatherTemp, start]}>
          {weather ? `${weather.temperature}°` : '—'}
        </Text>
        <Text style={[styles.weatherDesc, { color: skin.ink }, start]} numberOfLines={1}>
          {weather ? t(`sky.${weather.sky}`) : ''}
        </Text>
        {weather ? (
          <Text style={[styles.weatherRange, start]} numberOfLines={1}>
            {t('weather.range', { high: weather.high, low: weather.low })}
            {weather.feelsLike !== weather.temperature
              ? `   ${t('weather.feelsLike', { deg: weather.feelsLike })}`
              : ''}
          </Text>
        ) : null}
      </View>
      <Animated.View style={{ transform: [{ translateY: float }] }}>
        <Icon color={skin.ink} size={52} strokeWidth={1.5} />
      </Animated.View>
    </Pressable>
  );
}

// ── Now / next ───────────────────────────────────────────────────────────────

/**
 * The task in hand, with the things that can be done to it from here.
 *
 * Home used to be a place to read numbers and then go elsewhere to act on
 * them. The buttons are the point: ticking off what you are doing right now is
 * the most common thing anyone wants from a home screen, and it was three taps
 * away behind a list.
 */
function FocusTask({
  item,
  onDone,
  onOpen,
  onSnooze,
}: {
  item: AgendaItem;
  onDone: () => void;
  onOpen: () => void;
  onSnooze: () => void;
}) {
  const start = { textAlign: alignStart() } as const;
  const st = rowStatus(item, new Date());

  return (
    <View style={styles.focusCard}>
      <View style={styles.focusHead}>
        <View style={[styles.focusDot, { backgroundColor: st.dot }]} />
        <Text style={styles.focusKicker}>{t('home.now')}</Text>
      </View>

      <Text style={[styles.focusTitle, start]} numberOfLines={2}>
        {item.title}
      </Text>
      <Text style={[styles.focusMeta, start]} numberOfLines={1}>
        {t(`today.status.${st.key}`)}
        {item.time ? ` · ${to12h(item.time)}` : ''}
      </Text>

      <View style={styles.focusActions}>
        <Pressable
          onPress={onDone}
          style={({ pressed }) => [styles.focusPrimary, pressed && styles.pressedDim]}
          accessibilityRole="button"
        >
          <Check color={colors.primaryText} size={17} strokeWidth={3} />
          <Text style={styles.focusPrimaryText}>{t('home.done')}</Text>
        </Pressable>
        <Pressable
          onPress={onSnooze}
          style={({ pressed }) => [styles.focusGhost, pressed && styles.pressedDim]}
          accessibilityRole="button"
        >
          <Text style={styles.focusGhostText}>{t('home.snooze')}</Text>
        </Pressable>
        <Pressable
          onPress={onOpen}
          style={({ pressed }) => [styles.focusGhost, pressed && styles.pressedDim]}
          accessibilityRole="button"
        >
          <Text style={styles.focusGhostText}>{t('home.open')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** One of the two things queued behind the current task. */
function QueuedTask({
  item,
  onDone,
  onOpen,
}: {
  item: AgendaItem;
  onDone: () => void;
  onOpen: () => void;
}) {
  const start = { textAlign: alignStart() } as const;
  const st = rowStatus(item, new Date());

  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [styles.queueRow, pressed && styles.pressedDim]}
      accessibilityRole="button"
    >
      <Pressable
        onPress={onDone}
        hitSlop={8}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: false }}
      >
        <View style={styles.queueCheck}>
          <Check color={colors.textMuted} size={13} strokeWidth={3} />
        </View>
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={[styles.queueTitle, start]} numberOfLines={1}>
          {item.title}
        </Text>
        <View style={styles.queueMetaRow}>
          <View style={[styles.queueDot, { backgroundColor: st.dot }]} />
          <Text style={styles.queueMeta} numberOfLines={1}>
            {item.time ? to12h(item.time) : t(`today.status.${st.key}`)}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** The meeting happening now, with the one after it beneath in miniature. */
function MeetingCard({
  current,
  next,
  onOpen,
}: {
  current: AgendaItem | null;
  next: AgendaItem | null;
  onOpen: (item: AgendaItem) => void;
}) {
  const start = { textAlign: alignStart() } as const;

  return (
    <View style={[styles.meetingCard, { backgroundColor: AURA.green.tint }]}>
      <Pressable
        onPress={() => current && onOpen(current)}
        disabled={!current}
        style={({ pressed }) => [styles.meetingMain, pressed && styles.pressedDim]}
        accessibilityRole="button"
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.meetingKicker, start]}>{t('home.now')}</Text>
          <Text style={[styles.meetingTitle, start]} numberOfLines={1}>
            {current ? current.title : t('home.noMeetings')}
          </Text>
          {current ? (
            <Text style={[styles.meetingTime, start]} numberOfLines={1}>
              {to12h(current.time)}
            </Text>
          ) : null}
        </View>
        <View style={styles.meetingIcon}>
          <CalendarClock color={AURA.green.ink} size={26} strokeWidth={1.8} />
        </View>
      </Pressable>

      {/* The one after it, deliberately smaller — it is context, not the point. */}
      {next ? (
        <Pressable
          onPress={() => onOpen(next)}
          style={({ pressed }) => [styles.meetingNext, pressed && styles.pressedDim]}
          accessibilityRole="button"
        >
          <Text style={styles.meetingNextKicker}>{t('home.next')}</Text>
          <Text style={[styles.meetingNextTitle, start]} numberOfLines={1}>
            {next.title}
          </Text>
          <Text style={styles.meetingNextTime}>{to12h(next.time)}</Text>
        </Pressable>
      ) : null}
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

  /**
   * What to put in front of someone: the thing in hand, then the next two.
   *
   * "In hand" is whatever is happening now if anything is, and otherwise the
   * next thing due — a home screen that leads with a task finished an hour ago
   * is answering a question nobody asked.
   */
  const focus = useMemo(() => {
    const open = items
      .filter((i) => statusOf(i, now) !== 'done')
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    const live = open.find((i) => statusOf(i, now) === 'inprogress');
    const head = live ?? open[0] ?? null;
    const queue = open.filter((i) => i !== head).slice(0, 2);
    return { head, queue };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /** The meeting on now, and the one after it. */
  const meetings = useMemo(() => {
    const timed = items
      .filter((i) => i.kind === 'event' && i.time)
      .sort((a, b) => a.time.localeCompare(b.time));
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes(),
    ).padStart(2, '0')}`;
    const running = timed.find((i) => statusOf(i, now) === 'inprogress') ?? null;
    const ahead = timed.filter((i) => i.time >= nowTime);
    // Viewing another day has no "now", so the first two of that day stand in.
    if (!viewingToday) return { current: timed[0] ?? null, next: timed[1] ?? null };
    const current = running ?? ahead[0] ?? null;
    const next = ahead.find((i) => i !== current) ?? null;
    return { current, next };
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

  /** Push a task to tomorrow without opening it. */
  const snooze = async (item: AgendaItem) => {
    if (item.kind !== 'task') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const when = new Date();
    when.setDate(when.getDate() + 1);
    // Keeps the time of day it already had, so "tomorrow" does not silently
    // become midnight.
    const [hh, mm] = (item.time || '09:00').split(':').map(Number);
    when.setHours(hh || 9, mm || 0, 0, 0);
    setItems((prev) => prev.filter((r) => !(r.kind === 'task' && r.id === item.id)));
    try {
      await api.updateTask(item.id, {
        dueAt: when.toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      void refresh();
    }
  };

  const openItem = (item: AgendaItem) =>
    navigation.navigate('EntryForm', { kind: item.kind, id: item.id });

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

        {/* ── Today's sky ── */}
        <Entrance delay={booted ? 30 : 300} from={18}>
          <WeatherCard weather={weather} onPress={goToCalendar} />
        </Entrance>

        {/* ── The thing in hand, and what is behind it ──
            Keyed on the day so picking one re-springs the whole block rather
            than swapping its text in place. */}
        <Entrance key={`focus-${selectedStr}`} delay={booted ? 70 : 360} from={20}>
          {focus.head ? (
            <>
              <FocusTask
                item={focus.head}
                onDone={() => toggleDone(focus.head!)}
                onOpen={() => openItem(focus.head!)}
                onSnooze={() => snooze(focus.head!)}
              />
              {focus.queue.length > 0 ? (
                <View style={styles.queueCard}>
                  <Text style={[styles.queueKicker, start]}>{t('home.upNext')}</Text>
                  {focus.queue.map((item) => (
                    <QueuedTask
                      key={`${item.kind}-${item.id}`}
                      item={item}
                      onDone={() => toggleDone(item)}
                      onOpen={() => openItem(item)}
                    />
                  ))}
                </View>
              ) : null}
            </>
          ) : (
            <View style={styles.focusCard}>
              <Text style={[styles.focusTitle, start]}>{t('home.allDone')}</Text>
              <Text style={[styles.focusMeta, start]}>{t('home.allDoneBody')}</Text>
            </View>
          )}
        </Entrance>

        {/* ── The meeting on now, with the next one under it ── */}
        <Entrance key={`meet-${selectedStr}`} delay={booted ? 110 : 410} from={18}>
          <MeetingCard current={meetings.current} next={meetings.next} onOpen={openItem} />
        </Entrance>

        {/* ── The pastel tiles: how the chosen day is shaped ── */}
        <Entrance key={`tiles-${selectedStr}`} delay={booted ? 150 : 450} from={18}>
          <View style={styles.gridRow}>
            <Pressable
              onPress={goToCalendar}
              style={({ pressed }) => [
                styles.gridTile,
                { backgroundColor: AURA.green.tint },
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
                { backgroundColor: AURA.blue.tint },
                pressed && styles.pressedDim,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${stats.events} ${t('today.tile.events')}`}
            >
              <View style={styles.gridTileTop}>
                <Text style={[styles.gridNumber, start]}>{stats.events}</Text>
                <CalendarDays color={AURA.blue.ink} size={22} strokeWidth={1.8} />
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

        {/* ── Hand the day to her ── */}
        <Entrance key={`add-${selectedStr}`} delay={booted ? 160 : 460} from={18}>
          <Pressable
            onPress={openAssistant}
            style={({ pressed }) => [
              styles.addBar,
              { backgroundColor: AURA.yellow.tint },
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
        <SheetStat label={t('today.progress.completed')} value={String(stats.done)} tile="green" />
        <SheetStat
          label={t('today.progress.pending')}
          value={String(Math.max(0, stats.total - stats.done))}
          tile="blue"
        />
        <SheetStat label={t('today.progress.total')} value={String(stats.total)} tile="yellow" />
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


  // ── Hero ──

  /** The only colour in the block — a hairline rule, not a filled chip. */


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

  // ── Weather ──
  weatherCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    marginTop: spacing.md,
  },
  weatherPlace: {
    fontSize: 13,
    ...font(600),
    color: colors.text,
    opacity: 0.7,
  },
  weatherTemp: {
    fontSize: 40,
    ...font(700),
    color: colors.text,
    letterSpacing: -1.2,
    marginTop: 2,
  },
  weatherDesc: { fontSize: 14.5, ...font(700), marginTop: 1 },
  weatherRange: {
    fontSize: 12.5,
    ...font(500),
    color: colors.text,
    opacity: 0.6,
    marginTop: 5,
  },

  // ── The thing in hand ──
  focusCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  focusHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  focusDot: { width: 7, height: 7, borderRadius: 3.5 },
  focusKicker: {
    fontSize: 11.5,
    ...font(700),
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  focusTitle: {
    fontSize: 22,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.5,
    lineHeight: 28,
  },
  focusMeta: { fontSize: 13, ...font(600), color: colors.textMuted, marginTop: 4 },
  focusActions: { flexDirection: 'row', gap: 8, marginTop: spacing.md },
  focusPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: colors.primary,
    borderRadius: 100,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  focusPrimaryText: { fontSize: 14, ...font(700), color: colors.primaryText },
  focusGhost: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 100,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  focusGhostText: { fontSize: 14, ...font(600), color: colors.text },

  // ── The two behind it ──
  queueCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginTop: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  queueKicker: {
    fontSize: 11,
    ...font(700),
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 10,
    marginBottom: 2,
  },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10 },
  queueCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.6,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueTitle: { fontSize: 15, ...font(600), color: colors.text },
  queueMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  queueDot: { width: 5, height: 5, borderRadius: 2.5 },
  queueMeta: { fontSize: 12, ...font(500), color: colors.textMuted },

  // ── Meetings ──
  meetingCard: { borderRadius: radius.lg, marginTop: 10, overflow: 'hidden' },
  meetingMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: spacing.md + 2,
  },
  meetingKicker: {
    fontSize: 11.5,
    ...font(700),
    color: colors.text,
    opacity: 0.55,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  meetingTitle: {
    fontSize: 19,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.4,
    marginTop: 3,
  },
  meetingTime: { fontSize: 14, ...font(600), color: colors.text, opacity: 0.7, marginTop: 2 },
  meetingIcon: {
    width: 50,
    height: 50,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Smaller on purpose: the next meeting is context, not the headline. */
  meetingNext: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: 11,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  meetingNextKicker: {
    fontSize: 10.5,
    ...font(700),
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  meetingNextTitle: { flex: 1, fontSize: 14, ...font(600), color: colors.text },
  meetingNextTime: { fontSize: 12.5, ...font(700), color: colors.textMuted },

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
