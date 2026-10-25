import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, Modal, useWindowDimensions } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import {
  X,
  BookOpen,
  Briefcase,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Dumbbell,
  Footprints,
  ListTodo,
  Phone,
  ShoppingCart,
  Utensils,
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
  CheckCircle2,
} from 'lucide-react-native';

import { Screen, GreetingHeader, SweepText } from '../components/ui';
import { Entrance, Pressable, PopIn, CountUp, animateLayout } from '../components/motion';
import { api } from '../lib/api';
import { storage } from '../lib/storage';
import { statusOf, to12h, toDateStr, eventToItem, taskToItem, type AgendaItem } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, AURA, AURA_CYCLE, IRIDESCENT, NIGHT, themed } from '../theme';
import { t, locale, alignStart, isRTL, ltr } from '../lib/i18n';
import { getWeather, isDaylightNow, type Sky, type Weather, type HourForecast } from '../lib/weather';

// The home screen: the greeting, the week's weather in one bounded rail, the
// headline, how far today has got, the few things worth doing next, and a pale
// card across the foot that the nav bar sits on.
//
// Everything here is bounded — the weather, the progress, each card, the foot —
// because the page before this one laid a day rail, a timeline, three counts
// and a list of rows straight onto the dark, and read as a wall. The day it
// shows is today; other days are Calendar's job.

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Icon = typeof ListTodo;

const PROFILE_PHOTO_URI = 'https://i.pravatar.cc/220?img=47';

/** The side padding `Screen` gives every page, which the scroll undoes. */
const SCREEN_PAD = spacing.md + 4;

/**
 * Home's own side padding, a step tighter than the other pages: the rails and
 * cards run nearly to the edges. The greeting and the headline sit
 * `TEXT_INSET` further in, as they do in the reference.
 */
const GUTTER = spacing.md;
const TEXT_INSET = 4;

/** Days in the weather rail: today and the six after it. */
const WEEK = 7;

/** Cards under "Suggested next". Three fit a row without crowding it. */
const SUGGESTED = 3;

/** Pips in the progress card. Past this a day's dots are too thin to read. */
const MAX_PIPS = 8;

/**
 * The glyph for a sky. Clear and near-clear get the sun or the moon, so the
 * rail says what time of day it is at a glance; the rest read the same whether
 * it is noon or midnight.
 */
