import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import {
  Plus,
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
import { colors, spacing, font, radius, TILES, DAY_CARD } from '../theme';
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

  return (
    <Screen>
      <GreetingHeader
        // Greeting by time of day, then the name — "Good morning, Yonatan!"
        name={`${greetingNow()}, ${name || t('today.friend')}!`}
        photoUri={PROFILE_PHOTO_URI}
        onBellPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* ── The day, at the size it deserves ──
            The one large surface on this screen. The sun or moon is on it from
            the first frame, off the clock, and the provider's daylight flag
            replaces that guess when the reading lands. The temperature appears
            only if it was actually fetched: a dash where a number belongs is
            worse than no number, so without it the card is simply a date. */}
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
                <Icon color={skin.glyph} size={46} strokeWidth={1.6} />
                {weather ? (
                  <Text style={[styles.dayTemp, { color: skin.ink }]}>{weather.temperature}°</Text>
                ) : null}
              </View>
            </LinearGradient>
          );
        })()}

        {/* ── Three numbers, one line ── */}
        <View style={styles.statRow}>
          {[
            { value: String(stats.tasks), label: t('today.tile.tasks'), tile: TILES.green },
            { value: String(stats.events), label: t('today.tile.events'), tile: TILES.blue },
            { value: `${stats.productivity}%`, label: t('today.tile.productivity'), tile: TILES.yellow },
          ].map((s) => (
            <View key={s.label} style={[styles.stat, { backgroundColor: s.tile }]}>
              <Text style={[styles.statNumber, { textAlign: alignStart() }]}>{s.value}</Text>
              <Text style={[styles.statLabel, start]} numberOfLines={1}>
                {s.label}
              </Text>
            </View>
          ))}
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

        {/* The completed count moved into the row above, and the list of
            everything on today came off this screen entirely: it repeated the
            Tasks tab a scroll below the fold, which is where the yellow bar
            had been pushed to. */}

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

  dayCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    paddingVertical: 22,
    paddingHorizontal: spacing.md + 2,
    marginBottom: 12,
  },
  dayCardText: { flex: 1 },
  dayWeekday: { fontSize: 26, ...font(700), letterSpacing: -0.5 },
  dayDate: { fontSize: 15, ...font(500), marginTop: 2 },
  dayCardSky: { alignItems: 'center', gap: 2 },
  dayTemp: { fontSize: 26, ...font(700), letterSpacing: -0.5 },

  statRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  stat: { flex: 1, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 12 },
  statNumber: { fontSize: 26, ...font(700), color: colors.text, letterSpacing: -0.5 },
  statLabel: { fontSize: 12, ...font(500), color: colors.text, opacity: 0.72, marginTop: 1 },

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
