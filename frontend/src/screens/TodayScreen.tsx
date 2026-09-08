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
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Path, Stop } from 'react-native-svg';
import {
  X,
  CalendarDays,
  CalendarArrowDown,
  CalendarClock,
  ChevronsRight,
  CircleCheckBig,
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
import { statusOf, to12h, toDateStr, eventToItem, taskToItem, type AgendaItem } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import {
  colors,
  spacing,
  font,
  radius,
  AURA,
  AURA_CYCLE,
  IRIDESCENT,
  BAND,
  NIGHT,
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

/** How far the band drifts up while the sheet climbs over it. */
const BAND_PARALLAX = 28;

/**
 * The day's progress, on the dark.
 *
 * Three things happen at once, and they are three because the bar is the only
 * moving thing on the band and has to carry the whole weight of it:
 *
 * The fill grows to its value on a spring rather than appearing at it, so the
 * number above it reads as having been counted rather than looked up.
 *
 * It is the app's own green-blue-yellow sweep, which is what marks the chosen
 * thing everywhere else — the selected day right above it, the mic in the bar
 * below. A flat white fill said "progress"; this says "your progress".
 *
 * And a highlight travels along it, once every few seconds. That is the part
 * that makes it feel alive on a screen where nothing else moves; it rides the
 * native driver and loops forever, so it costs nothing per frame.
 */
function BandProgress({ pct }: { pct: number }) {
  const grow = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    Animated.spring(grow, {
      toValue: pct,
      friction: 9,
      tension: 40,
      delay: 260,
      // Width cannot ride the native driver, and this runs once per change.
      useNativeDriver: false,
    }).start();
  }, [pct, grow]);

  useEffect(() => {
    // A pause between passes, so it reads as a pulse rather than a barber pole.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(1400),
        Animated.timing(sweep, {
          toValue: 1,
          duration: 1300,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(sweep, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  return (
    <View style={styles.bandBar} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View
        style={[
          styles.bandBarFill,
          { width: grow.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) },
        ]}
      >
        <LinearGradient
          colors={IRIDESCENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.bandBarSweep}
        />
        {/* The highlight, travelling the full width of the track rather than
            of the fill — so a day that is barely started still gets one. */}
        {width > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.bandBarShine,
              {
                transform: [
                  {
                    translateX: sweep.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-BAR_SHINE, width],
                    }),
                  },
                ],
              },
            ]}
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

/** How wide the travelling highlight on the progress bar is. */
const BAR_SHINE = 64;

/**
 * Clear air between the band's last line and the sheet's top edge.
 *
 * Shared: the sheet's own top margin, and part of what the dark is drawn to.
 * Two numbers here means a gap of page or a lip of black at the seam.
 */
const SHEET_GAP = spacing.lg;

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
            <Text style={[styles.pillDay, selected && styles.pillDaySelected]}>
              {date.getDate()}
            </Text>
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

// ── Task rows ───────────────────────────────────────────────────────────────




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
function WeatherHero({ weather, onPress }: { weather: Weather | null; onPress: () => void }) {
  const start = { textAlign: alignStart() } as const;
  const isDay = weather?.isDay ?? isDaylightNow();
  const Icon = weather ? skyIcon(weather.sky, isDay) : isDay ? Sun : Moon;

  // A gentle drift on the glyph, so the page is alive without being busy.
  const float = useFloat(4, 3200, 200);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.weatherHero, pressed && styles.pressedDim]}
      accessibilityRole="button"
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.weatherPlace, start]} numberOfLines={1}>
          {weather?.place ?? t('today.tile.today')}
        </Text>
        <Text style={[styles.weatherTemp, start]}>{weather ? `${weather.temperature}°` : '—'}</Text>
        <Text style={[styles.weatherDesc, start]} numberOfLines={1}>
          {weather ? t(`sky.${weather.sky}`) : ''}
        </Text>
        {weather ? (
          <Text style={[styles.weatherRange, start]} numberOfLines={1}>
            {t('weather.range', { high: weather.high, low: weather.low })}
          </Text>
        ) : null}
      </View>
      {/* Full colour, on the dark: the sun is the one warm thing up here, and
          the reference leans on it to keep the page from reading as a slab. */}
      <Animated.View style={{ transform: [{ translateY: float }] }}>
        <Icon color={AURA.blue.tint} size={76} strokeWidth={1.6} />
      </Animated.View>
    </Pressable>
  );
}