function skyIcon(sky: Sky, isDay: boolean): Icon {
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

/** A temperature, kept "28°" rather than "°28" in Hebrew (see `ltr`). */
const deg = (n: number) => ltr(`${n}°`);

const weekdayShort = (d: Date) => d.toLocaleDateString(locale(), { weekday: 'short' });

/**
 * The mark on a suggested card.
 *
 * A meeting is always the calendar. A task gets a guess from its title — a
 * walk has a shoe, a book has a book — and falls back to a plain to-do glyph
 * when nothing matches. English words match whole; Hebrew ones are listed as
 * they are typed.
 */
const ROW_ICONS: [RegExp, Icon][] = [
  [/\b(walk|run|jog|hike)|הליכה|ריצה|לרוץ|ללכת/i, Footprints],
  [/\b(read|book)|לקרוא|ספר|קריאה/i, BookOpen],
  [/\b(gym|workout|exercise|training)|כושר|אימון/i, Dumbbell],
  [/\b(call|phone)|להתקשר|שיחה|טלפון/i, Phone],
  [/\b(buy|shop|grocer)|קניות|לקנות|סופר/i, ShoppingCart],
  [/\b(breakfast|lunch|dinner|cook|eat)|ארוחה|לבשל|לאכול/i, Utensils],
  [/\b(work|client|project|report|presentation)|עבודה|לקוח|פרויקט|דוח|מצגת/i, Briefcase],
];

function rowIcon(item: AgendaItem): Icon {
  if (item.kind === 'event') return CalendarDays;
  return ROW_ICONS.find(([re]) => re.test(item.title))?.[1] ?? ListTodo;
}

/**
 * The colours a sky is actually made of.
 *
 * Both surfaces — the open square and the closed rail — take the sky's own
 * light now. The square uses the full gradient (`day` / `night`), so a clear
 * noon opens as sun-yellow and a rainy afternoon as drowned blue. The rail
 * uses `tint` and `edge`, a whisper of the same hue over the page's dark, so
 * a glance across the closed rail already says what the weather is doing.
 * `ink` is the type colour for the open square: the gold and the snow need
 * dark ink; everything else takes white.
 *
 * Clear day was tweaked to a straight sun-yellow (the reader said "sunny is
 * yellow, for example") rather than the sunset gold-into-orange it used to be.
 */
const SKY_PAINT: Record<
  Sky,
  {
    day: readonly string[];
    night: readonly string[];
    /** A soft wash for the closed rail, over the page's dark. */
    tint: string;
    /** A hairline in the same hue, so the rail's edge picks up the weather too. */
    edge: string;
  }
> = {
  clear: {
    day: ['#FFE066', '#FFC93C', '#F5A623'],
    night: ['#1B2A6B', '#101B47', '#0A1030'],
    // Bright sun-yellow that reads at a glance — much stronger than a
    // whisper. On the dark page it says "sunny" before a number is read.
    tint: 'rgba(255, 210, 77, 0.42)',
    edge: 'rgba(255, 210, 77, 0.7)',
  },
  partly: {
    day: ['#7FC4FF', '#3E86E0', '#2B5FB5'],
    night: ['#2B3A7A', '#1A2450', '#101735'],
    tint: 'rgba(77, 166, 255, 0.36)',
    edge: 'rgba(77, 166, 255, 0.62)',
  },
  cloud: {
    day: ['#9AA9BD', '#6B7B92', '#4B5A70'],
    night: ['#3A465C', '#28313F', '#1A212C'],
    tint: 'rgba(154, 169, 189, 0.36)',
    edge: 'rgba(154, 169, 189, 0.58)',
  },
  fog: {
    day: ['#C3C9D1', '#98A2AE', '#737C88'],
    night: ['#454E5C', '#333A45', '#22272F'],
    tint: 'rgba(195, 201, 209, 0.32)',
    edge: 'rgba(195, 201, 209, 0.55)',
  },
  drizzle: {
    day: ['#7FB6C9', '#4C8AA8', '#356981'],
    night: ['#26485C', '#1B3444', '#12232E'],
    tint: 'rgba(76, 138, 168, 0.38)',
    edge: 'rgba(76, 138, 168, 0.62)',
  },
  rain: {
    day: ['#5C8FC4', '#3A6395', '#26456C'],
    night: ['#1E3A5C', '#152840', '#0D1927'],
    tint: 'rgba(58, 99, 149, 0.44)',
    edge: 'rgba(58, 99, 149, 0.70)',
  },
  snow: {
    day: ['#EAF2FA', '#C6D8EC', '#A3BDD9'],
    night: ['#5A6B85', '#3E4B60', '#2A3342'],
    tint: 'rgba(234, 242, 250, 0.32)',
    edge: 'rgba(234, 242, 250, 0.55)',
  },
  storm: {
    day: ['#6E5FA8', '#4B3E7D', '#332A57'],
    night: ['#2E2550', '#1F1938', '#141024'],
    tint: 'rgba(110, 95, 168, 0.42)',
    edge: 'rgba(110, 95, 168, 0.68)',
  },
};

/** Which skies want dark type on them. Everything else takes white. */
const DARK_INK: Sky[] = ['clear', 'snow', 'fog'];

function skyPaint(sky: Sky, isDay: boolean) {
  const colours = isDay ? SKY_PAINT[sky].day : SKY_PAINT[sky].night;
  const dark = isDay && DARK_INK.includes(sky);
  return {
    colours,
    ink: dark ? '#20160A' : '#FFFFFF',
    sub: dark ? 'rgba(32,22,10,0.72)' : 'rgba(255,255,255,0.78)',
    line: dark ? 'rgba(32,22,10,0.16)' : 'rgba(255,255,255,0.22)',
  };
}

// ── The weather rail — hourly (default) or daily ────────────────────────────

/** Format an hour from an ISO time string: "14:00" → "2 PM" or "14". */
function hourLabel(isoTime: string, index: number): string {
  if (index === 0) return t('today.weather.now');
  const hour = parseInt(isoTime.slice(11, 13), 10);
  const h12 = hour % 12 || 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h12}${ampm}`;
}

function HourlyRail({ weather }: { weather: Weather }) {
  const hours = weather.hours;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.hourlyContent}
    >
      {hours.map((h, i) => {
        const isNow = i === 0;
        const Glyph = skyIcon(h.sky, h.isDay);
        return (
          <Fragment key={h.time}>
            {i > 0 ? (
              <View style={[styles.railDivider, isNow && styles.railDividerClear]} />
            ) : null}
            <View style={[styles.hourCell]}>
              {isNow ? (
                <PopIn style={styles.railLit} from={0.7}>
                  <LinearGradient
                    colors={IRIDESCENT}
                    start={{ x: 0.1, y: 0 }}
                    end={{ x: 0.9, y: 1 }}
                    style={[StyleSheet.absoluteFill, styles.railLitFill]}
                  />
                </PopIn>
              ) : null}
              <Text style={[styles.railDay, isNow && styles.railInk]} numberOfLines={1}>
                {hourLabel(h.time, i)}
              </Text>
              <Glyph
                color={isNow ? NIGHT.glyph : h.sky === 'clear' && h.isDay ? NIGHT.sun : NIGHT.ink}
                size={17}
                strokeWidth={2}
              />
              <Text style={[styles.railTemp, isNow && styles.railInk]} numberOfLines={1}>
                {deg(h.temperature)}
              </Text>
            </View>
          </Fragment>
        );
      })}
    </ScrollView>
  );
}

function DailyRail({ weather, days }: { weather: Weather | null; days: Date[] }) {
  const byDate = new Map((weather?.days ?? []).map((d) => [d.date, d]));
  const todayStr = toDateStr(new Date());

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.hourlyContent}
    >
      {days.map((d, i) => {
        const key = toDateStr(d);
        const isToday = key === todayStr;
        const day = byDate.get(key);
        const sky = isToday && weather ? weather.sky : day?.sky;
        const isDay = isToday ? (weather?.isDay ?? isDaylightNow()) : true;
        const temp = isToday && weather ? weather.temperature : day?.high;
        const Glyph = sky ? skyIcon(sky, isDay) : null;

        return (
          <Fragment key={key}>
            {i > 0 ? (
              <View
                style={[
                  styles.railDivider,
                  (isToday || toDateStr(days[i - 1]) === todayStr) && styles.railDividerClear,
                ]}
              />
            ) : null}
            <View style={styles.hourCell}>
              {isToday ? (
                <PopIn style={styles.railLit} from={0.7}>
                  <LinearGradient
                    colors={IRIDESCENT}
                    start={{ x: 0.1, y: 0 }}
                    end={{ x: 0.9, y: 1 }}
                    style={[StyleSheet.absoluteFill, styles.railLitFill]}
                  />
                </PopIn>
              ) : null}
              <Text style={[styles.railDay, isToday && styles.railInk]} numberOfLines={1}>
                {weekdayShort(d)}
              </Text>
              {Glyph ? (
                <Glyph
                  color={isToday ? NIGHT.glyph : sky === 'clear' && isDay ? NIGHT.sun : NIGHT.ink}
                  size={17}
                  strokeWidth={2}
                />
              ) : (
                <View style={styles.railGlyphGap} />
              )}
              <Text style={[styles.railTemp, isToday && styles.railInk]} numberOfLines={1}>
                {temp !== undefined ? deg(temp) : '—'}
              </Text>
            </View>
          </Fragment>
        );
      })}
    </ScrollView>
  );
}

/**
 * Two pills side by side — hours or days — with a lit fill under the chosen
 * one. Sitting inside the rail, which is itself pressable to open the square,
 * so the buttons stop the outer tap from opening the square when the reader
 * just wanted to switch views.
 */
function ForecastToggle({
  mode,
  onPick,
}: {
  mode: 'hours' | 'days';
  onPick: (m: 'hours' | 'days') => void;
}) {
  const pill = (m: 'hours' | 'days', label: string) => {
    const active = mode === m;
    return (
      <Pressable
        onPress={() => {
          if (m === mode) return;
          Haptics.selectionAsync();
          onPick(m);
        }}
        // The parent rail opens the square on tap; this one handles both the
        // press and the "does the parent see it" question, so switching views
        // does not also open the square.
        onPressIn={() => {}}
        hitSlop={6}
        style={[styles.togglePill, active && styles.togglePillActive]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
      >
        {active ? (
          <LinearGradient
            colors={NIGHT.blue}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={[StyleSheet.absoluteFill, styles.togglePillFill]}
          />
        ) : null}
        <Text style={[styles.togglePillText, active && styles.togglePillTextOn]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleTrack}>
        {pill('hours', t('today.weather.hours'))}
        {pill('days', t('today.weather.days'))}
      </View>
    </View>
  );
}

function ForecastRail({
  weather,
  days,
  mode,
  onPick,
}: {
  weather: Weather | null;
  days: Date[];
  mode: 'hours' | 'days';
  onPick: (m: 'hours' | 'days') => void;
}) {
  // A subtle wash of the current sky over the dark glass, so a glance already
  // says the weather even before the row of numbers is read — warm yellow on
  // a sunny afternoon, cool blue in the rain. Only when the sky is known:
  // before that the rail sits in its plain glass.
  const tint = weather ? SKY_PAINT[weather.sky] : null;
  const railStyle = tint
    ? [styles.rail, { backgroundColor: tint.tint, borderColor: tint.edge }]
    : styles.rail;
  return (
    <View style={railStyle}>
      <ForecastToggle mode={mode} onPick={onPick} />
      {mode === 'hours' && weather?.hours?.length ? (
        <HourlyRail weather={weather} />
      ) : (
        <DailyRail weather={weather} days={days} />
      )}
    </View>
  );
}

/**
 * The weather, opened out: one square in the colours of the sky it describes.
 *
 * The rail answers "how warm, what day". This answers "what is it like out",
 * and it answers it in paint before a word is read — the card is gold at noon,
 * indigo at night, slate under cloud, drowned blue in rain. Square because it
 * is a thing you open rather than a line you scan, and it holds today in full
 * with the rest of the week along the bottom.
 */
function WeatherSquare({
  weather,
  days,
  mode,
  onPick,
  onClose,
}: {
  weather: Weather;
  days: Date[];
  mode: 'hours' | 'days';
  onPick: (m: 'hours' | 'days') => void;
  onClose: () => void;
}) {
  const paint = skyPaint(weather.sky, weather.isDay);
  const Glyph = skyIcon(weather.sky, weather.isDay);
  const byDate = new Map(weather.days.map((d) => [d.date, d]));
  const todayStr = toDateStr(new Date());
  const start = { textAlign: alignStart() } as const;
  const showHours = mode === 'hours' && weather.hours.length > 0;

  return (
    <Pressable
      onPress={onClose}
      style={styles.square}
      accessibilityRole="button"
      accessibilityLabel={`${t(`sky.${weather.sky}`)} · ${deg(weather.temperature)}`}
      accessibilityHint={t('today.weather.collapse')}
    >
      <LinearGradient
        colors={paint.colours as [string, string, ...string[]]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={[StyleSheet.absoluteFill, styles.squareFill]}
      />

      {/* Where, and what it is doing there. */}
      <View style={styles.squareTop}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.squarePlace, start, { color: paint.sub }]} numberOfLines={1}>
            {weather.place ?? t('today.weather.here')}
          </Text>
          <Text style={[styles.squareSky, start, { color: paint.ink }]} numberOfLines={1}>
            {t(`sky.${weather.sky}`)}
          </Text>
        </View>
        <Glyph color={paint.ink} size={40} strokeWidth={1.6} />
      </View>

      {/* The number the card exists for. */}
      <View style={styles.squareMid}>
        <Text style={[styles.squareTemp, start, { color: paint.ink }]} numberOfLines={1}>
          {deg(weather.temperature)}
        </Text>
        <Text style={[styles.squareFeels, start, { color: paint.sub }]} numberOfLines={1}>
          {t('today.weather.feels', { temp: deg(weather.feelsLike) })} ·{' '}
          {ltr(`${deg(weather.high)} / ${deg(weather.low)}`)}
        </Text>
      </View>

      {/* The strip along the foot: the hours the day is running to (default),
          or the week ahead. The toggle above it lets the reader pick, in the
          same paint the closed rail uses. */}
      <View style={[styles.squareFoot, { borderTopColor: paint.line }]}>
        <ForecastToggle mode={mode} onPick={onPick} />
        {showHours ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.squareHourList}
          >
            {weather.hours.map((h, i) => {
              const isNow = i === 0;
              const HourGlyph = skyIcon(h.sky, h.isDay);
              return (
                <View key={h.time} style={styles.squareHour}>
                  <Text
                    style={[styles.squareDayName, { color: isNow ? paint.ink : paint.sub }]}
                    numberOfLines={1}
                  >
                    {hourLabel(h.time, i)}
                  </Text>
                  <HourGlyph color={isNow ? paint.ink : paint.sub} size={14} strokeWidth={2} />
                  <Text
                    style={[styles.squareDayTemp, { color: isNow ? paint.ink : paint.sub }]}
                    numberOfLines={1}
                  >
                    {deg(h.temperature)}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        ) : (
          <View style={styles.squareWeek}>
            {days.slice(0, WEEK).map((d) => {
              const key = toDateStr(d);
              const day = byDate.get(key);
              const isToday = key === todayStr;
              const DayGlyph = day ? skyIcon(day.sky, true) : null;
              return (
                <View key={key} style={styles.squareDay}>
                  <Text
                    style={[styles.squareDayName, { color: isToday ? paint.ink : paint.sub }]}
                    numberOfLines={1}
                  >
                    {weekdayShort(d)}
                  </Text>
                  {DayGlyph ? (
                    <DayGlyph color={isToday ? paint.ink : paint.sub} size={14} strokeWidth={2} />
                  ) : (
                    <View style={styles.railGlyphGap} />
                  )}
                  <Text
                    style={[styles.squareDayTemp, { color: isToday ? paint.ink : paint.sub }]}
                    numberOfLines={1}
                  >
                    {day ? deg(isToday ? weather.temperature : day.high) : '—'}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </Pressable>
  );
}

// ── The headline ───────────────────────────────────────────────────────────

/** The app's name in each script — the sweep applies to whichever appears. */
const BRANDS = ['Planzi'] as const;

function findBrand(line: string): number {
  for (const b of BRANDS) {
    const at = line.indexOf(b);
    if (at !== -1) return at;
  }
  return -1;
}

function Headline({ text, size }: { text: string; size: number }) {
  const type = [styles.headlineText, { fontSize: size, lineHeight: Math.round(size * 1.04) }];
  const dir = isRTL() ? 'rtl' as const : 'ltr' as const;
  return (
    <View>
      {text.split('\n').map((line, i) => {
        const at = findBrand(line);
        if (at === -1) {
          return (
            <Text key={i} style={[type, { textAlign: alignStart(), writingDirection: dir }]}>
              {line}
            </Text>
          );
        }
        const words = line.slice(0, at).trim();
        return (
          <View key={i} style={[styles.headlineLine, { columnGap: Math.round(size * 0.24), direction: dir }]}>
            {words ? <Text style={type}>{words}</Text> : null}
            <SweepText style={type}>{line.slice(at)}</SweepText>
          </View>
        );
      })}
    </View>
  );
}

// ── How far today has got ──────────────────────────────────────────────────

/**
 * One pip's colour by its place in the row: the sweep, blue through green to
 * yellow, so a day fills in the colours every lit thing in the app uses.
 */
function pipColour(index: number, count: number): string {
  const share = count <= 1 ? 0 : index / (count - 1);
  if (share < 0.34) return IRIDESCENT[1];
  if (share < 0.67) return IRIDESCENT[0];
  return IRIDESCENT[2];
}

/**
 * The day as a count, a row of pips and a percentage.
 *
 * This is what replaced the timeline and the three counts: one card that says
 * the only thing the top of the page has to say — how much of today is behind
 * you. A day with nothing on it says so rather than drawing an empty bar.
 */
function ProgressCard({ done, total }: { done: number; total: number }) {
  const start = { textAlign: alignStart() } as const;
  const pips = Math.min(Math.max(total, 1), MAX_PIPS);
  // Pips stand for the day, not for single items, once there are more items
  // than pips: five of nine done lights four of eight.
  const lit = total === 0 ? 0 : Math.round((done / total) * pips);
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <View style={styles.progress}>
      <View style={styles.progressHead}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.progressTitle, start]} numberOfLines={1}>
            {t('home.progress')}
          </Text>
          <Text style={[styles.progressSub, start]} numberOfLines={1}>
            {total === 0 ? t('today.noEvents') : t('home.progressOf', { done, total })}
          </Text>
        </View>
        <CountUp
          value={percent}
          format={(n) => ltr(`${Math.round(n)}%`)}
          style={styles.progressPct}
        />
      </View>
      <View style={styles.pips}>
        {Array.from({ length: pips }, (_, i) => (
          <View
            key={i}
            style={[styles.pip, i < lit ? { backgroundColor: pipColour(i, pips) } : null]}
          />
        ))}
      </View>
    </View>
  );
}

// ── What to do next ────────────────────────────────────────────────────────

/**
 * One thing worth starting, as a card: its mark, what it is, and when.
 *
 * Three of these replaced the day's list of rows. A row is a list you read; a
 * card is a thing you pick, which is what this part of the page is for.
 */
function SuggestedCard({
  item,
  tone,
  when,
  onOpen,
}: {
  item: AgendaItem;
  tone: (typeof AURA_CYCLE)[number];
  when: string;
  onOpen: () => void;
}) {
  const start = { textAlign: alignStart() } as const;
  const Mark = rowIcon(item);
  const Chevron = isRTL() ? ChevronLeft : ChevronRight;

  return (
    <Pressable
      onPress={onOpen}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}${when ? `, ${when}` : ''}`}
    >
      <Mark color={AURA[tone].ink} size={22} strokeWidth={2} />
      <Text style={[styles.cardTitle, start]} numberOfLines={2}>
        {item.title}
      </Text>
      <View style={styles.cardFoot}>
        <Text style={[styles.cardWhen, start]} numberOfLines={1}>
          {when}
        </Text>
        <Chevron color={colors.textMuted} size={15} strokeWidth={2.2} />
      </View>
    </Pressable>
  );
}

