import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Animated, Modal, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { File, Paths } from 'expo-file-system';
import {
  X,
  ChartPie,
  CalendarClock,
  ShoppingCart,
  Wallet,
  Share2,
  FileText,
  Braces,
  Table,
} from 'lucide-react-native';

import { Screen } from '../components/ui';
import { CountUp, Entrance, Pressable, useGrow } from '../components/motion';
import { api, type ExpenseCategory } from '../lib/api';
import { storage } from '../lib/storage';
import { formatMoney } from '../lib/currency';
import { estimateCart } from '../lib/prices';
import {
  RANGES,
  calendarStats,
  exportBasename,
  financeStats,
  shoppingStats,
  toCsv,
  toJson,
  toText,
  windowOf,
  type Bucket,
  type CalendarStats,
  type ExportFormat,
  type ExportRow,
  type ExportSheet,
  type FinanceStats,
  type Range,
  type ShoppingStats,
} from '../lib/stats';
import type { RootStackParamList } from '../navigation';
import {
  AURA,
  AURA_CYCLE,
  IRIDESCENT,
  NIGHT,
  colors,
  font,
  radius,
  spacing,
  themed,
} from '../theme';
import { alignStart, isRTL, locale, t } from '../lib/i18n';

// The "Full statistics" screen. One page reused for finance, the calendar and
// the shopping list — the shell is the same, only the numbers change. A range
// runs across the top (day … all time), a headline number sits under it, and
// under that is the split, the series, and any per-domain extras.

type Nav = NativeStackNavigationProp<RootStackParamList>;
type StatsRoute = RouteProp<RootStackParamList, 'Stats'>;

/** Which domain the screen is showing. Passed in through navigation. */
export type StatsKind = 'finance' | 'calendar' | 'shopping';

// ── Range pills ─────────────────────────────────────────────────────────────

