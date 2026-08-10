import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Svg, { Circle, Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import {
  Plus,
  Check,
  CalendarDays,
  ChevronsRight,
  CalendarClock,
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
import { colors, spacing, font, radius, TILES, TILE_INK, ROW_TILES } from '../theme';
import { t, locale, alignStart } from '../lib/i18n';
import { getWeather, isDaylightNow, type Sky, type Weather } from '../lib/weather';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PROFILE_PHOTO_URI = 'https://i.pravatar.cc/220?img=47';

/**
 * The glyph for a sky. Clear and near-clear skies get the sun or the moon, so
 * the line says what time of day it is even at a glance; the rest read the
 * same whether it is noon or midnight.
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

/**
 * The productivity sparkline: a rising line drawn through the day's completion
 * so far. Points are evenly spaced; only the shape matters at this size.
 */
function Sparkline({ points, width = 118, height = 40 }: { points: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const d = points
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * (height - 8) - 4;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const lastX = (points.length - 1) * step;
  const lastY = height - (points[points.length - 1] / max) * (height - 8) - 4;

  return (
    <Svg width={width} height={height}>
      <Path d={d} stroke={TILE_INK.green} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={lastX} cy={lastY} r={4} fill={TILE_INK.green} />
    </Svg>
  );
}

/** The little checklist drawn inside the Tasks tile. */
function ChecklistMark() {
  return (
    <View style={styles.checklist}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.checklistRow}>
          {i < 2 ? (
            <Check color={colors.text} size={13} strokeWidth={3} />
          ) : (
            <View style={styles.checklistCircle}>
              <Check color={colors.text} size={9} strokeWidth={3} />
            </View>
          )}
          <View style={styles.checklistLine} />
        </View>
      ))}
    </View>
  );
}

/** "Good morning" / "Good afternoon" / "Good evening", by the clock. */
function greetingNow(): string {
  const h = new Date().getHours();
  if (h < 12) return t('today.greeting.morning');
  if (h < 17) return t('today.greeting.afternoon');
  return t('today.greeting.evening');
}