/** How far the foot's arc rises from its sides to its middle. */
const FOOT_RISE = 30;

/**
 * How much of the foot the floating nav bar covers, above the home-indicator
 * inset: its 10pt float gap, its 64pt height, and the mic's lift above it with
 * some air. Mirrors the bar's own geometry in navigation/index.tsx.
 */
const NAV_BAR_COVER = 10 + 64 + 40;

/**
 * The foot's pale ground, with its whole top edge drawn as one arc.
 *
 * The seam between the dark and the pale is a curve across the full width —
 * high in the middle, falling away to the sides — not a flat edge with two
 * rounded corners. A corner radius cannot draw that: it bends the ends and
 * leaves the long middle straight, which on a phone reads as a straight line.
 * So the shape is a path.
 *
 * One cubic from side to side, its control points straight above the two
 * ends: the curve leaves each side vertically, so it rolls out of the side
 * edges with no corner, and it is flat at the very top, `rise` above the ends.
 *
 * Sized from the container's measured box, so it fills the `foot` View
 * exactly, including the height `flexGrow` adds on a short day. Nothing to
 * draw before that first measurement, so it renders nothing for one frame.
 */
function FootShape({ width, height, rise }: { width: number; height: number; rise: number }) {
  if (width <= 0 || height <= 0) return null;
  // Control points 4/3 of the rise above the ends put the midpoint of the
  // curve exactly at the top of the box.
  const lift = rise - (rise * 4) / 3;
  const arc = `C 0 ${lift} ${width} ${lift} ${width} ${rise}`;
  const fill = `M 0 ${height} L 0 ${rise} ${arc} L ${width} ${height} Z`;
  // The arc alone, as a hairline along the seam.
  const rim = `M 0 ${rise} ${arc}`;

  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Path d={fill} fill={NIGHT.foot} />
      <Path d={rim} fill="none" stroke={NIGHT.line} strokeWidth={1} />
    </Svg>
  );
}