function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rangeRow}
    >
      {RANGES.map((r) => {
        const active = r === value;
        return (
          <Pressable
            key={r}
            onPress={() => {
              if (r === value) return;
              Haptics.selectionAsync();
              onChange(r);
            }}
            style={({ pressed }) => [
              styles.rangeChip,
              active && styles.rangeChipActive,
              pressed && styles.pressedDim,
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            {active ? (
              <LinearGradient
                colors={NIGHT.blue}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            ) : null}
            <Text style={[styles.rangeText, active && styles.rangeTextActive]}>
              {t(`stats.range.${r}`)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ── Bars ────────────────────────────────────────────────────────────────────

/**
 * A row for a category or bucket: the name, the share as a percentage, and a
 * bar filled to that share. The bar grows in as the row lands, using the
 * shared `useGrow` so it reads as the same motion the finance hero uses.
 */
function BarRow({
  label,
  value,
  total,
  format,
  color,
  delay = 0,
}: {
  label: string;
  value: number;
  total: number;
  /** How the value is drawn ("$31" / "3.2h"). Percent is added by the row. */
  format: (n: number) => string;
  color: string;
  delay?: number;
}) {
  const pct = total > 0 ? value / total : 0;
  const grow = useGrow(Math.max(pct, 0.01), 300 + delay);
  return (
    <Entrance delay={delay}>
      <View style={styles.barBlock}>
        <View style={styles.barLabelRow}>
          <Text style={[styles.barLabel, { textAlign: alignStart() }]} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.barValue}>
            {format(value)} · {Math.round(pct * 100)}%
          </Text>
        </View>
        <View style={styles.barTrack}>
          <Animated.View
            style={[
              styles.barFill,
              {
                backgroundColor: color,
                width: grow.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
              },
            ]}
          />
        </View>
      </View>
    </Entrance>
  );
}

/**
 * Small vertical-column chart across a window. Each bar is a bucket (a day or
 * a month depending on how long the range is); the tallest sets the top.
 *
 * The chart is decorative rather than dense — it says "the middle of the
 * month spent the most", not "on the 14th we spent 213". A label sits under
 * the first, the middle, and the last column, so the axis reads without a
 * separate legend.
 */
function MiniChart({ series }: { series: Bucket[] }) {
  const max = Math.max(1, ...series.map((b) => b.value));
  const showLabelAt = (i: number) =>
    i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2);
  return (
    <View style={styles.chartWrap}>
      <View style={styles.chartRow}>
        {series.map((b, i) => (
          <View key={b.key} style={styles.chartCol}>
            <View style={[styles.chartBar, { height: `${Math.max(2, (b.value / max) * 100)}%` }]}>
              <LinearGradient
                colors={NIGHT.blue}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            </View>
            <Text style={styles.chartLabel} numberOfLines={1}>
              {showLabelAt(i) ? b.label : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A single "31 / hours" / "18 / done" tile — three across at the top. */
function StatTile({
  label,
  value,
  format = (n) => String(Math.round(n)),
  disc = NIGHT.discs.tasks,
  delay = 0,
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  disc?: readonly [string, string];
  delay?: number;
}) {
  return (
    <Entrance delay={delay} style={styles.tile}>
      <LinearGradient
        colors={[disc[0], disc[1]]}
        start={{ x: 0.1, y: 0.05 }}
        end={{ x: 0.95, y: 0.95 }}
        style={styles.tileDisc}
      />
      <CountUp value={value} format={format} style={styles.tileValue} numberOfLines={1} />
      <Text style={styles.tileLabel} numberOfLines={2}>
        {label}
      </Text>
    </Entrance>
  );
}

// ── Domain views ────────────────────────────────────────────────────────────

/** Grabs a hue from the sweep so bars alternate through green/blue/yellow. */
function hueAt(i: number): string {
  return AURA[AURA_CYCLE[i % AURA_CYCLE.length]].ink;
}

function FinanceView({
  range,
  onSheet,
}: {
  range: Range;
  onSheet: (sheet: ExportSheet | null) => void;
}) {
  const [stats, setStats] = useState<FinanceStats | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const [{ entries }, profile] = await Promise.all([api.listMoney(), storage.getProfile()]);
      if (!active) return;
      const w = windowOf(range);
      setCurrency(profile.currency);
      setStats(
        financeStats(
          entries,
          w,
          (c) => (c === 'none' ? t('fin.noCategory') : t(`fin.exp.${c as ExpenseCategory}`)),
          (c) => t(`fin.inc.${c}`),
          locale(),
        ),
      );
    })();
    return () => {
      active = false;
    };
  }, [range]);

  useFocusEffect(load);

  const money = useMemo(() => (n: number) => formatMoney(n, currency, locale()), [currency]);

  // Build the export sheet from whatever the current stats are, and hand it
  // to the parent so its Share button has something to send. Rebuilt every
  // time the numbers change; nulled out while they are loading. Runs as an
  // effect, not in render — a parent setState in render is illegal.
  useEffect(() => {
    if (!stats) {
      onSheet(null);
      return;
    }
    const summary: ExportRow[] = [
      { section: t('stats.fin.spent'), label: t('fin.expenses'), value: money(stats.expenses) },
      { section: t('stats.fin.spent'), label: t('fin.income'), value: money(stats.income) },
      { section: t('stats.fin.spent'), label: t('fin.balance'), value: money(stats.balance) },
      {
        section: t('stats.fin.spent'),
        label: t('stats.fin.savingsRate'),
        value: `${Math.round(stats.savingsRate * 100)}%`,
      },
      {
        section: t('stats.fin.spent'),
        label: t('stats.fin.dailyAverage', { amount: money(stats.dailyAverage) }),
        value: money(stats.dailyAverage),
      },
    ];
    const cat: ExportRow[] = stats.byCategory.map((b) => ({
      section: t('fin.byCategory'),
      label: b.label,
      value: money(b.value),
      share: stats.expenses > 0 ? b.value / stats.expenses : 0,
    }));
    const inc: ExportRow[] = stats.byIncome.map((b) => ({
      section: t('stats.fin.income'),
      label: b.label,
      value: money(b.value),
      share: stats.income > 0 ? b.value / stats.income : 0,
    }));
    onSheet({
      title: `${t('stats.title.finance')} · ${t(`stats.range.${range}`)}`,
      header: ['section', 'label', 'value', 'share'].map((key) => t('stats.export.' + key)),
      rows: [...summary, ...cat, ...inc],
    });
  }, [stats, money, range, onSheet]);

  if (!stats) return null;

  const start = { textAlign: alignStart() } as const;

  return (
    <>
      <Entrance delay={40}>
        <View style={styles.hero}>
          <Text style={[styles.heroKicker, start]}>{t('stats.fin.spent')}</Text>
          <CountUp
            value={stats.expenses}
            format={money}
            style={[styles.heroValue, start]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          />
          <Text style={[styles.heroSub, start]}>
            {t('stats.fin.dailyAverage', { amount: money(stats.dailyAverage) })}
          </Text>
        </View>
      </Entrance>

      <View style={styles.tileRow}>
        <StatTile
          label={t('fin.income')}
          value={stats.income}
          format={money}
          disc={[AURA.green.ink, AURA.green.ink]}
          delay={80}
        />
        <StatTile
          label={t('fin.balance')}
          value={stats.balance}
          format={money}
          disc={NIGHT.discs.reminders}
          delay={130}
        />
        <StatTile
          label={t('stats.fin.savingsRate')}
          value={Math.round(stats.savingsRate * 100)}
          format={(n) => `${Math.round(n)}%`}
          disc={NIGHT.discs.meetings}
          delay={180}
        />
      </View>

      {stats.series.length > 1 ? (
        <Entrance delay={220}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('stats.chart.spentOverTime')}</Text>
            <MiniChart series={stats.series} />
          </View>
        </Entrance>
      ) : null}

      {stats.byCategory.length > 0 ? (
        <Entrance delay={260}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('fin.byCategory')}</Text>
            {stats.byCategory.map((b, i) => (
              <BarRow
                key={b.key}
                label={b.label}
                value={b.value}
                total={stats.expenses}
                format={money}
                color={hueAt(i)}
                delay={i * 40}
              />
            ))}
          </View>
        </Entrance>
      ) : null}

      {stats.byIncome.length > 0 ? (
        <Entrance delay={300}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('stats.fin.income')}</Text>
            {stats.byIncome.map((b, i) => (
              <BarRow
                key={b.key}
                label={b.label}
                value={b.value}
                total={stats.income}
                format={money}
                color={AURA.green.ink}
                delay={i * 40}
              />
            ))}
          </View>
        </Entrance>
      ) : null}

      {stats.count === 0 ? <EmptyNote text={t('stats.empty.finance')} /> : null}
    </>
  );
}

function CalendarView({
  range,
  onSheet,
}: {
  range: Range;
  onSheet: (sheet: ExportSheet | null) => void;
}) {
  const [stats, setStats] = useState<CalendarStats | null>(null);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const [{ events }, { tasks }] = await Promise.all([api.listEvents(), api.listTasks()]);
      if (!active) return;
      const w = windowOf(range);
      setStats(
        calendarStats(
          events,
          tasks,
          w,
          (c) => t(`stats.cal.cat.${c}`),
          (i) => t(`stats.cal.weekday.${i}`),
        ),
      );
    })();
    return () => {
      active = false;
    };
  }, [range]);

  useFocusEffect(load);

  const hoursFmt = (n: number) =>
    t('stats.cal.hoursUnit', { hours: (Math.round(n * 10) / 10).toString() });

  useEffect(() => {
    if (!stats) {
      onSheet(null);
      return;
    }
    const summary: ExportRow[] = [
      { section: t('stats.cal.busyHours'), label: t('stats.cal.busyHours'), value: hoursFmt(stats.hoursBusy) },
      { section: t('stats.cal.busyHours'), label: t('stats.cal.events'), value: String(stats.eventCount) },
      { section: t('stats.cal.busyHours'), label: t('stats.cal.tasksDone'), value: String(stats.tasksDone) },
      {
        section: t('stats.cal.busyHours'),
        label: t('stats.cal.completion'),
        value: `${Math.round(stats.completionRate * 100)}%`,
      },
      { section: t('stats.cal.busyHours'), label: t('stats.cal.streak'), value: String(stats.streak) },
    ];
    const cat: ExportRow[] = stats.byCategory.map((b) => ({
      section: t('stats.cal.byCategory'),
      label: b.label,
      value: hoursFmt(b.value),
      share: stats.hoursBusy > 0 ? b.value / stats.hoursBusy : 0,
    }));
    const wd: ExportRow[] = stats.byWeekday.map((b) => ({
      section: t('stats.cal.byWeekday'),
      label: b.label,
      value: hoursFmt(b.value),
    }));
    onSheet({
      title: `${t('stats.title.calendar')} · ${t(`stats.range.${range}`)}`,
      header: ['section', 'label', 'value', 'share'].map((key) => t('stats.export.' + key)),
      rows: [...summary, ...cat, ...wd],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, range, onSheet]);

  if (!stats) return null;
  const start = { textAlign: alignStart() } as const;

  return (
    <>
      <Entrance delay={40}>
        <View style={styles.hero}>
          <Text style={[styles.heroKicker, start]}>{t('stats.cal.busyHours')}</Text>
          <CountUp
            value={stats.hoursBusy}
            format={hoursFmt}
            style={[styles.heroValue, start]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
          />
          <Text style={[styles.heroSub, start]}>
            {t('stats.cal.avgPerDay', { hours: (Math.round(stats.avgPerDay * 10) / 10).toString() })}
          </Text>
          <Text style={[styles.heroSub, start]}>{t('stats.cal.basis')}</Text>
        </View>
      </Entrance>

      <View style={styles.tileRow}>
        <StatTile
          label={t('stats.cal.events')}
          value={stats.eventCount}
          disc={NIGHT.discs.meetings}
          delay={80}
        />
        <StatTile
          label={t('stats.cal.tasksDone')}
          value={stats.tasksDone}
          disc={NIGHT.discs.tasks}
          delay={130}
        />
        <StatTile
          label={t('stats.cal.completion')}
          value={Math.round(stats.completionRate * 100)}
          format={(n) => `${Math.round(n)}%`}
          disc={NIGHT.discs.reminders}
          delay={180}
        />
      </View>

      {stats.byCategory.length > 0 ? (
        <Entrance delay={220}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('stats.cal.byCategory')}</Text>
            {stats.byCategory.map((b, i) => (
              <BarRow
                key={b.key}
                label={b.label}
                value={b.value}
                total={stats.hoursBusy}
                format={hoursFmt}
                color={hueAt(i)}
                delay={i * 40}
              />
            ))}
          </View>
        </Entrance>
      ) : null}

      {stats.byWeekday.length > 0 ? (
        <Entrance delay={260}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('stats.cal.byWeekday')}</Text>
            {stats.byWeekday.map((b, i) => (
              <BarRow
                key={b.key}
                label={b.label}
                value={b.value}
                total={Math.max(...stats.byWeekday.map((x) => x.value))}
                format={hoursFmt}
                color={NIGHT.blue[0]}
                delay={i * 30}
              />
            ))}
          </View>
        </Entrance>
      ) : null}

      {stats.byHour.length > 0 ? (
        <Entrance delay={300}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('stats.cal.byHour')}</Text>
            <MiniChart series={stats.byHour} />
          </View>
        </Entrance>
      ) : null}

      <Entrance delay={340}>
        <View style={styles.card}>
          <Text style={[styles.cardTitle, start]}>{t('stats.cal.streak')}</Text>
          <Text style={[styles.bigNote, start]}>
            {t('stats.cal.streakDays', { days: stats.streak })}
          </Text>
        </View>
      </Entrance>

      {stats.eventCount === 0 && stats.taskCount === 0 ? (
        <EmptyNote text={t('stats.empty.calendar')} />
      ) : null}
    </>
  );
}

function ShoppingView({
  range,
  onSheet,
}: {
  range: Range;
  onSheet: (sheet: ExportSheet | null) => void;
}) {
  const [stats, setStats] = useState<ShoppingStats | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [showEstimates, setShowEstimates] = useState(false);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const [{ items }, history, profile, factor, settings] = await Promise.all([
        api.listShopping(),
        api.shoppingHistory(),
        storage.getProfile(),
        api.getPriceFactor(),
        storage.getSettings(),
      ]);
      if (!active) return;
      const w = windowOf(range);
      setCurrency(profile.currency);
      setShowEstimates(settings.shoppingEstimates);
      const oneItemCost = (item: (typeof items)[number]) =>
        estimateCart([item], profile.currency, factor).total;
      setStats(
        shoppingStats(
          items,
          history,
          w,
          (c) => t(`shop.cat.${c === 'other' ? 'other' : c}` as const),
          oneItemCost,
        ),
      );
    })();
    return () => {
      active = false;
    };
  }, [range]);

  useFocusEffect(load);

  const money = (n: number) => formatMoney(n, currency, locale());

  useEffect(() => {
    if (!stats) {
      onSheet(null);
      return;
    }
    const summary: ExportRow[] = [
      { section: t('stats.shop.bought'), label: t('stats.shop.bought'), value: String(stats.bought) },
      { section: t('stats.shop.bought'), label: t('stats.shop.total'), value: String(stats.total) },
      { section: t('stats.shop.bought'), label: t('stats.shop.open'), value: String(stats.open) },
      ...(showEstimates ? [{
        section: t('stats.shop.bought'),
        label: t('stats.shop.spentAbout', { amount: money(stats.spent) }),
        value: money(stats.spent),
      }] : []),
      {
        section: t('stats.shop.bought'),
        label: t('stats.shop.perDay'),
        value: String(stats.perDay),
      },
    ];
    const cat: ExportRow[] = stats.byCategory.map((b) => ({
      section: t('stats.shop.byCategory'),
      label: b.label,
      value: String(Math.round(b.value)),
      share: stats.bought > 0 ? b.value / stats.bought : 0,
    }));
    const top: ExportRow[] = stats.topItems.map((b) => ({
      section: t('stats.shop.topItems'),
      label: b.label,
      value: `${Math.round(b.value)}×`,
    }));
    onSheet({
      title: `${t('stats.title.shopping')} · ${t(`stats.range.${range}`)}`,
      header: ['section', 'label', 'value', 'share'].map((key) => t('stats.export.' + key)),
      rows: [...summary, ...cat, ...top],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, currency, range, onSheet, showEstimates]);

  if (!stats) return null;
  const start = { textAlign: alignStart() } as const;

  return (
    <>
      <Entrance delay={40}>
        <View style={styles.hero}>
          <Text style={[styles.heroKicker, start]}>{t('stats.shop.bought')}</Text>
          <CountUp
            value={stats.bought}
            format={(n) => String(Math.round(n))}
            style={[styles.heroValue, start]}
            numberOfLines={1}
          />
          {showEstimates ? <Text style={[styles.heroSub, start]}>
            {t('stats.shop.spentAbout', { amount: money(stats.spent) })}
          </Text> : null}
        </View>
      </Entrance>

      <View style={styles.tileRow}>
        <StatTile
          label={t('stats.shop.total')}
          value={stats.total}
          disc={NIGHT.discs.tasks}
          delay={80}
        />
        <StatTile
          label={t('stats.shop.open')}
          value={stats.open}
          disc={NIGHT.discs.reminders}
          delay={130}
        />
        <StatTile
          label={t('stats.shop.perDay')}
          value={stats.perDay}
          format={(n) => (Math.round(n * 10) / 10).toString()}
          disc={NIGHT.discs.meetings}
          delay={180}
        />
      </View>

      {stats.byCategory.length > 0 ? (
        <Entrance delay={220}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('stats.shop.byCategory')}</Text>
            {stats.byCategory.map((b, i) => (
              <BarRow
                key={b.key}
                label={b.label}
                value={b.value}
                total={stats.bought}
                format={(n) => String(Math.round(n))}
                color={hueAt(i)}
                delay={i * 40}
              />
            ))}
          </View>
        </Entrance>
      ) : null}

      {stats.topItems.length > 0 ? (
        <Entrance delay={260}>
          <View style={styles.card}>
            <Text style={[styles.cardTitle, start]}>{t('stats.shop.topItems')}</Text>
            {stats.topItems.map((b, i) => (
              <BarRow
                key={b.key}
                label={b.label}
                value={b.value}
                total={Math.max(...stats.topItems.map((x) => x.value))}
                format={(n) => `${Math.round(n)}×`}
                color={AURA.blue.ink}
                delay={i * 30}
              />
            ))}
          </View>
        </Entrance>
      ) : null}

      {stats.total === 0 ? <EmptyNote text={t('stats.empty.shopping')} /> : null}
    </>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

// ── Screen shell ────────────────────────────────────────────────────────────

const TITLE_KEY: Record<StatsKind, string> = {
  finance: 'stats.title.finance',
  calendar: 'stats.title.calendar',
  shopping: 'stats.title.shopping',
};

const KIND_ICON: Record<StatsKind, typeof ChartPie> = {
  finance: Wallet,
  calendar: CalendarClock,
  shopping: ShoppingCart,
};

export default function StatsScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<StatsRoute>();
  const kind = route.params?.kind ?? 'finance';
  const [range, setRange] = useState<Range>('week');
  /**
   * The current view's export sheet — the rows a share would send.
   *
   * Held here so the Share button in the header has something to hand off
   * whichever domain view is on the page; the view rebuilds and reports it
   * every time the stats it is showing change.
   */
  const [sheet, setSheet] = useState<ExportSheet | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const start = { textAlign: alignStart() } as const;
  const Icon = KIND_ICON[kind];

  /**
   * Writes the export to a real file so the OS share sheet offers "Save to
   * files", "Mail", "Drive", etc. — a plain text share only ever goes to
   * messaging apps. On failure, falls back to the plain-text share.
   */
  const shareAs = async (format: ExportFormat) => {
    if (!sheet) return;
    setExportOpen(false);
    const content =
      format === 'csv' ? toCsv(sheet) : format === 'json' ? toJson(sheet) : toText(sheet);
    const ext = format === 'csv' ? 'csv' : format === 'json' ? 'json' : 'txt';
    const filename = `${exportBasename(kind, range)}.${ext}`;

    try {
      // Cache directory is right for a share: the OS may clear it, but the
      // file only has to survive the trip through the share sheet.
      const file = new File(Paths.cache, filename);
      file.create({ overwrite: true });
      file.write(content);
      await Share.share({ url: file.uri, message: sheet.title, title: sheet.title });
      return;
    } catch {
      /* fall through to a plain-text share */
    }
    await Share.share({ message: `${sheet.title}\n\n${content}`, title: sheet.title });
  };

  return (
    <Screen clearTabBar={false}>
      <Entrance delay={0} from={12} style={styles.closeRow}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressedDim]}
          accessibilityRole="button"
          accessibilityLabel={t('notes.close')}
        >
          <X color={colors.text} size={20} strokeWidth={2.2} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => {
            if (!sheet) {
              Alert.alert(t('stats.export.emptyTitle'), t('stats.export.emptyBody'));
              return;
            }
            Haptics.selectionAsync();
            setExportOpen(true);
          }}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressedDim]}
          accessibilityRole="button"
          accessibilityLabel={t('stats.export.button')}
        >
          <Share2 color={colors.text} size={19} strokeWidth={2} />
        </Pressable>
      </Entrance>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <Entrance delay={40} from={16}>
          <View style={styles.titleRow}>
            <LinearGradient
              colors={IRIDESCENT}
              start={{ x: 0.1, y: 0.1 }}
              end={{ x: 0.9, y: 0.95 }}
              style={styles.titleDisc}
            >
              <Icon color={NIGHT.glyph} size={20} strokeWidth={2.2} />
            </LinearGradient>
            <View style={{ flex: 1, marginStart: 12 }}>
              <Text style={[styles.kicker, start]}>{t('stats.kicker')}</Text>
              <Text style={[styles.title, start]}>{t(TITLE_KEY[kind])}</Text>
            </View>
          </View>
        </Entrance>

        <Entrance delay={80} from={16}>
          <RangePicker value={range} onChange={setRange} />
        </Entrance>

        {kind === 'finance' ? <FinanceView range={range} onSheet={setSheet} /> : null}
        {kind === 'calendar' ? <CalendarView range={range} onSheet={setSheet} /> : null}
        {kind === 'shopping' ? <ShoppingView range={range} onSheet={setSheet} /> : null}
      </ScrollView>

      {/* The export sheet: three big buttons, one per format. Tap-outside
          the card closes; the card itself is a bottom sheet lifting from
          the foot of the page. */}
      <Modal
        visible={exportOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setExportOpen(false)}
      >
        <Pressable style={[styles.sheetBackdrop, { direction: isRTL() ? 'rtl' : 'ltr' }]} onPress={() => setExportOpen(false)}>
          <Pressable style={styles.exportCard} onPress={(e) => e.stopPropagation?.()}>
            <Text style={[styles.exportTitle, start]}>{t('stats.export.title')}</Text>
            <Text style={[styles.exportBody, start]}>{t('stats.export.body')}</Text>
            <View style={styles.exportRow}>
              <ExportOption
                Icon={Table}
                label={t('stats.export.csv')}
                hint={t('stats.export.csvHint')}
                onPress={() => shareAs('csv')}
              />
              <ExportOption
                Icon={Braces}
                label={t('stats.export.json')}
                hint={t('stats.export.jsonHint')}
                onPress={() => shareAs('json')}
              />
              <ExportOption
                Icon={FileText}
                label={t('stats.export.text')}
                hint={t('stats.export.textHint')}
                onPress={() => shareAs('text')}
              />
            </View>
            <Pressable
              onPress={() => setExportOpen(false)}
              style={({ pressed }) => [styles.exportCancel, pressed && styles.pressedDim]}
              accessibilityRole="button"
            >
              <Text style={styles.exportCancelText}>{t('common.cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

/** One tile in the export sheet: an icon disc, the format name, a hint. */
function ExportOption({
  Icon,
  label,
  hint,
  onPress,
}: {
  Icon: typeof ChartPie;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.exportBtn, pressed && styles.pressedDim]}
      accessibilityRole="button"
    >
      <View style={styles.exportBtnDisc}>
        <Icon color={NIGHT.glyph} size={22} strokeWidth={2} />
      </View>
      <Text style={styles.exportBtnLabel}>{label}</Text>
      <Text style={styles.exportBtnHint} numberOfLines={2}>
        {hint}
      </Text>
    </Pressable>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

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
    pressedDim: { opacity: 0.72 },

    closeRow: { flexDirection: 'row', marginBottom: spacing.sm },
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      alignItems: 'center',
      justifyContent: 'center',
    },

    content: { paddingTop: spacing.sm, paddingBottom: spacing.xl },

    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    titleDisc: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    kicker: {
      fontSize: 12,
      ...font(500),
      color: colors.textMuted,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    title: {
      fontSize: 26,
      lineHeight: 30,
      ...font(700),
      color: colors.text,
      letterSpacing: -0.6,
    },

    // ── Range pills ──
    rangeRow: {
      flexDirection: 'row',
      gap: 8,
      paddingVertical: spacing.sm,
      paddingEnd: spacing.md,
    },
    rangeChip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      overflow: 'hidden',
    },
    rangeChipActive: { borderColor: 'transparent' },
    rangeText: {
      fontSize: 13,
      ...font(600),
      color: colors.textMuted,
    },
    rangeTextActive: { color: '#FFFFFF' },

    // ── Hero ──
    hero: {
      ...glass,
      borderRadius: radius.lg,
      padding: spacing.md + 4,
      marginTop: spacing.sm,
      marginBottom: spacing.md,
    },
    heroKicker: {
      fontSize: 12,
      ...font(500),
      color: colors.textMuted,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginBottom: 4,
    },
    heroValue: {
      fontSize: 44,
      lineHeight: 48,
      ...font(700),
      color: colors.text,
      letterSpacing: -1.2,
    },
    heroSub: {
      marginTop: 4,
      fontSize: 14,
      ...font(500),
      color: colors.textMuted,
    },

    // ── Tile row ──
    tileRow: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: spacing.md,
    },
    tile: {
      flex: 1,
      ...glass,
      borderRadius: radius.md,
      padding: spacing.md,
      alignItems: isRTL() ? 'flex-end' : 'flex-start',
    },
    tileDisc: {
      width: 26,
      height: 26,
      borderRadius: 8,
      marginBottom: 8,
    },
    tileValue: {
      fontSize: 22,
      ...font(700),
      color: colors.text,
      letterSpacing: -0.6,
    },
    tileLabel: {
      marginTop: 2,
      fontSize: 12,
      ...font(500),
      color: colors.textMuted,
      textAlign: alignStart(),
    },

    // ── Cards & bars ──
    card: {
      ...glass,
      borderRadius: radius.lg,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    cardTitle: {
      fontSize: 15,
      ...font(600),
      color: colors.text,
      marginBottom: spacing.md,
    },
    barBlock: { marginBottom: spacing.sm + 2 },
    barLabelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 6,
    },
    barLabel: { flex: 1, fontSize: 13, ...font(500), color: colors.text },
    barValue: { fontSize: 12, ...font(500), color: colors.textMuted, marginStart: 8 },
    barTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: NIGHT.cardAlt,
      overflow: 'hidden',
    },
    barFill: { height: '100%', borderRadius: 4 },

    // ── Mini chart ──
    chartWrap: { marginTop: 4 },
    chartRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      height: 120,
      gap: 3,
    },
    chartCol: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'flex-end' },
    chartBar: {
      width: '80%',
      borderRadius: 4,
      overflow: 'hidden',
    },
    chartLabel: {
      marginTop: 6,
      fontSize: 10,
      ...font(500),
      color: colors.textMuted,
    },

    bigNote: {
      fontSize: 18,
      ...font(600),
      color: colors.text,
    },

    emptyBox: {
      ...glass,
      borderRadius: radius.md,
      padding: spacing.lg,
      alignItems: 'center',
      marginTop: spacing.md,
    },
    emptyText: {
      fontSize: 14,
      color: colors.textMuted,
      textAlign: 'center',
    },

    // ── Export sheet ──
    sheetBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
      padding: spacing.md,
    },
    exportCard: {
      ...glass,
      borderRadius: radius.lg,
      padding: spacing.md,
      backgroundColor: colors.surface,
    },
    exportTitle: {
      fontSize: 18,
      ...font(700),
      color: colors.text,
      marginBottom: 6,
    },
    exportBody: {
      fontSize: 13,
      color: colors.textMuted,
      marginBottom: spacing.md,
    },
    exportRow: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: spacing.md,
    },
    exportBtn: {
      flex: 1,
      alignItems: 'center',
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      gap: 8,
    },
    exportBtnDisc: {
      width: 48,
      height: 48,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: NIGHT.blue[0],
    },
    exportBtnLabel: {
      fontSize: 14,
      ...font(700),
      color: colors.text,
    },
    exportBtnHint: {
      fontSize: 11,
      color: colors.textMuted,
      textAlign: 'center',
      lineHeight: 14,
    },
    exportCancel: {
      alignSelf: 'center',
      paddingVertical: 10,
      paddingHorizontal: spacing.md,
    },
    exportCancelText: {
      fontSize: 14,
      ...font(600),
      color: colors.textMuted,
    },
  }),
);
