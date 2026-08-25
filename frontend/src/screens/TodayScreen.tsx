import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import {
  X,
  Plus,
  CalendarDays,
  ChevronsRight,
  CalendarClock,
  CircleCheckBig,
  Circle,
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
import {
  colors,
  spacing,
  font,
  radius,
  TILES,
  TILE_INK,
  DAY_CARD,
  type TileColor,
} from '../theme';
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

/** "Good morning" / "Good afternoon" / "Good evening", by the clock. */
function greetingNow(): string {
  const h = new Date().getHours();
  if (h < 12) return t('today.greeting.morning');
  if (h < 17) return t('today.greeting.afternoon');
  return t('today.greeting.evening');
}

/**
 * A panel that slides up over the page.
 *
 * Used where tapping a figure should explain it rather than navigate: there is
 * nowhere to go for "how did I get to 75%", and pushing a whole screen for
 * four numbers would be a worse answer than showing the four numbers.
 */
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
      {/* The backdrop closes it. A panel with only one way out is a panel
          people feel trapped by. */}
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

/** One figure in a sheet: what it is on one side, how many on the other. */
function SheetStat({ label, value, tile }: { label: string; value: string; tile: TileColor }) {
  return (
    <View style={[styles.sheetStat, { backgroundColor: TILES[tile] }]}>
      <Text style={[styles.sheetStatLabel, { textAlign: alignStart() }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.sheetStatValue}>{value}</Text>
    </View>
  );
}

export default function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);
  /** Which explaining panel is open, if any. */
  const [sheet, setSheet] = useState<'progress' | 'alerts' | null>(null);

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

  /** The next thing on the clock today, or the first one if the day is over. */
  const upcoming = useMemo(() => {
    const timed = items
      .filter((i) => i.kind === 'event' && i.time)
      .sort((a, b) => a.time.localeCompare(b.time));
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return timed.find((i) => i.time >= nowTime) ?? timed[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Titles arrive in whatever language they were typed in; their labels are
  // always translated. Left to itself each picks its own edge and the pair
  // drifts apart, so both are told which edge the layout is using.
  const start = { textAlign: alignStart() } as const;

  const openAssistant = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate('Assistant');
  };

  const goToTab = (screen: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    (
      navigation as unknown as {
        navigate: (name: string, params: { screen: string }) => void;
      }
    ).navigate('Tabs', { screen });
  };

  const openSheet = (which: 'progress' | 'alerts') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSheet(which);
  };

  /** Everything still ahead on the clock today — what the bell is about. */
  const ahead = useMemo(() => {
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return items
      .filter((i) => i.time && i.time >= nowTime)
      .sort((a, b) => a.time.localeCompare(b.time));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return (
    <Screen>
      <GreetingHeader
        // Greeting by time of day, then the name — "Good morning, Yonatan!"
        name={`${greetingNow()}, ${name || t('today.friend')}!`}
        photoUri={PROFILE_PHOTO_URI}
        onBellPress={() => openSheet('alerts')}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* ── The headline the rest of the page is in service of ── */}
        <View style={styles.headlineBlock}>
          <Text style={[styles.headline, start]}>{t('today.headline.line1')}</Text>
          <Text style={[styles.headline, start]}>{t('today.headline.line2')}</Text>
        </View>

        {/* ── The day, at the size it deserves ──
            The sun or moon is on it from the first frame, off the clock, and
            the provider's daylight flag replaces that guess when the reading
            lands. The temperature appears only if it was actually fetched: a
            dash where a number belongs is worse than no number, so without it
            the card is simply a date. */}
        {(() => {
          const isDay = weather?.isDay ?? isDaylightNow();
          const skin = isDay ? DAY_CARD.day : DAY_CARD.night;
          const Icon = weather ? skyIcon(weather.sky, isDay) : isDay ? Sun : Moon;
          return (
            <LinearGradient
              colors={skin.colors}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.dayCard}
            >
              <View style={styles.dayCardText}>
                <Text style={[styles.dayWeekday, { color: skin.ink }, start]} numberOfLines={1}>
                  {now.toLocaleDateString(locale(), { weekday: 'long' })}
                </Text>
                <Text style={[styles.dayDate, { color: skin.sub }, start]} numberOfLines={1}>
                  {now.toLocaleDateString(locale(), { day: 'numeric', month: 'long' })}
                </Text>
              </View>
              <View style={styles.dayCardSky}>
                <Icon color={skin.glyph} size={40} strokeWidth={1.6} />
                {weather ? (
                  <Text style={[styles.dayTemp, { color: skin.ink }]}>{weather.temperature}°</Text>
                ) : null}
              </View>
            </LinearGradient>
          );
        })()}

        {/* ── Two rows of two: counts up top, texture underneath ── */}
        <View style={styles.grid}>
          <View style={styles.gridRow}>
            <Pressable
              onPress={() => goToTab('Calendar')}
              style={({ pressed }) => [
                styles.gridTile,
                { backgroundColor: TILES.green },
                pressed && styles.tilePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${stats.tasks} ${t('today.tile.tasks')}`}
            >
              <Text style={[styles.gridNumber, start]}>{stats.tasks}</Text>
              <Text style={[styles.gridLabelPrimary, start]} numberOfLines={1}>
                {t('today.tile.tasks')}
              </Text>
              <Text style={[styles.gridLabelSecondary, start]} numberOfLines={1}>
                {t('today.tile.today')}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => goToTab('Calendar')}
              style={({ pressed }) => [
                styles.gridTile,
                { backgroundColor: TILES.blue },
                pressed && styles.tilePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${stats.events} ${t('today.tile.events')}`}
            >
              <View style={styles.gridTileTop}>
                <Text style={[styles.gridNumber, start]}>{stats.events}</Text>
                <CalendarDays color={TILE_INK.blue} size={22} strokeWidth={1.8} />
              </View>
              <Text style={[styles.gridLabelPrimary, start]} numberOfLines={1}>
                {t('today.tile.events')}
              </Text>
              <Text style={[styles.gridLabelSecondary, start]} numberOfLines={1}>
                {t('today.tile.today')}
              </Text>
            </Pressable>
          </View>

          <View style={styles.gridRow}>
            <Pressable
              onPress={() => goToTab('Calendar')}
              style={({ pressed }) => [
                styles.gridTile,
                styles.checklistTile,
                { backgroundColor: TILES.green },
                pressed && styles.tilePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('today.tasks.viewAll')}
            >
              {(['78%', '58%', '42%'] as const).map((w, i) => (
                <View key={i} style={styles.checklistRow}>
                  {i < 2 ? (
                    <CircleCheckBig color={TILE_INK.green} size={18} strokeWidth={2} />
                  ) : (
                    <Circle color={TILE_INK.green} size={18} strokeWidth={2} />
                  )}
                  <View style={[styles.checklistBar, { width: w }]} />
                </View>
              ))}
            </Pressable>

            <Pressable
              onPress={() => openSheet('progress')}
              style={({ pressed }) => [
                styles.gridTile,
                styles.productivityTile,
                { backgroundColor: TILES.neutral },
                pressed && styles.tilePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${stats.productivity}% ${t('today.tile.productivity')}`}
            >
              <View>
                <Text style={[styles.gridNumber, start]}>{stats.productivity}%</Text>
                <Text style={[styles.gridLabelPrimary, start]} numberOfLines={1}>
                  {t('today.tile.productivity')}
                </Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${stats.productivity}%` }]} />
              </View>
            </Pressable>
          </View>
        </View>

        {/* ── The next thing in the diary ── */}
        <Pressable
          onPress={() => goToTab('Calendar')}
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

        {/* ── How much of today is already behind her ──
            Links to Calendar rather than a dedicated task list: today's tasks
            live in that day's agenda alongside its events now that My Tasks
            has become Notes. */}
        <Pressable
          onPress={() => goToTab('Calendar')}
          style={[styles.wideCard, { backgroundColor: TILES.green }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.wideCardKicker, start]}>{t('today.tile.tasks')}</Text>
            <Text style={[styles.wideCardTitle, start]} numberOfLines={1}>
              {t('today.completedDone', { count: stats.done })}
            </Text>
          </View>
          <View style={styles.wideCardIcon}>
            <CircleCheckBig color={TILE_INK.green} size={30} strokeWidth={1.6} />
          </View>
        </Pressable>

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

      {/* ── What the number on the tile is made of ── */}
      <Sheet
        open={sheet === 'progress'}
        title={t('today.progress.title')}
        onClose={() => setSheet(null)}
      >
        <SheetStat
          label={t('today.progress.completed')}
          value={String(stats.done)}
          tile="green"
        />
        <SheetStat
          label={t('today.progress.pending')}
          value={String(Math.max(0, stats.tasks + stats.events - stats.done))}
          tile="yellow"
        />
        <SheetStat
          label={t('today.progress.total')}
          value={String(stats.tasks + stats.events)}
          tile="blue"
        />
        <SheetStat
          label={t('today.tile.productivity')}
          value={`${stats.productivity}%`}
          tile="neutral"
        />
      </Sheet>

      {/* ── What the bell is actually about: everything still ahead today ── */}
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
  tilePressed: { opacity: 0.72 },

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

  content: { paddingTop: spacing.lg, paddingBottom: spacing.md },

  headlineBlock: { marginBottom: spacing.md },
  headline: { fontSize: 30, ...font(700), color: colors.text, letterSpacing: -0.7, lineHeight: 34 },

  dayCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    paddingVertical: 18,
    paddingHorizontal: spacing.md + 2,
    marginBottom: 12,
  },
  dayCardText: { flex: 1 },
  dayWeekday: { fontSize: 22, ...font(700), letterSpacing: -0.5 },
  dayDate: { fontSize: 14, ...font(500), marginTop: 2 },
  dayCardSky: { alignItems: 'center', gap: 2 },
  dayTemp: { fontSize: 22, ...font(700), letterSpacing: -0.5 },

  grid: { gap: 10, marginBottom: 10 },
  gridRow: { flexDirection: 'row', gap: 10 },
  gridTile: { flex: 1, minHeight: 108, borderRadius: radius.md, padding: 14 },
  gridTileTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gridNumber: { fontSize: 30, ...font(700), color: colors.text, letterSpacing: -0.5 },
  gridLabelPrimary: { fontSize: 14, ...font(600), color: colors.text, marginTop: 6 },
  gridLabelSecondary: { fontSize: 13, ...font(500), color: colors.text, opacity: 0.55, marginTop: 1 },

  checklistTile: { justifyContent: 'center', gap: 12 },
  checklistRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checklistBar: { height: 8, borderRadius: 4, backgroundColor: 'rgba(20, 21, 15, 0.16)' },

  productivityTile: { justifyContent: 'space-between' },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(20, 21, 15, 0.10)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: colors.success,
  },

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