// ── The bell's sheet ────────────────────────────────────────────────────────

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
      <View style={[styles.sheet, { direction: isRTL() ? 'rtl' : 'ltr' }]}>
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

// ── The screen ──────────────────────────────────────────────────────────────

export default function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [name, setName] = useState('');
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [weather, setWeather] = useState<Weather | null>(null);
  /** Whether the weather is open as its own square. Closed is the day's default. */
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [forecastMode, setForecastMode] = useState<'hours' | 'days'>('hours');
  const [alertsOpen, setAlertsOpen] = useState(false);
  /** The foot's own measured box, so its drawn shape always exactly fills it. */
  const [footSize, setFootSize] = useState({ width: 0, height: 0 });

  // A meeting ticks itself over when it ends, so the clock is state rather
  // than a value read once per render.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const today = toDateStr(now);

  const days = useMemo(() => {
    const base = new Date(`${today}T00:00:00`);
    return Array.from({ length: WEEK }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d;
    });
  }, [today]);

  const refresh = useCallback(async () => {
    try {
      const { events, tasks } = await api.agendaForDate(today);
      setItems([...events.map(eventToItem), ...tasks.map(taskToItem)]);
    } catch {
      /* local storage; nothing to retry against */
    }
  }, [today]);

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

  const done = useMemo(() => items.filter((i) => statusOf(i, now) === 'done').length, [items, now]);
  const taskCount = useMemo(() => items.filter((i) => i.kind === 'task').length, [items]);

  /** The next few open things, in clock order. */
  const suggested = useMemo(
    () =>
      items
        .filter((i) => statusOf(i, now) !== 'done')
        .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))
        .slice(0, SUGGESTED),
    [items, now],
  );

  /** What is on right now, for the foot. */
  const current = useMemo(
    () => items.find((i) => statusOf(i, now) === 'inprogress') ?? null,
    [items, now],
  );

  /** What the bell shows: the rest of today, in clock order. */
  const ahead = useMemo(() => {
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return items
      .filter((i) => i.time && i.time >= nowTime)
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [items, now]);

  const openItem = (item: AgendaItem) =>
    navigation.navigate('EntryForm', { kind: item.kind, id: item.id });

  const endMeeting = async () => {
    if (!current || current.kind !== 'event') return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await api.endEvent(current.id);
    await refresh();
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
  const SeeAllChevron = isRTL() ? ChevronLeft : ChevronRight;

  // Sized to the phone: the second line is the longest, and it has to fit on
  // one line of the column at every width the app runs at. The line under it
  // is half the size, which is the proportion the reference sets it at.
  const column = width - (GUTTER + TEXT_INSET) * 2;
  const headlineSize = Math.min(40, Math.round(column / 9.6));

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        <Entrance delay={0} from={12}>
          <GreetingHeader
            name={`${greetingNow()}, ${name || t('today.friend')}`}
            photoUri={PROFILE_PHOTO_URI}
            onBellPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setAlertsOpen(true);
            }}
            style={styles.header}
          />
        </Entrance>

        {/* The rail is the glance; the square is the look. One tap between
            them, and the square arrives in the colours of the sky itself. */}
        <Entrance delay={70} from={14}>
          {weatherOpen && weather ? (
            <WeatherSquare
              weather={weather}
              days={days}
              mode={forecastMode}
              onPick={setForecastMode}
              onClose={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                animateLayout();
                setWeatherOpen(false);
              }}
            />
          ) : (
            <Pressable
              onPress={() => {
                if (!weather) return;
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                animateLayout();
                setWeatherOpen(true);
              }}
              // Nothing to open until the provider has answered.
              disabled={!weather}
              pressScale={0.99}
              accessibilityRole="button"
              accessibilityLabel={t('today.weather.expand')}
            >
              <ForecastRail
                weather={weather}
                days={days}
                mode={forecastMode}
                onPick={setForecastMode}
              />
            </Pressable>
          )}
        </Entrance>

        <Entrance delay={140} from={16}>
          <View style={styles.headline}>
            <Headline text={t('home.headline')} size={headlineSize} />
            <Text style={[styles.headlineSub, start, { fontSize: Math.round(headlineSize / 2) }]}>
              {t('home.headlineSub')}
            </Text>
          </View>
        </Entrance>

        <Entrance delay={210} from={16}>
          <ProgressCard done={done} total={items.length} />
        </Entrance>

        <Entrance delay={270} from={16}>
          <View style={styles.listHead}>
            <Text style={[styles.listTitle, start]} numberOfLines={1}>
              {t('home.suggested')}
            </Text>
            <Pressable
              onPress={goToCalendar}
              hitSlop={10}
              style={styles.seeAll}
              accessibilityRole="button"
              accessibilityLabel={t('home.seeAll')}
            >
              <SeeAllChevron color={colors.textMuted} size={18} strokeWidth={2.2} />
            </Pressable>
          </View>
        </Entrance>

        {suggested.length === 0 ? (
          <Entrance delay={320} from={16}>
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{t('home.nothingSuggested')}</Text>
            </View>
          </Entrance>
        ) : (
          <View style={styles.cards}>
            {suggested.map((item, index) => (
              <Entrance
                key={`${item.kind}-${item.id}`}
                delay={320 + index * 60}
                from={16}
                style={styles.cardSlot}
              >
                <SuggestedCard
                  item={item}
                  tone={AURA_CYCLE[index % AURA_CYCLE.length]}
                  when={item.time ? ltr(to12h(item.time)) : t('tasks.noDue')}
                  onOpen={() => openItem(item)}
                />
              </Entrance>
            ))}
          </View>
        )}

        {/* ── The foot ──
            Pale and bounded, its top corners rounded like every other card on
            the page — and, unlike them, part of the scroll: it rises with the
            rest of the page instead of sitting fixed above it. The nav bar
            still floats on it, so the two read as one footer. */}
        <View
          // Everything under the two lines belongs to the nav bar. On a phone
          // with a home indicator the bar sits higher than the fixed 96pt this
          // used to allow, and it covered the text.
          style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 12) + NAV_BAR_COVER }]}
          onLayout={(e) =>
            setFootSize({
              width: e.nativeEvent.layout.width,
              height: e.nativeEvent.layout.height,
            })
          }
        >
          <FootShape width={footSize.width} height={footSize.height} rise={FOOT_RISE} />
          {/* The handle at the top of the arc, as a sheet has. */}
          <View style={styles.footGrip} pointerEvents="none" />

          <Pressable
            onPress={() => (current ? openItem(current) : goToCalendar())}
            style={styles.footNow}
            accessibilityRole="button"
          >
            <Text style={[styles.footKicker, start]} numberOfLines={1}>
              {t('home.now')}
            </Text>
            <Text style={[styles.footTitle, start]} numberOfLines={2}>
              {current ? current.title : t('home.nothingNow')}
            </Text>
          </Pressable>
          {current?.kind === 'event' && (
            <Pressable
              onPress={endMeeting}
              style={styles.footEnd}
              accessibilityRole="button"
              accessibilityLabel={t('home.endMeeting')}
            >
              <CheckCircle2 color={NIGHT.green} size={20} strokeWidth={2} />
              <Text style={styles.footEndLabel}>{t('home.endMeeting')}</Text>
            </Pressable>
          )}

          <View style={styles.footRule} />

          <Pressable
            onPress={goToCalendar}
            style={styles.footCount}
            accessibilityRole="button"
            accessibilityLabel={t('home.tasksToday', { count: taskCount })}
          >
            <CountUp value={taskCount} style={[styles.footNum, start]} />
            <Text style={[styles.footLabel, start]} numberOfLines={2}>
              {t('home.tasksToday', { count: taskCount })}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* ── What the bell is about: everything still ahead today ── */}
      <Sheet
        open={alertsOpen}
        title={t('profile.notifications')}
        body={t('profile.notificationsBody')}
        onClose={() => setAlertsOpen(false)}
      >
        {ahead.length === 0 ? (
          <Text style={[styles.sheetEmpty, start]}>{t('today.noEvents')}</Text>
        ) : (
          ahead.slice(0, 6).map((item, index) => (
            <Entrance key={`${item.kind}-${item.id}`} delay={120 + index * 50} from={14}>
              <Pressable
                onPress={() => {
                  setAlertsOpen(false);
                  openItem(item);
                }}
                style={styles.sheetRow}
                accessibilityRole="button"
              >
                <Text style={styles.sheetRowTime}>{ltr(to12h(item.time))}</Text>
                <Text style={[styles.sheetRowTitle, start]} numberOfLines={1}>
                  {item.title}
                </Text>
                <ChevronsRight color={colors.textMuted} size={16} strokeWidth={2} />
              </Pressable>
            </Entrance>
          ))
        )}
      </Sheet>
    </Screen>
  );
}

