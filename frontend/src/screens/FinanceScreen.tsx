import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  Animated,
  ScrollView,
  View,
  Text,
  TextInput,
  StyleSheet,
  Alert,
  Modal,
  Share,
  Switch,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import {
  Plus,
  X,
  Trash2,
  TrendingUp,
  TrendingDown,
  Handshake,
  Check,
  Settings2,
  ChevronLeft,
  ChevronRight,
  Repeat,
  Lightbulb,
  Search,
  Download,
  ChartPie,
  TriangleAlert,
} from 'lucide-react-native';

import { Screen, LitDisc } from '../components/ui';
import {
  CountUp,
  Entrance,
  PopIn,
  Pressable,
  animateLayout,
  useBreathe,
  useGrow,
} from '../components/motion';
import { LinearGradient } from 'expo-linear-gradient';
import {
  api,
  uuid,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  type MoneyEntry,
  type Debt,
  type IncomeCategory,
  type ExpenseCategory,
} from '../lib/api';
import { toDateStr } from '../lib/tasks';
import { storage } from '../lib/storage';
import { formatMoney } from '../lib/currency';
import {
  debtTotals,
  insightsFor,
  isValidDay,
  monthCsv,
  monthKey,
  monthLabel,
  shiftDay,
  shiftMonth,
  totalsFor,
  type Budgets,
  type Insight,
} from '../lib/finance';
import type { RootStackParamList } from '../navigation';
import {
  colors,
  spacing,
  font,
  radius,
  AURA,
  IRIDESCENT,
  NIGHT,
  TAB_BAR_CLEARANCE,
  themed,
} from '../theme';
import { t, locale, alignStart, startAt, isRTL } from '../lib/i18n';

// Where the money is. A month at a glance, what it is saying, where it went,
// then income, expenses and debts — enough to answer "can I afford this", and
// deliberately not an accounting package.
//
// It replaces the profile screen and keeps that screen's headline and gear.
// Everything under them is dressed the way Home is: the month on a glass card,
// and each list a heading over glass rows, the way Home lists the day.

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Which sheet is open. */
type Editor =
  | { kind: 'income' | 'expense'; entry: MoneyEntry | null }
  | { kind: 'debt'; entry: Debt | null }
  | { kind: 'budget' };

/**
 * The lit disc beside each list's heading, in that list's hue — the same discs
 * the counts on Home stand on. Home has a yellow and a blue; it never needed a
 * green, so income's pair is made of the sweep's green and the green ink its
 * rows are edged with.
 */
const DISC = {
  // Getters, read at render, so the discs follow the scheme.
  get income() {
    return [IRIDESCENT[0], AURA.green.ink] as const;
  },
  get expenses() {
    return NIGHT.discs.meetings;
  },
  get debts() {
    return NIGHT.discs.tasks;
  },
};

/**
 * Money, in the currency chosen during onboarding and the reader's own locale.
 *
 * Curried on the currency rather than reading it globally, so every figure on
 * one render is formatted the same way even if the profile changes underneath.
 */
function moneyIn(currency: string | null) {
  return (n: number) => formatMoney(n, currency, locale());
}