export default function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);

  const today = toDateStr(new Date());

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const settings = await storage.getSettings();
      if (active) setName(settings.displayName);
      try {
        const { events, tasks } = await api.agendaForDate(today);
        if (!active) return;
        setItems([...events.map(eventToItem), ...tasks.map(taskToItem)]);
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    // Fetched apart from the agenda: it comes off the network, and the day's
    // plan must not wait on it or be lost with it.
    (async () => {
      const w = await getWeather();
      if (active && w) setWeather(w);
    })();
    return () => {
      active = false;
    };
  }, [today]);

  useFocusEffect(load);

  const now = new Date();
  const stats = useMemo(() => {
    const tasks = items.filter((i) => i.kind === 'task');
    const events = items.filter((i) => i.kind === 'event');
    const done = items.filter((i) => statusOf(i, now) === 'done').length;
    const total = items.length;
    return {
      tasks: tasks.length,
      events: events.length,
      done,
      productivity: total ? Math.round((done / total) * 100) : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /** Cumulative completions across the day, for the sparkline. */
  const trend = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    for (const i of items) {
      if (statusOf(i, now) !== 'done') continue;
      const h = i.time ? parseInt(i.time.split(':')[0], 10) : 9;
      const idx = Math.min(6, Math.max(0, Math.floor(((Number.isNaN(h) ? 9 : h) - 7) / 2)));
      buckets[idx] += 1;
    }
    let running = 0;
    // A flat line reads as broken, so an empty day still shows a gentle rise.
    const cumulative = buckets.map((b) => (running += b));
    return cumulative.every((v) => v === 0) ? [0, 1, 1, 2, 2, 3, 4] : cumulative;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /** The next thing on the clock today, or the first one if the day is over. */
  const upcoming = useMemo(() => {
    const timed = items
      .filter((i) => i.kind === 'event' && i.time)
      .sort((a, b) => a.time.localeCompare(b.time));
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return timed.find((i) => i.time >= nowTime) ?? timed[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /** Everything on today's plate, timed entries first, in clock order. */
  const plannedToday = useMemo(
    () =>
      [...items].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')),
    [items],
  );

  // Titles arrive in whatever language they were typed in; their labels are
  // always translated. Left to itself each picks its own edge and the pair
  // drifts apart, so both are told which edge the layout is using.
  const start = { textAlign: alignStart() } as const;

  const openAssistant = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate('Assistant');
  };

  return (
    <Screen>
      <GreetingHeader
        // Greeting by time of day, then the name — "Good morning, Yonatan!"
        name={`${greetingNow()}, ${name || t('today.friend')}!`}
        photoUri={PROFILE_PHOTO_URI}
        onBellPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* ── The day itself: date, and the sky over it ──
            The sun or moon shows from the first frame, off the clock, and the
            provider's daylight flag replaces the guess when the reading lands.
            Temperature appears only if it was actually fetched — a dash where
            a number belongs is worse than no number. */}
        <View style={styles.dayStrip}>
          <Text style={[styles.dayDate, start]} numberOfLines={1}>
            {now.toLocaleDateString(locale(), {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </Text>
          <View style={styles.dayWeather}>
            {weather ? (
              <Text style={styles.dayTemp}>{weather.temperature}°</Text>
            ) : null}
            {(() => {
              const isDay = weather?.isDay ?? isDaylightNow();
              const Icon = weather ? skyIcon(weather.sky, isDay) : isDay ? Sun : Moon;
              return <Icon color={colors.text} size={20} strokeWidth={1.9} />;
            })()}
          </View>
        </View>

        <Text style={styles.headline}>
          {t('today.headline.line1')}
          {'\n'}
          {t('today.headline.line2')}
        </Text>

        {/* ── Two columns of tiles ── */}
        <View style={styles.tileRow}>
          <View style={[styles.tile, styles.tileTall, { backgroundColor: TILES.green }]}>
            <Text style={[styles.tileNumber, { textAlign: alignStart() }]}>{stats.tasks}</Text>
            <Text style={styles.tileLabel}>{t('today.tile.tasks')}</Text>
            <Text style={styles.tileLabel}>{t('today.tile.today')}</Text>
            <View style={styles.checklistCard}>
              <ChecklistMark />
            </View>
          </View>

          <View style={styles.tileColumn}>
            <View style={[styles.tile, { backgroundColor: TILES.blue }]}>
              <View style={styles.tileHeadRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.tileNumber, { textAlign: alignStart() }]}>{stats.events}</Text>
                  <Text style={styles.tileLabel}>{t('today.tile.events')}</Text>
                  <Text style={styles.tileLabel}>{t('today.tile.today')}</Text>
                </View>
                {/* The white square is what stops the icon reading as part of
                    the number beside it. */}
                <View style={styles.tileIcon}>
                  <CalendarDays color={colors.text} size={22} strokeWidth={1.8} />
                </View>
              </View>
            </View>

            <View style={[styles.tile, { backgroundColor: TILES.neutral }]}>
              <Text style={[styles.tileNumber, { textAlign: alignStart() }]}>{stats.productivity}%</Text>
              <Text style={styles.tileLabel}>{t('today.tile.productivity')}</Text>
              <View style={styles.sparkWrap}>
                <Sparkline points={trend} />
              </View>
            </View>
          </View>
        </View>

        {/* ── The next thing in the diary ── */}
        <Pressable
          onPress={() =>
            // Jump to the day it sits on rather than to the tab navigator's
            // current state, which would go nowhere.
            (
              navigation as unknown as {
                navigate: (name: string, params: { screen: string }) => void;
              }
            ).navigate('Tabs', { screen: 'Calendar' })
          }
          style={[styles.wideCard, { backgroundColor: TILES.blue }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.wideCardKicker, start]}>{t('today.upcomingEvent')}</Text>
            <Text style={[styles.wideCardTitle, start]} numberOfLines={1}>
              {upcoming ? upcoming.title : t('today.noEvents')}
            </Text>
            <Text style={[styles.wideCardMeta, start]}>
              {upcoming
                ? `${t('calendar.today')}, ${to12h(upcoming.time)}`
                : new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}
            </Text>
          </View>
          <View style={styles.wideCardIcon}>
            <CalendarClock color={colors.text} size={30} strokeWidth={1.6} />
          </View>
        </Pressable>

        {/* ── Completed count ── */}
        <View style={[styles.wideCard, { backgroundColor: TILES.green }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.wideCardTitle, start]}>{t('tab.tasks')}</Text>
            <Text style={[styles.wideCardMeta, start]}>
              {t('today.completedDone', { count: stats.done })}
            </Text>
          </View>
          <View style={styles.checkCircle}>
            <Check color={colors.text} size={22} strokeWidth={2.6} />
          </View>
        </View>

        {/* ── Everything on today, events and tasks together, in time order.
               Tapping one opens it; holding is left to the list screens. ── */}
        {plannedToday.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>{t('today.planned')}</Text>
            {plannedToday.map((item, index) => {
              const done = statusOf(item, now) === 'done';
              return (
                <Pressable
                  key={`${item.kind}-${item.id}`}
                  onPress={() =>
                    navigation.navigate('EntryForm', { kind: item.kind, id: item.id })
                  }
                  style={[
                    styles.planRow,
                    { backgroundColor: TILES[ROW_TILES[index % ROW_TILES.length]] },
                  ]}
                >
                  <View style={styles.planTimeBox}>
                    <Text style={styles.planTime}>
                      {item.time ? to12h(item.time) : t('today.allDay')}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[styles.planTitle, start, done && styles.planTitleDone]}
                      numberOfLines={1}
                    >
                      {item.title}
                    </Text>
                    <Text style={[styles.planKind, start]}>
                      {item.kind === 'event' ? t('today.type.event') : t('today.type.task')}
                    </Text>
                  </View>
                  {done ? <Check color={colors.text} size={18} strokeWidth={2.6} /> : null}
                </Pressable>
              );
            })}
          </>
        ) : null}

        {/* ── The one action on this screen: hand it to her ── */}
        <Pressable
          onPress={openAssistant}
          style={[styles.addBar, { backgroundColor: TILES.yellow }]}
          accessibilityRole="button"
        >
          <View style={styles.addCircle}>
            <Plus color={colors.text} size={24} strokeWidth={2.4} />
          </View>
          <Text style={styles.addLabel}>{t('today.addNewTask')}</Text>
          <ChevronsRight color={colors.text} size={20} strokeWidth={2} />
          <View style={{ flex: 1 }} />
          <View style={styles.addTrailingIcon}>
            <CalendarDays color={colors.text} size={22} strokeWidth={1.8} />
          </View>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.lg, paddingBottom: spacing.md },

  dayStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: spacing.sm,
  },
  dayDate: { flex: 1, fontSize: 14, ...font(600), color: colors.textMuted },
  dayWeather: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dayTemp: { fontSize: 15, ...font(700), color: colors.text },

  headline: {
    fontSize: 34,
    lineHeight: 40,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.8,
    marginBottom: spacing.lg,
  },

  tileRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  tileColumn: { flex: 1, gap: 12 },
  tile: { flex: 1, borderRadius: radius.lg, padding: spacing.md },
  tileTall: { flex: 1 },
  tileHeadRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tileNumber: { fontSize: 32, ...font(700), color: colors.text, letterSpacing: -0.5 },
  tileLabel: { fontSize: 14, ...font(500), color: colors.text, lineHeight: 18 },
  tileIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  checklistCard: {
    // Pinned to the foot of the tile rather than trailing the text, so the
    // column reads as one filled block instead of a label with a gap under it.
    marginTop: 'auto',
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 12,
  },
  checklist: { gap: 7 },
  checklistRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  checklistCircle: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checklistLine: { flex: 1, height: 5, borderRadius: 3, backgroundColor: TILES.green },
  sparkWrap: { marginTop: 4, alignItems: 'flex-end' },

  wideCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: 10,
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
  checkCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  sectionTitle: {
    fontSize: 18,
    ...font(700),
    color: colors.text,
    marginBottom: 10,
    marginTop: spacing.xs,
  },
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  planTimeBox: {
    minWidth: 64,
    backgroundColor: colors.surface,
    borderRadius: 100,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
  },
  planTime: { fontSize: 12, ...font(600), color: colors.text },
  planTitle: { fontSize: 15, ...font(700), color: colors.text },
  planTitleDone: { textDecorationLine: 'line-through', opacity: 0.55 },
  planKind: { fontSize: 12, ...font(500), color: colors.text, opacity: 0.65, marginTop: 1 },

  addBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 100,
    padding: 10,
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
  addTrailingIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