/**
 * A glass card: a whisper over the page, with a hairline edge.
 *
 * The colours are getters, read each time the object is spread: a sheet built
 * for the other scheme has to pick up the glass in force, not the one this
 * module saw when it was imported.
 */
const glass = {
  get backgroundColor() {
    return NIGHT.card;
  },
  borderWidth: StyleSheet.hairlineWidth,
  get borderColor() {
    return NIGHT.line;
  },
};

const styles = themed(() =>
  StyleSheet.create({
    /**
     * Out to the screen edges.
     *
     * The scroll clips to its own box, so inside the page's padding it would
     * cut the cards off short of each edge. It undoes the page's padding and
     * carries Home's own, tighter one inside.
     */
    // `flex: 1` so the scroll fills the page, and `flexGrow: 1` on its
    // content so a short day's content still stretches to the bottom —
    // which is what lets the foot below grow to meet the screen's edge
    // instead of leaving dark page showing under it.
    scroll: { flex: 1, marginHorizontal: -SCREEN_PAD },
    scrollContent: { flexGrow: 1, paddingHorizontal: GUTTER },

    /** The greeting sits in from the rails, as the headline does. */
    header: { paddingHorizontal: TEXT_INSET },

    // ── The weather, bounded ──
    rail: {
      ...glass,
      borderRadius: 18,
      marginTop: spacing.md,
      overflow: 'hidden',
    },
    railToggleRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      paddingTop: 6,
      paddingBottom: 2,
    },
    railToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 2,
    },
    railToggleText: {
      fontSize: 11.5,
      ...font(600),
      color: NIGHT.sub,
    },
    railToggleActive: {
      color: NIGHT.ink,
    },
    railToggleDot: {
      fontSize: 11,
      color: NIGHT.sub,
    },

    /**
     * The two-way toggle between the hourly and daily views: a track holding
     * two pills, the chosen one lit with the app's blue. Sits at the top of
     * the rail, and (for the open square) at the foot of its heading — one
     * control the reader knows from wherever they see it.
     */
    toggleRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      paddingTop: 8,
      paddingBottom: 4,
    },
    toggleTrack: {
      flexDirection: 'row',
      backgroundColor: NIGHT.cardAlt,
      borderRadius: 999,
      padding: 3,
      gap: 2,
    },
    togglePill: {
      minWidth: 62,
      paddingHorizontal: 14,
      paddingVertical: 5,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    togglePillActive: {},
    togglePillFill: { borderRadius: 999 },
    togglePillText: {
      fontSize: 12,
      ...font(700),
      color: NIGHT.sub,
    },
    togglePillTextOn: { color: colors.primaryText },
    hourlyContent: { flexDirection: 'row', alignItems: 'stretch', paddingHorizontal: 4, paddingBottom: 4 },
    hourCell: { width: 52, alignItems: 'center', justifyContent: 'center', gap: 5, height: 74 },
    railCell: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5 },
    /** The lit day, inset inside the rail's own padding. */
    railLit: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      borderRadius: 14,
      overflow: 'hidden',
    },
    railLitFill: { borderRadius: 14 },
    railDivider: { width: 1, marginVertical: 14, backgroundColor: NIGHT.line },
    railDividerClear: { backgroundColor: 'transparent' },
    railDay: { fontSize: 12.5, ...font(600), color: NIGHT.sub },
    railTemp: { fontSize: 15, ...font(700), color: NIGHT.ink },
    /** Holds a cell's height steady while its reading is still on its way. */
    railGlyphGap: { height: 17 },

    // ── The weather, opened out ──
    /**
     * Square, and painted by the sky rather than by the app: the gradient
     * underneath is the only surface in the app that is not the page's own
     * dark, which is the point of opening it.
     */
    square: {
      aspectRatio: 1,
      borderRadius: 26,
      overflow: 'hidden',
      padding: spacing.md + 2,
      justifyContent: 'space-between',
    },
    squareFill: { borderRadius: 26 },
    squareTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    squarePlace: { fontSize: 13, ...font(600) },
    squareSky: { fontSize: 19, ...font(700), letterSpacing: -0.3, marginTop: 2 },
    squareMid: { marginTop: 'auto' },
    squareTemp: { fontSize: 64, lineHeight: 70, ...font(700), letterSpacing: -2 },
    squareFeels: { fontSize: 14, ...font(600), marginTop: 2 },
    /**
     * The foot of the open square: a toggle above a strip. The toggle picks
     * between hours (a scrollable strip) and days (the week ahead in-line),
     * and both sit under a hairline that reads as a divider from the reading
     * above them.
     */
    squareFoot: {
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingTop: 4,
      marginTop: 12,
    },
    squareWeek: {
      flexDirection: 'row',
      paddingTop: 6,
    },
    squareDay: { flex: 1, alignItems: 'center', gap: 4 },
    squareDayName: { fontSize: 11, ...font(600) },
    squareDayTemp: { fontSize: 13, ...font(700) },
    /** Hours strip inside the open square, mirrored so it scrolls both ways. */
    squareHourList: { flexDirection: 'row', paddingTop: 6, gap: 14, paddingHorizontal: 2 },
    squareHour: { width: 44, alignItems: 'center', gap: 4 },
    /** Dark ink on the sweep, the pairing every lit thing in the app uses. */
    railInk: { color: NIGHT.glyph },

    // ── Headline ──
    headline: { marginTop: spacing.md, paddingHorizontal: TEXT_INSET },
    headlineText: { ...font(700), color: NIGHT.ink, letterSpacing: -1.2 },
    /** A line of the headline that carries the name: the words, then the lit name. */
    headlineLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
    headlineSub: { ...font(500), color: NIGHT.sub, marginTop: 6 },

    // ── Progress ──
    progress: {
      ...glass,
      borderRadius: 18,
      padding: 12,
      marginTop: spacing.md - 4,
      gap: 10,
    },
    progressHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    progressTitle: { fontSize: 15.5, ...font(700), color: NIGHT.ink, letterSpacing: -0.2 },
    progressSub: { fontSize: 13, ...font(500), color: NIGHT.sub, marginTop: 2 },
    progressPct: { fontSize: 19, ...font(700), color: NIGHT.ink, letterSpacing: -0.4 },
    pips: { flexDirection: 'row', gap: 6, height: 8 },
    pip: { flex: 1, height: 8, borderRadius: 4, backgroundColor: NIGHT.cardAlt },

    // ── Suggested next ──
    listHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginTop: spacing.md,
      marginBottom: spacing.sm,
      paddingHorizontal: TEXT_INSET,
    },
    listTitle: { flex: 1, fontSize: 19, ...font(700), color: NIGHT.ink, letterSpacing: -0.4 },
    seeAll: { padding: 4 },
    cards: { flexDirection: 'row', gap: 8 },
    cardSlot: { flex: 1 },
    card: {
      ...glass,
      flex: 1,
      minHeight: 96,
      borderRadius: 18,
      padding: 10,
      gap: 6,
      justifyContent: 'space-between',
    },
    cardTitle: { fontSize: 14, ...font(700), color: NIGHT.ink, letterSpacing: -0.2, lineHeight: 18 },
    cardFoot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    cardWhen: { flex: 1, fontSize: 12, ...font(500), color: NIGHT.sub },
    empty: { ...glass, borderRadius: 18, paddingVertical: spacing.lg, alignItems: 'center' },
    emptyText: { fontSize: 15, ...font(600), color: NIGHT.sub },

    // ── The foot ──
    // Its pale, rounded-top ground is drawn by ‘FootShape’, not styled: this
    // View carries only layout — no background, no radius, no border — and the
    // drawn shape sits behind its content as an absolutely positioned sibling.
    foot: {
      // Bleeds to the screen edges from inside the scroll's own padding, the
      // way the weather rail and the cards above it do not need to — they
      // are meant to sit inset. This is the one thing on the page that reaches
      // edge to edge, which is what makes it read as a floor rather than a card.
      marginHorizontal: -GUTTER,
      marginTop: spacing.md,
      // Grows to soak up whatever the scroll's own flexGrow leaves over on a
      // short day, so the pale ground always reaches the bottom of the screen
      // — a day with three cards must not leave a strip of the dark page
      // showing through the floating nav bar.
      flexGrow: 1,
      flexDirection: 'row',
      // Not 'center': the two lines anchor to the top of the card, exactly as
      // they do when the card is exactly as tall as its content, and the
      // grown space falls below them, under the nav bar, where it belongs.
      alignItems: 'flex-start',
      paddingHorizontal: GUTTER + 8,
      // Clears the arc: the text starts below where the sides of the curve end.
      paddingTop: FOOT_RISE + spacing.sm + 4,
    },
    /** The small handle centred at the top of the arc. */
    footGrip: {
      position: 'absolute',
      top: 10,
      alignSelf: 'center',
      left: '50%',
      marginLeft: -20,
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: 'rgba(11, 18, 32, 0.18)',
    },
    // Equal halves, so the rule between them sits in the middle of the card.
    footNow: { flex: 1, paddingVertical: 2 },
    footKicker: { fontSize: 12, ...font(500), color: NIGHT.footSub },
    footTitle: {
      fontSize: 16,
      ...font(700),
      color: NIGHT.footInk,
      letterSpacing: -0.3,
      lineHeight: 21,
      marginTop: 3,
    },
    /** The hairline between the two halves. */
    footRule: {
      width: 1,
      // A fixed height, the height of the two lines beside it. Stretched, it
      // ran the full height of the grown card, down under the nav bar.
      height: 54,
      marginTop: 2,
      marginHorizontal: 14,
      backgroundColor: 'rgba(11, 18, 32, 0.12)',
    },
    footEnd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: 'rgba(52, 199, 89, 0.12)',
      marginRight: 8,
    },
    footEndLabel: { fontSize: 13, ...font(600), color: NIGHT.green },
    footCount: { flex: 1, paddingVertical: 2 },
    footNum: { fontSize: 26, ...font(700), color: NIGHT.footInk, letterSpacing: -0.8 },
    footLabel: { fontSize: 12.5, ...font(500), color: NIGHT.footSub, marginTop: 1 },

    // ── The bell's sheet ──
    backdrop: { flex: 1, backgroundColor: NIGHT.backdrop },
    sheet: {
      backgroundColor: colors.surface,
      borderTopStartRadius: 28,
      borderTopEndRadius: 28,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
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
      backgroundColor: NIGHT.grip,
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
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
    sheetRowTime: { minWidth: 62, fontSize: 13, ...font(700), color: colors.text },
    sheetRowTitle: { flex: 1, fontSize: 15, ...font(600), color: colors.text },
    sheetEmpty: {
      fontSize: 15,
      ...font(500),
      color: colors.text,
      opacity: 0.55,
      paddingVertical: spacing.md,
    },
  }),
);