/** "12 Aug" — plain dates on rows, so a long list stays scannable. */
function shortDate(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

/** "Thu, 17 Sep" — the date in the sheet, where the weekday helps. */
function longDate(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
}

/** An expense category's name, or the word for none. */
function expenseLabel(cat: ExpenseCategory | 'none' | null | undefined): string {
  return !cat || cat === 'none' ? t('fin.noCategory') : t(`fin.exp.${cat}`);
}

/**
 * `money` for a figure counting its way to `target`.
 *
 * A whole target counts in whole units: `formatMoney` shows cents for any
 * fraction, so a count to 1,200 would run through a flicker of cents it never
 * lands on and jump narrower at the end. The `|| 0` keeps the first frame of a
 * count below zero from reading "-0".
 */
function countingTo(target: number, money: (n: number) => string) {
  return (n: number) => money(Number.isInteger(target) ? Math.round(n) || 0 : n);
}

/** Parses a typed amount; commas are decimal points to half the world. */
function parseAmount(s: string): number {
  return Number(s.replace(/\s/g, '').replace(',', '.'));
}

/**
 * The page builds in reading order, a beat apart: the headline, the month, then
 * each list's heading and its rows in turn. Past `LAST_BEAT` everything arrives
 * together — by then it is below the fold, and a long list of income shouldn't
 * keep the lists under it waiting to be scrolled to.
 */
const BEAT = 45;
const LAST_BEAT = 12;
const beat = (n: number) => Math.min(n, LAST_BEAT) * BEAT;

/**
 * The blue the chosen thing is lit with: the chosen day on Home, the primary
 * button. It sits behind a label and is rounded itself rather than clipped by
 * its parent, because clipping on iOS takes the parent's glow with it.
 */
function BlueFill({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <LinearGradient
      colors={NIGHT.blue}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}

/**
 * Breathes around the first + while the page has nothing on it at all, so a
 * first visit sees where to start. The breath is only mounted while `on`: it
 * stops the moment there is anything to show, and a page with money on it has
 * nothing moving at rest.
 */
function Beckon({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <Breath>{children}</Breath> : <>{children}</>;
}

function Breath({ children }: { children: ReactNode }) {
  const scale = useBreathe(1, 1.08, 1300);
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

/** A 0–1 grow as a width along its track. */
const widthOf = (v: Animated.Value) =>
  v.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

/**
 * Previous and next month either side of the month's name. The arrows follow
 * the reading direction: in Hebrew, the past is to the right.
 */
function MonthSwitcher({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const current = monthKey();
  const Back = isRTL() ? ChevronRight : ChevronLeft;
  const Forward = isRTL() ? ChevronLeft : ChevronRight;
  const go = (delta: number) => {
    Haptics.selectionAsync();
    onChange(shiftMonth(month, delta));
  };
  return (
    <View style={styles.monthRow}>
      <Pressable
        onPress={() => go(-1)}
        hitSlop={6}
        style={styles.monthArrow}
        accessibilityRole="button"
        accessibilityLabel={t('fin.prevMonth')}
      >
        <Back color={colors.text} size={20} strokeWidth={2.2} />
      </Pressable>
      <View style={styles.monthMid}>
        <Text style={styles.monthText} numberOfLines={1}>
          {monthLabel(month, locale())}
        </Text>
        {month !== current ? (
          <Pressable onPress={() => onChange(current)} hitSlop={6} accessibilityRole="button">
            <Text style={styles.monthBack}>{t('fin.thisMonth')}</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        onPress={() => go(1)}
        disabled={month >= current}
        hitSlop={6}
        style={[styles.monthArrow, month >= current && styles.monthArrowOff]}
        accessibilityRole="button"
        accessibilityLabel={t('fin.nextMonth')}
      >
        <Forward color={colors.text} size={20} strokeWidth={2.2} />
      </Pressable>
    </View>
  );
}

/**
 * The month, as one card.
 *
 * Balance is the only figure anyone opens this screen to find, so it is the
 * only one set large. Income and expenses appear underneath as the two halves
 * of a single bar — the shape of the month reads faster than two more numbers,
 * and the bar makes "spending more than I earn" visible without arithmetic.
 */
function BalanceCard({
  balance,
  income,
  expenses,
  owe,
  owed,
  money,
}: {
  balance: number;
  income: number;
  expenses: number;
  owe: number;
  owed: number;
  money: (n: number) => string;
}) {
  const start = { textAlign: alignStart() } as const;
  const total = income + expenses;
  // Guarded: an empty month would divide by zero and render a NaN width.
  const inShare = total > 0 ? income / total : 0.5;

  // The bar grows out from the start edge as the page opens. The whole bar and
  // its income half ride the same spring from nothing, so the split sits at its
  // true proportion on every frame of the grow rather than sweeping into place;
  // when a figure changes afterwards the bar stays whole and the split slides.
  const whole = useGrow(1);
  const inPart = useGrow(inShare);

  return (
    <View style={styles.hero}>
      <Text style={[styles.heroKicker, start]}>{t('fin.balance')}</Text>
      <CountUp
        value={balance}
        format={countingTo(balance, money)}
        style={[styles.heroValue, start, balance < 0 && { color: colors.danger }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      />

      {/* Income against outgoings, as one bar rather than two figures. */}
      <View style={styles.splitTrack}>
        <Animated.View style={[styles.splitOut, startAt(0), { width: widthOf(whole) }]} />
        <Animated.View style={[styles.splitIn, { width: widthOf(inPart) }]} />
      </View>

      <View style={styles.heroLegend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: AURA.green.ink }]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {t('fin.income')}
          </Text>
          <CountUp
            value={income}
            format={countingTo(income, money)}
            style={styles.legendValue}
            numberOfLines={1}
          />
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: AURA.yellow.ink }]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {t('fin.expenses')}
          </Text>
          <CountUp
            value={expenses}
            format={countingTo(expenses, money)}
            style={styles.legendValue}
            numberOfLines={1}
          />
        </View>
      </View>

      {/* Debt qualifies the balance rather than standing beside it. Each way
          gets its own pill: one net figure hid which way the money goes. */}
      {owe > 0 || owed > 0 ? (
        <Entrance delay={320} from={10} style={styles.heroDebtSlot}>
          <View style={styles.heroDebtRow}>
            {owe > 0 ? (
              <View style={styles.heroDebt}>
                <Handshake color={colors.danger} size={14} strokeWidth={2.2} />
                <Text style={styles.heroDebtText} numberOfLines={1}>
                  {t('fin.owe')} · {money(owe)}
                </Text>
              </View>
            ) : null}
            {owed > 0 ? (
              <View style={styles.heroDebt}>
                <Handshake color={AURA.green.ink} size={14} strokeWidth={2.2} />
                <Text style={styles.heroDebtText} numberOfLines={1}>
                  {t('fin.owed')} · {money(owed)}
                </Text>
              </View>
            ) : null}
          </View>
        </Entrance>
      ) : null}
    </View>
  );
}

/** What the month is saying, a line each, the warnings first. */
function InsightsCard({ insights }: { insights: Insight[] }) {
  const start = { textAlign: alignStart() } as const;
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Lightbulb color={AURA.yellow.ink} size={16} strokeWidth={2.2} />
        <Text style={[styles.cardTitle, start]}>{t('fin.insights')}</Text>
      </View>
      {insights.map((ins, i) => {
        const tint =
          ins.tone === 'warn'
            ? colors.danger
            : ins.tone === 'good'
              ? AURA.green.ink
              : colors.textMuted;
        return (
          <View key={`${ins.key}-${i}`} style={styles.insightRow}>
            {ins.tone === 'warn' ? (
              <TriangleAlert color={tint} size={14} strokeWidth={2.2} />
            ) : (
              <View style={[styles.insightDot, { backgroundColor: tint }]} />
            )}
            <Text style={[styles.insightText, start]}>
              {t(ins.key, {
                ...ins.vars,
                ...(ins.category ? { category: expenseLabel(ins.category) } : {}),
              })}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Where the month's money went, a bar per category. A category with a budget
 * measures against it — and turns red past it; one without measures against
 * the biggest category, so the bars still compare.
 */
function CategoryBreakdown({
  rows,
  budgets,
  money,
  onEdit,
}: {
  rows: { category: ExpenseCategory | 'none'; amount: number }[];
  budgets: Budgets;
  money: (n: number) => string;
  onEdit: () => void;
}) {
  const start = { textAlign: alignStart() } as const;
  // Budgeted categories with nothing spent yet still show, at zero.
  const all = [...rows];
  for (const cat of EXPENSE_CATEGORIES) {
    if (budgets[cat] && !all.some((r) => r.category === cat)) all.push({ category: cat, amount: 0 });
  }
  const max = Math.max(1, ...all.map((r) => r.amount));

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <ChartPie color={AURA.blue.ink} size={16} strokeWidth={2.2} />
        <Text style={[styles.cardTitle, start]}>{t('fin.byCategory')}</Text>
        <Pressable onPress={onEdit} hitSlop={8} accessibilityRole="button">
          <Text style={styles.cardAction}>{t('fin.addBudget')}</Text>
        </Pressable>
      </View>
      {all.map((r) => {
        const limit = r.category !== 'none' ? budgets[r.category] : undefined;
        const share = limit ? r.amount / limit : r.amount / max;
        const over = !!limit && r.amount > limit;
        return (
          <Pressable
            key={r.category}
            onPress={onEdit}
            style={styles.catRow}
            accessibilityRole="button"
          >
            <View style={styles.catLine}>
              <Text style={[styles.catName, start]} numberOfLines={1}>
                {expenseLabel(r.category)}
              </Text>
              <Text style={[styles.catAmount, over && { color: colors.danger }]} numberOfLines={1}>
                {limit
                  ? t('fin.budgetOf', { spent: money(r.amount), limit: money(limit) })
                  : money(r.amount)}
              </Text>
            </View>
            <View style={styles.catTrack}>
              <View
                style={[
                  styles.catFill,
                  startAt(0),
                  {
                    width: `${Math.min(100, Math.max(2, share * 100))}%`,
                    backgroundColor: over
                      ? colors.danger
                      : limit && share > 0.8
                        ? AURA.yellow.ink
                        : limit
                          ? AURA.green.ink
                          : AURA.blue.ink,
                  },
                ]}
              />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The sheet's date: a step either way, today and yesterday, or typed. */
function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const start = { textAlign: alignStart() } as const;
  const today = toDateStr(new Date());
  const yesterday = shiftDay(today, -1);
  const valid = isValidDay(value);
  const Back = isRTL() ? ChevronRight : ChevronLeft;
  const Forward = isRTL() ? ChevronLeft : ChevronRight;
  const step = (d: number) => {
    if (!valid) return;
    Haptics.selectionAsync();
    onChange(shiftDay(value, d));
  };

  return (
    <View>
      <View style={styles.dateRow}>
        <Pressable onPress={() => step(-1)} style={styles.dateArrow} accessibilityRole="button">
          <Back color={colors.text} size={18} strokeWidth={2.2} />
        </Pressable>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.textMuted}
          selectionColor={NIGHT.blue[0]}
          style={[styles.input, styles.dateInput, start, !valid && styles.inputBad]}
        />
        <Pressable onPress={() => step(1)} style={styles.dateArrow} accessibilityRole="button">
          <Forward color={colors.text} size={18} strokeWidth={2.2} />
        </Pressable>
      </View>
      <View style={styles.dateChips}>
        {valid ? <Text style={styles.dateWeekday}>{longDate(value)}</Text> : null}
        <View style={{ flex: 1 }} />
        {[
          { day: today, label: t('fin.today') },
          { day: yesterday, label: t('fin.yesterday') },
        ].map(({ day, label }) => (
          <Pressable
            key={day}
            onPress={() => {
              Haptics.selectionAsync();
              onChange(day);
            }}
            style={[styles.miniChip, value === day && styles.miniChipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: value === day }}
          >
            <Text style={[styles.miniChipText, value === day && styles.chipTextActive]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function FinanceScreen() {
  const navigation = useNavigation<Nav>();
  const [entries, setEntries] = useState<MoneyEntry[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [budgets, setBudgets] = useState<Budgets>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [month, setMonth] = useState(monthKey());
  const [query, setQuery] = useState('');

  // Sheet fields, held apart from the row until Save.
  const [fDesc, setFDesc] = useState('');
  const [fAmount, setFAmount] = useState('');
  const [fDate, setFDate] = useState(toDateStr(new Date()));
  const [fCat, setFCat] = useState<IncomeCategory | ExpenseCategory | null>(null);
  const [fPerson, setFPerson] = useState('');
  const [fDirection, setFDirection] = useState<'owe' | 'owed'>('owe');
  const [fRecurring, setFRecurring] = useState(false);
  const [fBudgets, setFBudgets] = useState<Partial<Record<ExpenseCategory, string>>>({});
  // Counts the sheet's openings, to key its spring on (see the sheet).
  const [sheetOpens, setSheetOpens] = useState(0);

  /**
   * `animate` is for a reload after this screen changed something — a save, a
   * rollback — so the rows open and close their places. A reload on focus
   * leaves it off: the page is already building itself in, and a second
   * movement on top of that would be noise.
   */
  const load = useCallback((animate = false) => {
    let active = true;
    (async () => {
      try {
        const [{ entries: e }, { debts: d }, prof, b] = await Promise.all([
          api.listMoney(),
          api.listDebts(),
          storage.getProfile(),
          api.getBudgets(),
        ]);
        if (!active) return;
        if (animate) animateLayout();
        setEntries(e);
        setDebts(d);
        setCurrency(prof.currency);
        setBudgets(b);
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  const money = moneyIn(currency);

  const totals = useMemo(() => totalsFor(entries, month), [entries, month]);
  const owing = useMemo(() => debtTotals(debts), [debts]);
  const insights = useMemo(
    () => insightsFor(entries, month, budgets, moneyIn(currency)),
    [entries, month, budgets, currency],
  );

  const byDate = <T extends { date: string; createdAt: string }>(a: T, b: T) =>
    b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

  /** The month's rows, narrowed by the search when there is one. */
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return entries.filter((e) => {
      if (!e.date.startsWith(month)) return false;
      if (!q) return true;
      const cat = e.category
        ? t(`${e.kind === 'income' ? 'fin.inc' : 'fin.exp'}.${e.category}`)
        : '';
      return (
        e.description.toLocaleLowerCase().includes(q) ||
        cat.toLocaleLowerCase().includes(q) ||
        String(e.amount).includes(q)
      );
    });
  }, [entries, month, query]);

  const income = useMemo(
    () => visible.filter((e) => e.kind === 'income').sort(byDate),
    [visible],
  );
  const expenses = useMemo(
    () => visible.filter((e) => e.kind === 'expense').sort(byDate),
    [visible],
  );
  const sortedDebts = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return debts
      .filter(
        (d) =>
          !q ||
          d.person.toLocaleLowerCase().includes(q) ||
          (d.description ?? '').toLocaleLowerCase().includes(q),
      )
      .sort((a, b) => Number(a.isSettled) - Number(b.isSettled) || byDate(a, b));
  }, [debts, query]);

  /**
   * Who owes whom, kept apart.
   *
   * One list mixed both directions together and left the reader working out
   * which way each row went from the colour of a figure. Three groups, each
   * with its own total, answer "how much do I owe" and "how much am I owed"
   * without reading a single row.
   */
  const debtGroups = useMemo(() => {
    const open = sortedDebts.filter((d) => !d.isSettled);
    const sum = (rows: Debt[]) => rows.reduce((s, d) => s + d.amount, 0);
    const owe = open.filter((d) => d.direction === 'owe');
    const owed = open.filter((d) => d.direction === 'owed');
    const settled = sortedDebts.filter((d) => d.isSettled);
    return [
      { key: 'owe' as const, rows: owe, total: sum(owe), tint: colors.danger },
      { key: 'owed' as const, rows: owed, total: sum(owed), tint: AURA.green.ink },
      { key: 'settled' as const, rows: settled, total: sum(settled), tint: colors.textMuted },
    ].filter((g) => g.rows.length > 0);
  }, [sortedDebts]);

  const searching = query.trim().length > 0;

  // ── Opening the sheet ──

  /** A new row is dated today when looking at this month, else the month's first. */
  const defaultDate = () =>
    month === monthKey() ? toDateStr(new Date()) : `${month}-01`;

  const openMoney = (kind: 'income' | 'expense', entry: MoneyEntry | null) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFDesc(entry?.description ?? '');
    setFAmount(entry ? String(entry.amount) : '');
    setFDate(entry?.date ?? defaultDate());
    setFCat(entry?.category ?? null);
    setFRecurring(!!entry?.recurring);
    setSheetOpens((n) => n + 1);
    setEditor({ kind, entry });
  };

  const openDebt = (debt: Debt | null) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFPerson(debt?.person ?? '');
    setFAmount(debt ? String(debt.amount) : '');
    setFDesc(debt?.description ?? '');
    setFDate(debt?.date ?? defaultDate());
    setFDirection(debt?.direction ?? 'owe');
    setSheetOpens((n) => n + 1);
    setEditor({ kind: 'debt', entry: debt });
  };

  const openBudgets = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const fields: Partial<Record<ExpenseCategory, string>> = {};
    for (const cat of EXPENSE_CATEGORIES) {
      if (budgets[cat]) fields[cat] = String(budgets[cat]);
    }
    setFBudgets(fields);
    setSheetOpens((n) => n + 1);
    setEditor({ kind: 'budget' });
  };

  // ── Saving ──

  /** After an expense lands: say so if it tipped its category over budget. */
  const warnIfOverBudget = (cat: ExpenseCategory | null, date: string, list: MoneyEntry[]) => {
    if (!cat || !budgets[cat]) return;
    const m = date.slice(0, 7);
    const spent = list
      .filter((e) => e.kind === 'expense' && e.category === cat && e.date.startsWith(m))
      .reduce((s, e) => s + e.amount, 0);
    const limit = budgets[cat]!;
    if (spent <= limit) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      t('fin.budgetAlert.title'),
      t('fin.budgetAlert.body', {
        category: expenseLabel(cat),
        spent: money(spent),
        limit: money(limit),
      }),
    );
  };

  const saveBudgets = async () => {
    try {
      let next: Budgets = {};
      for (const cat of EXPENSE_CATEGORIES) {
        const raw = (fBudgets[cat] ?? '').trim();
        const n = raw ? parseAmount(raw) : 0;
        next = await api.setBudget(cat, Number.isFinite(n) ? n : 0);
      }
      animateLayout();
      setBudgets(next);
      setEditor(null);
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const save = async () => {
    if (!editor) return;
    if (editor.kind === 'budget') return saveBudgets();

    const amount = parseAmount(fAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert(t('fin.missingAmount'), t('fin.missingAmountBody'));
      return;
    }
    if (!isValidDay(fDate)) {
      Alert.alert(t('fin.invalidDate'), t('fin.invalidDateBody'));
      return;
    }

    if (editor.kind === 'debt') {
      const person = fPerson.trim();
      if (!person) {
        Alert.alert(t('fin.missingDescription'), t('fin.missingDescriptionBody'));
        return;
      }
      const stamp = new Date().toISOString();
      try {
        if (editor.entry) {
          await api.updateDebt(editor.entry.id, {
            direction: fDirection,
            person,
            amount,
            description: fDesc.trim() || null,
            date: fDate,
            updatedAt: stamp,
          });
        } else {
          await api.createDebt({
            id: uuid(),
            direction: fDirection,
            person,
            amount,
            description: fDesc.trim() || null,
            date: fDate,
            updatedAt: stamp,
          });
        }
        setEditor(null);
        // The layout animation is armed when the rows actually land, inside
        // `load` — arming it here would spend it on the sheet closing.
        load(true);
      } catch (e) {
        Alert.alert(t('common.error'), (e as Error).message);
      }
      return;
    }

    const description = fDesc.trim();
    if (!description) {
      Alert.alert(t('fin.missingDescription'), t('fin.missingDescriptionBody'));
      return;
    }
    const stamp = new Date().toISOString();
    try {
      let saved: MoneyEntry;
      if (editor.entry) {
        saved = await api.updateMoneyEntry(editor.entry.id, {
          description,
          amount,
          date: fDate,
          category: fCat,
          // A copy is not a source; only an original carries the repeat.
          ...(editor.entry.recurringFrom ? {} : { recurring: fRecurring }),
          updatedAt: stamp,
        });
      } else {
        saved = await api.createMoneyEntry({
          id: uuid(),
          kind: editor.kind,
          description,
          amount,
          date: fDate,
          category: fCat,
          recurring: fRecurring,
          updatedAt: stamp,
        });
      }
      setEditor(null);
      // Following the row: saved into another month, the page goes there.
      if (fDate.slice(0, 7) !== month) setMonth(fDate.slice(0, 7));
      load(true);
      if (saved.kind === 'expense') {
        const list = [saved, ...entries.filter((e) => e.id !== saved.id)];
        warnIfOverBudget(saved.category as ExpenseCategory | null, saved.date, list);
      }
    } catch (e) {
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  // ── Row actions ──

  const deleteEntry = (entry: MoneyEntry) => {
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: entry.description }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          animateLayout();
          setEntries((prev) => prev.filter((r) => r.id !== entry.id));
          try {
            await api.deleteMoneyEntry(entry.id);
          } catch (e) {
            load(true);
            Alert.alert(t('common.error'), (e as Error).message);
          }
        },
      },
    ]);
  };

  const deleteDebt = (debt: Debt) => {
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: debt.person }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          animateLayout();
          setDebts((prev) => prev.filter((r) => r.id !== debt.id));
          try {
            await api.deleteDebt(debt.id);
          } catch (e) {
            load(true);
            Alert.alert(t('common.error'), (e as Error).message);
          }
        },
      },
    ]);
  };

  const setSettled = async (debt: Debt, next: boolean) => {
    // A settled debt sinks below the open ones; this lets it slide there.
    animateLayout();
    setDebts((prev) => prev.map((r) => (r.id === debt.id ? { ...r, isSettled: next } : r)));
    try {
      await api.updateDebt(debt.id, { isSettled: next, updatedAt: new Date().toISOString() });
    } catch {
      load(true);
    }
  };

  /**
   * Settling a debt is money actually moving, so it offers to land in the
   * month as well: paying someone back is an expense, being paid back income.
   */
  const toggleSettled = (debt: Debt) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (debt.isSettled) {
      void setSettled(debt, false);
      return;
    }
    const kind = debt.direction === 'owe' ? 'expense' : 'income';
    Alert.alert(
      t('fin.settleRecord.title'),
      t(debt.direction === 'owe' ? 'fin.settleRecord.owe' : 'fin.settleRecord.owed', {
        amount: money(debt.amount),
        person: debt.person,
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('fin.settleRecord.no'), onPress: () => void setSettled(debt, true) },
        {
          text: t('fin.settleRecord.yes'),
          onPress: async () => {
            await setSettled(debt, true);
            try {
              await api.createMoneyEntry({
                id: uuid(),
                kind,
                description: t('fin.settleDesc', { person: debt.person }),
                amount: debt.amount,
                date: toDateStr(new Date()),
                category: 'other',
                updatedAt: new Date().toISOString(),
              });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setMonth(monthKey());
              load(true);
            } catch (e) {
              Alert.alert(t('common.error'), (e as Error).message);
            }
          },
        },
      ],
    );
  };

  const exportMonth = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!entries.some((e) => e.date.startsWith(month))) {
      Alert.alert(t('fin.export'), t('fin.exportEmpty'));
      return;
    }
    const csv = monthCsv(entries, month, (e) =>
      e.category ? t(`${e.kind === 'income' ? 'fin.inc' : 'fin.exp'}.${e.category}`) : '',
    );
    try {
      await Share.share({ title: `${t('fin.title')} ${month}`, message: csv });
    } catch {
      /* dismissed, or no share sheet on this platform */
    }
  };

  const start = { textAlign: alignStart() } as const;
  const catList: readonly string[] =
    editor?.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const catPrefix = editor?.kind === 'income' ? 'fin.inc' : 'fin.exp';

  const sheetTitle = !editor
    ? ''
    : editor.kind === 'budget'
      ? t('fin.setBudget')
      : editor.kind === 'debt'
        ? t(editor.entry ? 'fin.editDebt' : 'fin.addDebt')
        : editor.kind === 'income'
          ? t(editor.entry ? 'fin.editIncome' : 'fin.addIncome')
          : t(editor.entry ? 'fin.editExpense' : 'fin.addExpense');

  const hasMonth = totals.income > 0 || totals.expenses > 0;
  const showBreakdown = totals.byCategory.length > 0 || Object.keys(budgets).length > 0;

  // Where each list's heading falls in the build. Its rows, or its one
  // placeholder, take the beats straight after it.
  const incomeAt = 5;
  const expensesAt = incomeAt + 1 + Math.max(income.length, 1);
  const debtsAt = expensesAt + 1 + Math.max(expenses.length, 1);

  // A page with nothing on it at all leans on the first + (see `Beckon`).
  const nothingYet = entries.length === 0 && debts.length === 0;

  /** One income or expense row. */
  const moneyRow = (e: MoneyEntry, i: number, at: number) => {
    const isIncome = e.kind === 'income';
    const ink = isIncome ? AURA.green.ink : AURA.yellow.ink;
    const repeats = e.recurring || !!e.recurringFrom;
    return (
      <Entrance key={e.id} delay={beat(at + 1 + i)} from={16}>
        <Pressable
          onPress={() => openMoney(e.kind, e)}
          style={({ pressed }) => [styles.row, pressed && styles.pressedDim]}
          accessibilityRole="button"
        >
          <View style={[styles.rowEdge, startAt(0), { backgroundColor: ink }]} />
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, start]} numberOfLines={1}>
              {e.description}
            </Text>
            <View style={styles.rowMetaLine}>
              {repeats ? <Repeat color={colors.textMuted} size={12} strokeWidth={2.2} /> : null}
              <Text style={[styles.rowMeta, start]} numberOfLines={1}>
                {shortDate(e.date)}
                {e.category ? ` · ${t(`${isIncome ? 'fin.inc' : 'fin.exp'}.${e.category}`)}` : ''}
                {repeats ? ` · ${t('fin.recurringBadge')}` : ''}
              </Text>
            </View>
          </View>
          <Text style={[styles.amount, { color: ink }]}>
            {isIncome ? '+' : '−'}
            {money(e.amount)}
          </Text>
          <Pressable
            onPress={() => deleteEntry(e)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.delete')}
          >
            <Trash2 color={colors.textMuted} size={19} strokeWidth={1.7} />
          </Pressable>
        </Pressable>
      </Entrance>
    );
  };

  /**
   * One debt. Who it is with reads first — the initial, then the name — and
   * which way it goes is said in words on the line under it as well as in the
   * colour of the figure, because a colour alone is not an answer.
   */
  const debtRow = (d: Debt, at: number) => {
    const ink = d.direction === 'owe' ? colors.danger : AURA.green.ink;
    return (
      <Entrance key={d.id} delay={beat(at)} from={16}>
        <Pressable
          onPress={() => openDebt(d)}
          style={({ pressed }) => [styles.row, pressed && styles.pressedDim]}
          accessibilityRole="button"
        >
          {/* A settled debt is history: the edge goes, as a done row's does on
              Home. An open one is edged in the colour of its direction. */}
          {!d.isSettled ? (
            <View style={[styles.rowEdge, startAt(0), { backgroundColor: ink }]} />
          ) : null}

          {/* The tick is smaller than the button it replaced, so the slop
              grows to keep the same 44px target. Ticking it pops the filled
              disc in: settling is the moment worth marking. */}
          <Pressable
            onPress={() => toggleSettled(d)}
            hitSlop={11}
            accessibilityRole="button"
            accessibilityLabel={t(d.isSettled ? 'fin.markUnpaid' : 'fin.markPaid')}
          >
            {d.isSettled ? (
              <PopIn>
                <LinearGradient
                  colors={NIGHT.discs.tasks}
                  start={{ x: 0.15, y: 0.1 }}
                  end={{ x: 0.85, y: 0.95 }}
                  style={styles.tick}
                >
                  <Check color={NIGHT.glyph} size={13} strokeWidth={3} />
                </LinearGradient>
              </PopIn>
            ) : (
              <View style={[styles.tick, styles.tickOpen]} />
            )}
          </Pressable>

          {/* Who, as a letter: a list of debts is read by person first, and a
              name in a coloured disc is found faster than a line of type. */}
          <View
            style={[styles.who, { borderColor: ink }]}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            <Text style={[styles.whoText, { color: ink }]}>
              {[...d.person.trim()][0]?.toLocaleUpperCase() ?? '?'}
            </Text>
          </View>

          <View style={styles.rowBody}>
            <Text
              style={[styles.rowTitle, start, d.isSettled && styles.rowTitleSettled]}
              numberOfLines={1}
            >
              {d.person}
            </Text>
            <Text style={[styles.rowMeta, start]} numberOfLines={1}>
              {t(d.direction === 'owe' ? 'fin.owe' : 'fin.owed')} · {shortDate(d.date)}
              {d.description ? ` · ${d.description}` : ''}
            </Text>
          </View>

          <Text
            style={[
              styles.amount,
              // Owing is the only figure here that should feel like a pull on
              // the balance; being owed is neutral good news.
              { color: ink },
              d.isSettled && styles.amountSettled,
            ]}
          >
            {money(d.amount)}
          </Text>
          <Pressable
            onPress={() => deleteDebt(d)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.delete')}
          >
            <Trash2 color={colors.textMuted} size={19} strokeWidth={1.7} />
          </Pressable>
        </Pressable>
      </Entrance>
    );
  };

  const emptyRow = (at: number, key: string) => (
    <Entrance delay={beat(at + 1)} from={16}>
      <View style={styles.empty}>
        <Text style={[styles.emptyLine, start]}>
          {searching ? t('fin.noResults') : t(key)}
        </Text>
      </View>
    </Entrance>
  );

  return (
    <Screen>
      {/* The headline keeps a gear beside it: Finance took this tab from the
          profile screen, and the language picker and the hours the assistant
          schedules around still live there. */}
      <Entrance delay={beat(0)} from={12}>
        <View style={styles.headerRow}>
          <Text style={[styles.headline, start]}>{t('fin.title')}</Text>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.navigate('Stats', { kind: 'finance' });
            }}
            style={({ pressed }) => [styles.roundBtn, styles.gearBtn, pressed && styles.pressedDim]}
            accessibilityRole="button"
            accessibilityLabel={t('stats.button')}
          >
            <ChartPie color={colors.text} size={19} strokeWidth={1.9} />
          </Pressable>
          <Pressable
            onPress={exportMonth}
            style={({ pressed }) => [styles.roundBtn, styles.gearBtn, pressed && styles.pressedDim]}
            accessibilityRole="button"
            accessibilityLabel={t('fin.export')}
          >
            <Download color={colors.text} size={19} strokeWidth={1.9} />
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.navigate('Settings');
            }}
            style={({ pressed }) => [styles.roundBtn, styles.gearBtn, pressed && styles.pressedDim]}
            accessibilityRole="button"
            accessibilityLabel={t('tab.profile')}
          >
            <Settings2 color={colors.text} size={21} strokeWidth={1.9} />
          </Pressable>
        </View>
      </Entrance>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Which month ── */}
        <Entrance delay={beat(1)} from={14}>
          <MonthSwitcher
            month={month}
            onChange={(m) => {
              animateLayout();
              setMonth(m);
            }}
          />
        </Entrance>

        {/* ── The month, as one card ── */}
        <Entrance delay={beat(2)} from={20}>
          <BalanceCard
            balance={totals.balance}
            income={totals.income}
            expenses={totals.expenses}
            owe={owing.owe}
            owed={owing.owed}
            money={money}
          />
        </Entrance>

        {/* ── What the month is saying ── */}
        {hasMonth && insights.length > 0 ? (
          <Entrance delay={beat(3)} from={16}>
            <InsightsCard insights={insights} />
          </Entrance>
        ) : null}

        {/* ── Where it went ── */}
        {showBreakdown ? (
          <Entrance delay={beat(4)} from={16}>
            <CategoryBreakdown
              rows={totals.byCategory}
              budgets={budgets}
              money={money}
              onEdit={openBudgets}
            />
          </Entrance>
        ) : null}

        {/* ── Search ── */}
        {!nothingYet ? (
          <Entrance delay={beat(4)} from={12}>
            <View style={styles.searchRow}>
              <Search color={colors.textMuted} size={17} strokeWidth={2} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={t('fin.search')}
                placeholderTextColor={colors.textMuted}
                selectionColor={NIGHT.blue[0]}
                style={[styles.searchInput, start]}
                returnKeyType="search"
              />
              {searching ? (
                <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button">
                  <X color={colors.textMuted} size={17} strokeWidth={2.2} />
                </Pressable>
              ) : null}
            </View>
          </Entrance>
        ) : null}

        {/* Each list below is its heading and then its rows, every one its own
            entrance, so a list builds down the page rather than arriving as a
            block. Rows are keyed by id: one saved from the sheet mounts, and
            mounting is what brings it in. */}

        {/* ── Income ── */}
        <Entrance delay={beat(incomeAt)} from={16}>
          <View style={styles.sectionHead}>
            <LitDisc colors={DISC.income} size={32}>
              <TrendingUp color={NIGHT.glyph} size={16} strokeWidth={2.4} />
            </LitDisc>
            <Text style={[styles.sectionTitle, start]}>{t('fin.income')}</Text>
            <Beckon on={nothingYet}>
              <Pressable
                onPress={() => openMoney('income', null)}
                style={({ pressed }) => [styles.roundBtn, pressed && styles.pressedDim]}
                accessibilityRole="button"
                accessibilityLabel={t('fin.addIncome')}
              >
                <Plus color={colors.text} size={19} strokeWidth={2.2} />
              </Pressable>
            </Beckon>
          </View>
        </Entrance>

        {income.length === 0
          ? emptyRow(incomeAt, 'fin.empty.income')
          : income.map((e, i) => moneyRow(e, i, incomeAt))}

        {/* ── Expenses ── */}
        <Entrance delay={beat(expensesAt)} from={16}>
          <View style={styles.sectionHead}>
            <LitDisc colors={DISC.expenses} size={32}>
              <TrendingDown color={NIGHT.glyph} size={16} strokeWidth={2.4} />
            </LitDisc>
            <Text style={[styles.sectionTitle, start]}>{t('fin.expenses')}</Text>
            <Pressable
              onPress={() => openMoney('expense', null)}
              style={({ pressed }) => [styles.roundBtn, pressed && styles.pressedDim]}
              accessibilityRole="button"
              accessibilityLabel={t('fin.addExpense')}
            >
              <Plus color={colors.text} size={19} strokeWidth={2.2} />
            </Pressable>
          </View>
        </Entrance>

        {expenses.length === 0
          ? emptyRow(expensesAt, 'fin.empty.expenses')
          : expenses.map((e, i) => moneyRow(e, i, expensesAt))}

        {/* ── Debts: all of them, whatever the month — a debt is open until it isn't ── */}
        <Entrance delay={beat(debtsAt)} from={16}>
          <View style={styles.sectionHead}>
            <LitDisc colors={DISC.debts} size={32}>
              <Handshake color={NIGHT.glyph} size={16} strokeWidth={2.4} />
            </LitDisc>
            <Text style={[styles.sectionTitle, start]}>{t('fin.debts')}</Text>
            <Pressable
              onPress={() => openDebt(null)}
              style={({ pressed }) => [styles.roundBtn, pressed && styles.pressedDim]}
              accessibilityRole="button"
              accessibilityLabel={t('fin.addDebt')}
            >
              <Plus color={colors.text} size={19} strokeWidth={2.2} />
            </Pressable>
          </View>
        </Entrance>

        {debtGroups.length === 0
          ? emptyRow(debtsAt, 'fin.empty.debts')
          : (() => {
              // The beats keep running across the groups, so the whole section
              // builds in one sweep rather than restarting at each heading.
              let row = 0;
              return debtGroups.map((group) => (
                <View key={group.key}>
                  <Entrance delay={beat(debtsAt + 1 + row++)} from={14}>
                    <View style={styles.debtHead}>
                      <View style={[styles.debtDot, { backgroundColor: group.tint }]} />
                      <Text style={[styles.debtHeadText, start]} numberOfLines={1}>
                        {t(
                          group.key === 'owe'
                            ? 'fin.owe'
                            : group.key === 'owed'
                              ? 'fin.owed'
                              : 'fin.settled',
                        )}
                      </Text>
                      <Text style={[styles.debtHeadTotal, { color: group.tint }]}>
                        {money(group.total)}
                      </Text>
                    </View>
                  </Entrance>
                  {group.rows.map((d) => debtRow(d, debtsAt + 1 + row++))}
                </View>
              ));
            })()}
      </ScrollView>

      {/* ── One sheet, four shapes ── */}
      <Modal
        visible={editor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditor(null)}
      >
        <Pressable style={[styles.backdrop, { direction: isRTL() ? 'rtl' : 'ltr' }]} onPress={() => setEditor(null)}>
          {/* The panel springs up to its size on every open, over the
              backdrop's fade. Keyed on the opening rather than left to the
              modal's own mounting: iOS keeps the contents mounted until its
              dismissal finishes, and a quick reopen would skip the spring. */}
          <PopIn key={sheetOpens} from={0.92} style={styles.sheetFrame}>
            {/* Not a control — it only keeps a tap on the form from closing it —
                so a tap on its background must not dip the whole panel. */}
            <Pressable style={styles.sheet} onPress={() => {}} pressScale={1}>
              <View style={styles.sheetHead}>
                <Text style={[styles.sheetTitle, start]}>{sheetTitle}</Text>
                <Pressable
                  onPress={() => setEditor(null)}
                  hitSlop={8}
                  style={styles.sheetClose}
                  accessibilityRole="button"
                  accessibilityLabel={t('notes.close')}
                >
                  <X color={colors.text} size={17} strokeWidth={2.4} />
                </Pressable>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                style={styles.sheetBody}
                keyboardShouldPersistTaps="handled"
              >
                {editor?.kind === 'budget' ? (
                  <>
                    <Text style={[styles.hintLine, start]}>{t('fin.setBudgetHint')}</Text>
                    {EXPENSE_CATEGORIES.map((cat) => {
                      const spent =
                        totals.byCategory.find((r) => r.category === cat)?.amount ?? 0;
                      return (
                        <View key={cat} style={styles.budgetRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.budgetName, start]}>{expenseLabel(cat)}</Text>
                            {spent > 0 ? (
                              <Text style={[styles.budgetSpent, start]}>{money(spent)}</Text>
                            ) : null}
                          </View>
                          <TextInput
                            value={fBudgets[cat] ?? ''}
                            onChangeText={(v) => setFBudgets((prev) => ({ ...prev, [cat]: v }))}
                            keyboardType="decimal-pad"
                            placeholder="—"
                            placeholderTextColor={colors.textMuted}
                            selectionColor={NIGHT.blue[0]}
                            style={[styles.input, styles.budgetInput]}
                          />
                        </View>
                      );
                    })}
                  </>
                ) : (
                  <>
                    {editor?.kind === 'debt' ? (
                      <>
                        <Text style={[styles.fieldLabel, start]}>{t('fin.person')}</Text>
                        <TextInput
                          value={fPerson}
                          onChangeText={setFPerson}
                          placeholder={t('fin.personHint')}
                          placeholderTextColor={colors.textMuted}
                          selectionColor={NIGHT.blue[0]}
                          style={[styles.input, start]}
                          autoFocus
                        />

                        <Text style={[styles.fieldLabel, start]}>{t('fin.category')}</Text>
                        {/* Two sides of one debt, so a rail rather than chips. With
                            one side always lit there is no hairline between them:
                            Home's rail clears the ones beside the chosen day. */}
                        <View style={styles.seg}>
                          {(['owe', 'owed'] as const).map((dir) => {
                            const active = fDirection === dir;
                            return (
                              <Pressable
                                key={dir}
                                onPress={() => {
                                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                  setFDirection(dir);
                                }}
                                style={styles.segCell}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                              >
                                {/* Mounted only on the chosen side, so choosing
                                    is what springs the blue in. */}
                                {active ? (
                                  <PopIn style={[StyleSheet.absoluteFill, styles.segOn]}>
                                    <BlueFill style={styles.segFill} />
                                  </PopIn>
                                ) : null}
                                <Text style={[styles.segText, active && styles.chipTextActive]}>
                                  {t(dir === 'owe' ? 'fin.owe' : 'fin.owed')}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </>
                    ) : (
                      <>
                        <Text style={[styles.fieldLabel, start]}>{t('fin.description')}</Text>
                        <TextInput
                          value={fDesc}
                          onChangeText={setFDesc}
                          style={[styles.input, start]}
                          placeholderTextColor={colors.textMuted}
                          selectionColor={NIGHT.blue[0]}
                          autoFocus
                        />
                      </>
                    )}

                    <Text style={[styles.fieldLabel, start]}>{t('fin.amount')}</Text>
                    <TextInput
                      value={fAmount}
                      onChangeText={setFAmount}
                      keyboardType="decimal-pad"
                      style={[styles.input, start]}
                      placeholder="0"
                      placeholderTextColor={colors.textMuted}
                      selectionColor={NIGHT.blue[0]}
                    />

                    <Text style={[styles.fieldLabel, start]}>{t('fin.date')}</Text>
                    <DateField value={fDate} onChange={setFDate} />

                    {editor?.kind === 'debt' ? (
                      <>
                        <Text style={[styles.fieldLabel, start]}>{t('fin.description')}</Text>
                        <TextInput
                          value={fDesc}
                          onChangeText={setFDesc}
                          style={[styles.input, start]}
                          placeholderTextColor={colors.textMuted}
                          selectionColor={NIGHT.blue[0]}
                        />
                      </>
                    ) : (
                      <>
                        <Text style={[styles.fieldLabel, start]}>{t('fin.category')}</Text>
                        <View style={styles.chipWrap}>
                          {catList.map((cat) => {
                            const active = fCat === cat;
                            return (
                              <Pressable
                                key={cat}
                                onPress={() => {
                                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                  // A second tap on the chosen one clears it.
                                  setFCat(
                                    active ? null : (cat as IncomeCategory | ExpenseCategory),
                                  );
                                }}
                                style={[styles.chip, active && styles.chipActive]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                              >
                                {active ? (
                                  <PopIn style={[StyleSheet.absoluteFill, styles.chipOn]}>
                                    <BlueFill style={styles.chipFill} />
                                  </PopIn>
                                ) : null}
                                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                  {t(`${catPrefix}.${cat}`)}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>

                        {/* A copy made from a repeating entry is not itself a
                            source, so it has nothing to switch. */}
                        {editor?.kind === 'income' || editor?.kind === 'expense' ? (
                          editor.entry?.recurringFrom ? null : (
                            <View style={styles.switchRow}>
                              <Repeat color={colors.textMuted} size={17} strokeWidth={2} />
                              <View style={{ flex: 1 }}>
                                <Text style={[styles.switchTitle, start]}>
                                  {t('fin.recurring')}
                                </Text>
                                <Text style={[styles.switchHint, start]}>
                                  {t('fin.recurringHint')}
                                </Text>
                              </View>
                              <Switch
                                value={fRecurring}
                                onValueChange={(v) => {
                                  Haptics.selectionAsync();
                                  setFRecurring(v);
                                }}
                                trackColor={{ true: NIGHT.blue[1], false: NIGHT.cardAlt }}
                                ios_backgroundColor={NIGHT.cardAlt}
                                thumbColor={colors.primaryText}
                              />
                            </View>
                          )
                        ) : null}
                      </>
                    )}
                  </>
                )}
              </ScrollView>

              <Pressable
                onPress={save}
                style={({ pressed }) => [styles.saveBtn, pressed && styles.pressedDim]}
                accessibilityRole="button"
              >
                <BlueFill style={styles.saveFill} />
                <Text style={styles.saveText}>{t('profile.save')}</Text>
              </Pressable>
            </Pressable>
          </PopIn>
        </Pressable>
      </Modal>
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

/** The soft glow under whatever is lit blue, as under the chosen day on Home. */
const blueGlow = {
  get shadowColor() {
    return NIGHT.blue[1];
  },
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.5,
  shadowRadius: 10,
} as const;

const styles = themed(() =>
  StyleSheet.create({
    /** A press that reads as a press without moving anything under the finger. */
    pressedDim: { opacity: 0.72 },

    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headline: {
      fontSize: 36,
      ...font(700),
      color: colors.text,
      letterSpacing: -1,
      marginBottom: spacing.md,
    },
    /**
     * The gear and the lists' + buttons: a quiet disc like Home's bell. They are
     * things to do, not things chosen, so they stay out of the blue.
     */
    roundBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** Sits level with the headline, which carries the same bottom margin. */
    gearBtn: { width: 44, height: 44, borderRadius: 22, marginBottom: spacing.md },
    /** Ends clear of the floating bar: the page runs under it (see `Screen`). */
    content: { paddingBottom: TAB_BAR_CLEARANCE },

    // ── Month switcher ──
    monthRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: spacing.sm,
    },
    monthArrow: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    monthArrowOff: { opacity: 0.35 },
    monthMid: { flex: 1, alignItems: 'center' },
    monthText: { fontSize: 17, ...font(700), color: colors.text, letterSpacing: -0.3 },
    monthBack: { fontSize: 12, ...font(600), color: NIGHT.blue[0], marginTop: 2 },

    // ── The month, as one card ──
    hero: {
      ...glass,
      borderRadius: radius.lg,
      padding: spacing.md + 4,
      marginBottom: spacing.sm,
    },
    heroKicker: {
      fontSize: 12,
      ...font(700),
      color: colors.textMuted,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    heroValue: {
      fontSize: 40,
      ...font(700),
      color: colors.text,
      letterSpacing: -1.2,
      marginTop: 2,
    },
    splitTrack: {
      flexDirection: 'row',
      height: 8,
      borderRadius: 4,
      overflow: 'hidden',
      marginTop: spacing.md,
    },
    /**
     * The expense half is the ground the income half lies on: the remainder of
     * the bar is the other number, so the two never meet at a seam. It is the
     * same yellow the expense rows are edged with, so the bar and the lists
     * under it speak one set of colours.
     *
     * A view of its own rather than the track's colour so it can grow with the
     * income half as the page opens; rounded itself so its growing end is too.
     */
    splitOut: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      borderRadius: 4,
      backgroundColor: AURA.yellow.ink,
    },
    splitIn: { height: '100%', backgroundColor: AURA.green.ink },
    heroLegend: { flexDirection: 'row', gap: spacing.md, marginTop: 10 },
    legendItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendLabel: { fontSize: 12, ...font(600), color: colors.textMuted },
    legendValue: { flex: 1, fontSize: 13, ...font(700), color: colors.text, textAlign: 'right' },
    heroDebtRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing.md },
    heroDebt: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: 100,
      paddingHorizontal: 11,
      paddingVertical: 6,
    },
    heroDebtText: { fontSize: 13, ...font(600), color: colors.text },
    /** Hugs the pills, so their entrance scales from them and not the card's middle. */
    heroDebtSlot: { alignSelf: 'flex-start' },

    // ── Insight and breakdown cards ──
    card: {
      ...glass,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.sm,
      gap: 10,
    },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { flex: 1, fontSize: 15, ...font(700), color: colors.text },
    cardAction: { fontSize: 13, ...font(600), color: NIGHT.blue[0] },
    insightRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    insightDot: { width: 7, height: 7, borderRadius: 4, marginHorizontal: 3.5 },
    insightText: { flex: 1, fontSize: 14, lineHeight: 19, ...font(500), color: colors.text },
    catRow: { gap: 6 },
    catLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    catName: { flex: 1, fontSize: 14, ...font(600), color: colors.text },
    catAmount: { fontSize: 13, ...font(700), color: colors.textMuted },
    catTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: NIGHT.cardAlt,
      overflow: 'hidden',
    },
    catFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 3 },

    // ── Search ──
    searchRow: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: 100,
      paddingHorizontal: 16,
      minHeight: 46,
      marginTop: spacing.xs,
    },
    searchInput: {
      flex: 1,
      fontSize: 15,
      ...font(500),
      color: colors.text,
      paddingVertical: 10,
    },

    // ── Lists ──
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginTop: spacing.lg - 2,
      marginBottom: spacing.sm + 2,
    },
    sectionTitle: { flex: 1, fontSize: 21, ...font(700), color: colors.text, letterSpacing: -0.4 },

    row: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 60,
      borderRadius: 13,
      paddingVertical: 9,
      paddingHorizontal: 18,
      marginBottom: 7,
      overflow: 'hidden',
    },
    /**
     * The list a row belongs to, in that list's ink down its leading edge, so a
     * scroll says which list you are in without stopping to read the heading.
     */
    rowEdge: {
      position: 'absolute',
      top: 3,
      bottom: 3,
      width: 4,
      borderRadius: 2,
    },
    rowBody: { flex: 1, gap: 2 },
    rowTitle: { fontSize: 16, ...font(600), color: colors.text },
    rowTitleSettled: { textDecorationLine: 'line-through', color: colors.textMuted },
    rowMetaLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    rowMeta: { flexShrink: 1, fontSize: 14, ...font(500), color: colors.textMuted },
    amount: { fontSize: 16, ...font(700), letterSpacing: -0.3 },
    amountSettled: { textDecorationLine: 'line-through', color: colors.textMuted },

    tick: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tickOpen: { borderWidth: 2, borderColor: NIGHT.tickRing },

    // ── Who the debt is with ──
    who: {
      width: 30,
      height: 30,
      borderRadius: 15,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: NIGHT.cardAlt,
    },
    whoText: { fontSize: 13, ...font(700) },
    /** A direction's own heading, with what it comes to on the end. */
    debtHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 4,
      marginTop: 6,
      marginBottom: spacing.sm,
    },
    debtDot: { width: 8, height: 8, borderRadius: 4 },
    debtHeadText: { flex: 1, fontSize: 15, ...font(700), color: colors.text },
    debtHeadTotal: { fontSize: 15, ...font(700) },

    /** An empty list keeps a row's place, so the page doesn't jump when one lands. */
    empty: {
      ...glass,
      minHeight: 60,
      borderRadius: 13,
      paddingHorizontal: 18,
      justifyContent: 'center',
    },
    emptyLine: { fontSize: 15, ...font(500), color: colors.textMuted },

    // ── Sheet ──
    backdrop: {
      flex: 1,
      backgroundColor: NIGHT.backdrop,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
    },
    /**
     * The sheet's size, held by the spring it comes in on. The percentages have
     * to live on the outermost box: inside it they would measure against a
     * wrapper that is only as tall as its content, and the cap would never bite.
     */
    sheetFrame: { width: '100%', maxWidth: 420, maxHeight: '88%' },
    /** Opaque, unlike the glass on the page: nothing should show through a form. */
    sheet: {
      // Shrinks to the frame's cap, so the fields scroll rather than overflow.
      flexShrink: 1,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: 28,
      padding: spacing.md + 4,
    },
    sheetHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: spacing.sm,
    },
    sheetTitle: { flex: 1, fontSize: 20, ...font(700), color: colors.text, letterSpacing: -0.4 },
    sheetClose: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetBody: { flexGrow: 0 },

    fieldLabel: {
      ...font(600),
      fontSize: 13,
      color: colors.textMuted,
      marginBottom: 7,
      marginTop: 12,
    },
    hintLine: { ...font(500), fontSize: 13, color: colors.textMuted, marginBottom: 6 },
    input: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 13,
      fontSize: 15,
      ...font(500),
      color: colors.text,
    },
    inputBad: { borderColor: colors.danger, borderWidth: 1 },

    // ── Date ──
    dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dateArrow: {
      width: 44,
      height: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    dateInput: { flex: 1, textAlign: 'center' },
    dateChips: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
    dateWeekday: { fontSize: 13, ...font(600), color: colors.textMuted },
    miniChip: {
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: 50,
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    miniChipOn: { backgroundColor: NIGHT.blue[1], borderColor: NIGHT.blue[1] },
    miniChipText: { ...font(600), fontSize: 12, color: colors.textMuted },

    // ── Repeats ──
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: spacing.md,
      paddingVertical: 4,
    },
    switchTitle: { fontSize: 15, ...font(600), color: colors.text },
    switchHint: { fontSize: 12, ...font(500), color: colors.textMuted, marginTop: 1 },

    // ── Budgets ──
    budgetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 6,
    },
    budgetName: { fontSize: 15, ...font(600), color: colors.text },
    budgetSpent: { fontSize: 12, ...font(500), color: colors.textMuted, marginTop: 1 },
    budgetInput: { width: 120, paddingVertical: 10, textAlign: 'center' },

    seg: { ...glass, flexDirection: 'row', height: 46, borderRadius: 13 },
    segCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    /**
     * The chosen side's fill, a hair past its cell so it covers the rail's edge.
     * It is the holder the fill springs in on, and carries the glow so the glow
     * arrives with it. No elevation: on Android that would lift the fill over
     * its own label.
     */
    segOn: {
      top: -1,
      bottom: -1,
      left: -1,
      right: -1,
      borderRadius: 12,
      backgroundColor: NIGHT.blue[1],
      ...blueGlow,
    },
    /** The gradient rounds itself, since its holder doesn't clip. */
    segFill: { borderRadius: 12 },
    segText: { ...font(600), fontSize: 14, color: colors.textMuted },

    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      paddingHorizontal: 13,
      paddingVertical: 9,
      borderRadius: 50,
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    /**
     * The chosen chip keeps its own grey under the fill, so the blue has
     * something to spring in over. Android's glow is still the chip's elevation,
     * tinted by the shadow colour; iOS draws the glow from the fill (`chipOn`),
     * and ignores a shadow colour with no opacity here.
     */
    chipActive: {
      borderColor: 'transparent',
      shadowColor: NIGHT.blue[1],
      elevation: 6,
    },
    /**
     * The chosen chip's fill, out over its hairline so no grey ring shows round
     * the blue. No elevation, as with `segOn`.
     */
    chipOn: {
      top: -StyleSheet.hairlineWidth,
      bottom: -StyleSheet.hairlineWidth,
      left: -StyleSheet.hairlineWidth,
      right: -StyleSheet.hairlineWidth,
      borderRadius: 50,
      backgroundColor: NIGHT.blue[1],
      ...blueGlow,
    },
    chipFill: { borderRadius: 50 },
    chipText: { ...font(600), fontSize: 13, color: colors.textMuted },
    chipTextActive: { ...font(700), color: colors.primaryText },

    /**
     * The same pill as `ui`'s primary Button, drawn here rather than used from
     * there because that one doesn't announce itself as a button.
     */
    saveBtn: {
      marginTop: spacing.md,
      borderRadius: 100,
      paddingVertical: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.45,
      shadowRadius: 14,
      elevation: 6,
    },
    saveFill: { borderRadius: 100 },
    saveText: { ...font(600), fontSize: 16, color: colors.primaryText },
  }),
);