/**
 * Hills and trees along the foot of the dark.
 *
 * The reference puts a landscape down there, and it is doing real work: the
 * weather block above it is four lines of type on an empty page, and without
 * something to stand on it floats. Drawn rather than shipped as an image so it
 * takes the page's own colours and costs nothing to load.
 *
 * Two ridges, the far one lighter, with a scatter of conifers on the near one
 * — enough to read as a horizon at a glance and not so much that it competes
 * with the temperature.
 */
function Horizon({ width }: { width: number }) {
  const h = HORIZON_H;
  // A ridge as one long quadratic run, sampled so both ridges share a shape
  // language without being the same curve.
  const ridge = (base: number, amp: number, phase: number) => {
    const pts: string[] = [`M 0 ${h}`, `L 0 ${base}`];
    const step = width / 6;
    for (let i = 0; i <= 6; i++) {
      const x = i * step;
      const y = base - Math.sin(i * 0.9 + phase) * amp;
      pts.push(`${i === 0 ? 'L' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    pts.push(`L ${width} ${h}`, 'Z');
    return pts.join(' ');
  };

  const trees = useMemo(() => {
    const out: { x: number; y: number; s: number }[] = [];
    // Deterministic rather than random: a horizon that reshuffles on every
    // render reads as a glitch.
    const seeds = [0.08, 0.14, 0.19, 0.42, 0.47, 0.63, 0.71, 0.78, 0.9];
    for (const t of seeds) {
      out.push({ x: t * width, y: h * 0.52 + Math.sin(t * 9) * 6, s: 0.7 + (t % 0.3) * 2 });
    }
    return out;
  }, [width, h]);

  return (
    <Svg pointerEvents="none" width={width} height={h} style={styles.horizon}>
      <Path d={ridge(h * 0.46, h * 0.16, 0.6)} fill={NIGHT.card} opacity={0.55} />
      <Path d={ridge(h * 0.62, h * 0.13, 2.4)} fill={NIGHT.card} />
      {trees.map((t, i) => (
        <Path
          key={i}
          d={`M ${t.x} ${t.y} l ${5 * t.s} ${16 * t.s} l ${-10 * t.s} 0 Z`}
          fill={NIGHT.cardAlt}
        />
      ))}
    </Svg>
  );
}

/** How tall the drawn horizon is. */
const HORIZON_H = 130;

/**
 * White carried below the footer's own two lines, for the nav bar to float on.
 *
 * The bar is 64 tall and sits about 22 off the bottom, and its raised mic
 * reaches higher still; this covers all of it with room to spare, so the card
 * and the bar read as one surface rather than two.
 */
const FOOT_UNDER_BAR = 112;

// ── Now / next ───────────────────────────────────────────────────────────────



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
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
      2,
      '0',
    )}`;
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

  /**
   * Opens the diary.
   *
   * The tab navigator's own helpers aren't reachable from a screen inside it
   * without the parent's types; the navigation itself bubbles up fine.
   */
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

  return (
    <Screen clearTabBar={false} dark>
      {/* ── The head: greeting, the week, the day's line ── */}
      <View style={styles.bandContent}>
        <GreetingHeader
          name={`${greetingNow()}, ${name || t('today.friend')}!`}
          photoUri={PROFILE_PHOTO_URI}
          onBellPress={() => openSheet('alerts')}
          onDark
        />

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

        {/* ── The day, in one line, on the dark ── */}
        <Entrance key={`band-${selectedStr}`} delay={booted ? 90 : 250} from={14}>
          <View style={styles.bandLine}>
            <Text style={[styles.bandCount, start]} numberOfLines={1}>
              {t('today.completedOf', { done: stats.done, total: stats.total })}
            </Text>
            <BandProgress pct={stats.pct} />
            <Text style={[styles.bandNext, start]} numberOfLines={1}>
              {meetings.current
                ? `${t('home.now')} · ${meetings.current.title}`
                : focus.head
                  ? `${t('home.next')} · ${focus.head.title}`
                  : t('today.noEvents')}
            </Text>
          </View>
        </Entrance>
      </View>

      {/* ── The sky, and the ground it stands on ──
          No scroll. The reference is one screen: the greeting, the week, the
          weather, a horizon, and a white card across the foot. Everything that
          used to be below the fold — the now tile, the count tile, the day's
          list — is on Calendar, which shows the same tasks and events. */}
      <View style={styles.stage}>
        <Entrance delay={booted ? 30 : 300} from={18}>
          <WeatherHero weather={weather} onPress={goToCalendar} />
        </Entrance>
        <Horizon width={width} />
      </View>

      {/* ── The white card across the foot ──
          Two halves, split by a hairline: what is happening now, and how much
          the day holds. The nav bar floats over its lower half, which is what
          makes the two read as one white footer in the reference. */}
      <Entrance key={`foot-${selectedStr}`} delay={booted ? 90 : 420} from={20}>
        <View style={styles.foot}>
          <Pressable
            onPress={() => (meetings.current ? openItem(meetings.current) : goToCalendar())}
            style={({ pressed }) => [styles.footNow, pressed && styles.pressedDim]}
            accessibilityRole="button"
          >
            <Text style={[styles.footKicker, start]} numberOfLines={1}>
              {t('home.now')}
            </Text>
            <Text style={[styles.footTitle, start]} numberOfLines={2}>
              {meetings.current ? meetings.current.title : t('home.nothingNow')}
            </Text>
          </Pressable>

          <View style={styles.footRule} />

          <Pressable
            onPress={goToCalendar}
            style={({ pressed }) => [styles.footCount, pressed && styles.pressedDim]}
            accessibilityRole="button"
            accessibilityLabel={t('home.tasksToday', { count: stats.tasks })}
          >
            <Text style={[styles.footNum, start]}>{stats.tasks}</Text>
            <Text style={[styles.footLabel, start]} numberOfLines={2}>
              {t('home.tasksToday', { count: stats.tasks })}
            </Text>
          </Pressable>
        </View>
      </Entrance>

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

  content: { flexGrow: 1, paddingHorizontal: spacing.md + 4 },
  /**
   * Transparent, and not clipping.
   *
   * The sheet is translated up over the band, so a scroll view that painted
   * its own background would hide the dark, and one that clipped would cut the
   * sheet off at its own top edge as it rose.
   */
  scroll: {
    backgroundColor: 'transparent',
    // Out to the screen edges. The scroll clips to its own box, so while it
    // sat inside the page's side padding the sheet could not paint the outer
    // 20px — and the band went on showing there as a black stripe down each
    // edge, the full height of the page, once the sheet had risen over it.
    // The padding moves to the content below, so the layout is unchanged.
    marginHorizontal: -(spacing.md + 4),
  },
  /**
   * The dark's content, fixed above the scrolling sheet.
   *
   * Absolute, not in flow. In flow it took its own height out of the page
   * *and* the scroll below it was padded by that same height, so the sheet
   * started twice as far down as the band was deep and rested on 250px of
   * empty black. Out of flow, the padding is the only thing placing the sheet.
   */
  /**
   * The greeting, the week and the day's line.
   *
   * In normal flow. It was absolute while a scrolling sheet slid up over it —
   * out of flow so the sheet could be padded past it and then cover it. There
   * is no scroll now, so out of flow it simply stacked on top of the weather.
   */
  bandContent: {},
  /**
   * The sheet's own white, carried down past the end of its content.
   *
   * `pageSheet` grows with the day's list, and a short day leaves it shorter
   * than the screen — so the page's own colour showed under the last row. This
   * fills the rest, downwards only: upwards is the band's, and a backing that
   * reached up there painted over the greeting and the week.
   */
  /**
   * Holds the drawn seam at the sheet's top edge.
   *
   * Lifted by its own height so the curve sits *above* the sheet's first pixel
   * — the flare has to reach up into the dark, not eat into the white.
   */
  // ── Hero ──

  /** The only colour in the block — a hairline rule, not a filled chip. */

  // ── The column the day is laid out in ──
  pageSheet: {
    flexGrow: 1,
    // Not a sheet any more: the page is dark the whole way down, so there is
    // no white to lay on it and no join to draw.
    backgroundColor: 'transparent',
    // Out to the screen edges: the scroll's content carries the page padding,
    // so this undoes it and puts it back inside itself.
    marginHorizontal: -(spacing.md + 4),
    paddingHorizontal: spacing.md + 4,
    paddingTop: spacing.lg,
    // Room under the day's line, so it sits well inside the dark rather than
    // balanced on the join, and the black reads as a band rather than a margin
    // above the content.
    //
    // Smaller than it was, and the band is no shallower for it: this used to
    // carry the whole depth on its own with nothing in it, and the line under
    // the week now takes up most of what this was holding open. The dark
    // follows the card either way — the band is drawn to its measured top — so
    // this number sets how much empty black is left under the content, not how
    // much black there is.
    marginTop: SHEET_GAP,
    // No negative bottom margin here. Under flexGrow the card is sized to the
    // free space and the margin applied after, so a negative one shrinks its
    // box and lifts the bottom edge off the floor — which is exactly the gap
    // it was meant to close.
    paddingBottom: TAB_BAR_CLEARANCE,
  },

  // ── Week strip ──
  // ── What sits on the dark, under the week ──
  bandLine: { marginTop: spacing.lg, gap: 10 },
  bandCount: { fontSize: 15, ...font(600), color: BAND.ink, opacity: 0.9 },
  /** The day's progress. Thicker than the hairline it replaced: it is the one
      thing on the band that moves, and 4px could not hold a gradient. */
  bandBar: {
    height: 8,
    borderRadius: 4,
    backgroundColor: BAND.line,
    overflow: 'hidden',
  },
  bandBarFill: { height: '100%', borderRadius: 4, overflow: 'hidden' },
  bandBarSweep: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  /** A soft white band that travels the bar. */
  bandBarShine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: BAR_SHINE,
    backgroundColor: 'rgba(255, 255, 255, 0.45)',
  },
  bandNext: { fontSize: 13.5, ...font(500), color: BAND.sub },

  strip: { marginTop: spacing.lg, flexGrow: 0 },
  stripContent: { alignItems: 'center', gap: PILL_GAP, paddingVertical: 12 },
  pill: {
    width: PILL_W,
    height: 74,
    borderRadius: 25,
    // A hole in the band rather than a card on it: filled white, all seven
    // would compete with the one that is actually chosen.
    backgroundColor: BAND.line,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: 1,
    borderColor: BAND.line,
    overflow: 'hidden',
  },
  pillSelectedEdge: { borderColor: 'transparent' },
  pillGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 25,
    overflow: 'hidden',
  },
  pillBloom: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: IRIDESCENT[1],
  },
  pillDay: { fontSize: 18, ...font(700), color: BAND.ink },
  /** Near-black once the gradient is behind it — what every chosen thing does. */
  pillDaySelected: { color: colors.text },
  pillWd: { fontSize: 11.5, ...font(600), color: BAND.sub },
  pillWdSelected: { color: colors.text },
  pillDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: BAND.sub,
    marginTop: 2,
  },

  // ── Weather ──
  /**
   * The day's sky, with the horizon under it.
   *
   * `flex: 1` so the two of them take whatever is left between the week strip
   * and the white foot — the screen has no scroll, so this is what absorbs the
   * difference between a small phone and a large one.
   */
  stage: { flex: 1, justifyContent: 'flex-start' },
  /** Straight onto the dark: no ground, no radius, no padding of its own. */
  weatherHero: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    marginTop: spacing.lg,
  },
  weatherPlace: { fontSize: 19, ...font(700), color: NIGHT.ink },
  weatherTemp: {
    // The one number on the page that carries at arm's length.
    fontSize: 68,
    ...font(700),
    color: NIGHT.ink,
    letterSpacing: -2.5,
    marginTop: 2,
  },
  weatherDesc: { fontSize: 18, ...font(600), color: NIGHT.ink, marginTop: 2 },
  weatherRange: { fontSize: 15, ...font(500), color: NIGHT.sub, marginTop: 6 },
  /** Pinned to the foot of the dark, under everything else on it. */
  horizon: {
    position: 'absolute',
    bottom: 0,
    insetInlineStart: -(spacing.md + 4),
  },

  // ── The white card across the foot ──
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    // Only the top two. The card runs off the bottom of the screen, under the
    // floating nav bar, which is what makes the two read as one white footer.
    borderTopStartRadius: 28,
    borderTopEndRadius: 28,
    // Out to the screen edges, undoing the page's own side padding.
    marginHorizontal: -(spacing.md + 4),
    paddingHorizontal: spacing.md + 4,
    paddingTop: spacing.md + 2,
    // Its own two lines, then room for the nav bar to float over the rest.
    // The page is `clearTabBar={false}`, so nothing else reserves that space
    // and the card has to carry it — as padding, not a negative margin, which
    // pulled the whole card off the bottom of the screen.
    paddingBottom: FOOT_UNDER_BAR,
  },
  footNow: { flex: 1.4, paddingVertical: 2 },
  footKicker: { fontSize: 12, ...font(500), color: colors.textMuted },
  footTitle: {
    fontSize: 16,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.3,
    lineHeight: 21,
    marginTop: 3,
  },
  /** The hairline between the two halves. */
  footRule: { width: 1, alignSelf: 'stretch', backgroundColor: colors.border, marginHorizontal: 14 },
  footCount: { flex: 1, paddingVertical: 2 },
  footNum: { fontSize: 26, ...font(700), color: colors.text, letterSpacing: -0.8 },
  footLabel: { fontSize: 12.5, ...font(500), color: colors.textMuted, marginTop: 1 },

  /**
   * Nothing left to do. Green, because this is the one place on the screen
   * where green means what green means — and a finished day reading as a blank
   * white card looked like a section that had failed to load.
   */
  doneCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    backgroundColor: AURA.green.tint,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    marginTop: spacing.md,
  },
  doneBadge: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** On the green tile, so near-black — not the page's light ink. */
  doneTitle: { fontSize: 18, ...font(700), color: colors.text, letterSpacing: -0.3 },
  doneBody: { fontSize: 13.5, ...font(500), color: colors.text, opacity: 0.7, marginTop: 2 },

  /** Smaller on purpose: the next meeting is context, not the headline. */

  // ── What is on now, beside the day's count ──
  topRow: { flexDirection: 'row', gap: 10, marginTop: spacing.md },
  /** Two squares wide, so the title has room to be a sentence. */
  nowWide: {
    flex: 2,
    minHeight: 112,
    borderRadius: radius.md,
    padding: 14,
    justifyContent: 'space-between',
  },
  nowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nowKicker: {
    fontSize: 11,
    ...font(700),
    color: colors.text,
    opacity: 0.55,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  nowTitle: {
    fontSize: 17,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.3,
    lineHeight: 22,
    marginTop: 6,
  },
  nowMeta: { fontSize: 12.5, ...font(600), color: colors.text, opacity: 0.65, marginTop: 4 },

  countTile: {
    flex: 1,
    minHeight: 112,
    borderRadius: radius.md,
    padding: 14,
    justifyContent: 'center',
  },
  countNum: {
    fontSize: 30,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.6,
    marginTop: 4,
  },
  countLabel: {
    fontSize: 12,
    ...font(600),
    color: colors.text,
    opacity: 0.65,
    marginTop: 1,
  },

  // ── The sheet the day sits on ──
  panelWrap: {
    flexGrow: 1,
    marginTop: spacing.lg,
  },
  /** Now just the last block on the sheet, not a sheet of its own. */
  panel: {
    flex: 1,
    paddingBottom: TAB_BAR_CLEARANCE,
  },
  panelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: spacing.md,
  },
  panelTitle: { fontSize: 22, ...font(700), color: NIGHT.ink, letterSpacing: -0.5 },
  panelSub: { fontSize: 13, ...font(500), color: NIGHT.sub, marginTop: 2 },

  toggle: {
    width: THUMB_TRAVEL * 2 + 8,
    height: 40,
    borderRadius: 100,
    backgroundColor: NIGHT.cardAlt,
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
    overflow: 'hidden',
  },
  toggleThumbFill: { flex: 1 },
  toggleHalf: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toggleText: { fontSize: 13, ...font(600), color: NIGHT.sub },
  /** Ink on the gradient, the same pairing the day pill and the tab disc use. */
  toggleTextActive: { color: colors.text },

  // ── Rows ──
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    marginBottom: 8,
  },
  /** A white disc under the ring, so it reads on the tint behind it. */
  rowRingWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowRing: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  rowRingText: { fontSize: 10, ...font(700) },
  rowTitle: { fontSize: 16, ...font(700), color: colors.text },
  rowTitleDone: { textDecorationLine: 'line-through', opacity: 0.55 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  rowMetaText: { fontSize: 12.5, ...font(600), color: colors.textMuted },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── The header's progress bar ──
  progressTrack: {
    height: 8,
    borderRadius: 4,
    // The unfilled half, on the dark page. Near-white here would read as a
    // full bar with a gradient on one end rather than an empty one.
    backgroundColor: NIGHT.cardAlt,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  progressFillWrap: { height: '100%' },
  progressFill: { flex: 1, borderRadius: 4 },

  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: 6 },
  emptyTitle: { fontSize: 17, ...font(700), color: NIGHT.ink },
  emptyBody: {
    fontSize: 14,
    ...font(500),
    color: NIGHT.sub,
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
