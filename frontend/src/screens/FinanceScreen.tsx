import { useCallback, useMemo, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  Modal,
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
  RotateCcw,
  Settings2,
} from 'lucide-react-native';

import { Screen } from '../components/ui';
import { Entrance } from '../components/motion';
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
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, radius, AURA, IRIDESCENT } from '../theme';
import { t, locale, alignStart } from '../lib/i18n';

// Where the money is. A summary, then income, expenses and debts — enough to
// answer "can I afford this", and deliberately not an accounting package.
//
// It replaces the profile screen and keeps that screen's furniture: the same
// headline, the same Card-like blocks, the same chips and inputs.

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Which list a sheet is editing. */
type Editor =
  | { kind: 'income' | 'expense'; entry: MoneyEntry | null }
  | { kind: 'debt'; entry: Debt | null };

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
  debt,
  money,
}: {
  balance: number;
  income: number;
  expenses: number;
  debt: number;
  money: (n: number) => string;
}) {
  const start = { textAlign: alignStart() } as const;
  const total = income + expenses;
  // Guarded: an empty month would divide by zero and render a NaN width.
  const inShare = total > 0 ? (income / total) * 100 : 50;

  return (
    <LinearGradient
      colors={IRIDESCENT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.hero}
    >
      <Text style={[styles.heroKicker, start]}>{t('fin.balance')}</Text>
      <Text
        style={[styles.heroValue, start]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      >
        {money(balance)}
      </Text>

      {/* Income against outgoings, as one bar rather than two figures. */}
      <View style={styles.splitTrack}>
        <View style={[styles.splitIn, { width: `${inShare}%` }]} />
      </View>

      <View style={styles.heroLegend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: AURA.green.ink }]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {t('fin.income')}
          </Text>
          <Text style={styles.legendValue} numberOfLines={1}>
            {money(income)}
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {t('fin.expenses')}
          </Text>
          <Text style={styles.legendValue} numberOfLines={1}>
            {money(expenses)}
          </Text>
        </View>
      </View>

      {/* Debt qualifies the balance rather than standing beside it, so it sits
          on the same card as a footnote instead of taking a quarter of the
          grid. Hidden entirely when there is none — a zero is noise. */}
      {debt !== 0 ? (
        <View style={styles.heroDebt}>
          <Handshake color={colors.text} size={14} strokeWidth={2.2} />
          <Text style={styles.heroDebtText} numberOfLines={1}>
            {t('fin.debts')} · {money(debt)}
          </Text>
        </View>
      ) : null}
    </LinearGradient>
  );
}

export default function FinanceScreen() {
  const navigation = useNavigation<Nav>();
  const [entries, setEntries] = useState<MoneyEntry[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);

  // Sheet fields, held apart from the row until Save.
  const [fDesc, setFDesc] = useState('');
  const [fAmount, setFAmount] = useState('');
  const [fDate, setFDate] = useState(toDateStr(new Date()));
  const [fCat, setFCat] = useState<IncomeCategory | ExpenseCategory | null>(null);
  const [fPerson, setFPerson] = useState('');
  const [fDirection, setFDirection] = useState<'owe' | 'owed'>('owe');

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const [{ entries: e }, { debts: d }, prof] = await Promise.all([
          api.listMoney(),
          api.listDebts(),
          storage.getProfile(),
        ]);
        if (!active) return;
        setEntries(e);
        setDebts(d);
        setCurrency(prof.currency);
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const totals = useMemo(() => {
    const income = entries
      .filter((e) => e.kind === 'income')
      .reduce((sum, e) => sum + e.amount, 0);
    const expenses = entries
      .filter((e) => e.kind === 'expense')
      .reduce((sum, e) => sum + e.amount, 0);
    // Only what is still open counts as debt; a settled row is history.
    const debtTotal = debts
      .filter((d) => !d.isSettled)
      .reduce((sum, d) => sum + (d.direction === 'owe' ? d.amount : -d.amount), 0);
    return { income, expenses, balance: income - expenses, debtTotal };
  }, [entries, debts]);

  const byDate = <T extends { date: string; createdAt: string }>(a: T, b: T) =>
    b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

  const income = useMemo(
    () => entries.filter((e) => e.kind === 'income').sort(byDate),
    [entries],
  );
  const expenses = useMemo(
    () => entries.filter((e) => e.kind === 'expense').sort(byDate),
    [entries],
  );
  const sortedDebts = useMemo(
    () => [...debts].sort((a, b) => Number(a.isSettled) - Number(b.isSettled) || byDate(a, b)),
    [debts],
  );

  // ── Opening the sheet ──

  const openMoney = (kind: 'income' | 'expense', entry: MoneyEntry | null) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFDesc(entry?.description ?? '');
    setFAmount(entry ? String(entry.amount) : '');
    setFDate(entry?.date ?? toDateStr(new Date()));
    setFCat(entry?.category ?? null);
    setEditor({ kind, entry });
  };

  const openDebt = (debt: Debt | null) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFPerson(debt?.person ?? '');
    setFAmount(debt ? String(debt.amount) : '');
    setFDesc(debt?.description ?? '');
    setFDate(debt?.date ?? toDateStr(new Date()));
    setFDirection(debt?.direction ?? 'owe');
    setEditor({ kind: 'debt', entry: debt });
  };

  // ── Saving ──

  const save = async () => {
    if (!editor) return;
    const amount = Number(fAmount.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert(t('fin.missingAmount'), t('fin.missingAmountBody'));
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
        load();
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
      if (editor.entry) {
        await api.updateMoneyEntry(editor.entry.id, {
          description,
          amount,
          date: fDate,
          category: fCat,
          updatedAt: stamp,
        });
      } else {
        await api.createMoneyEntry({
          id: uuid(),
          kind: editor.kind,
          description,
          amount,
          date: fDate,
          category: fCat,
          updatedAt: stamp,
        });
      }
      setEditor(null);
      load();
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
          setEntries((prev) => prev.filter((r) => r.id !== entry.id));
          try {
            await api.deleteMoneyEntry(entry.id);
          } catch {
            load();
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
          setDebts((prev) => prev.filter((r) => r.id !== debt.id));
          try {
            await api.deleteDebt(debt.id);
          } catch {
            load();
          }
        },
      },
    ]);
  };

  const toggleSettled = async (debt: Debt) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = !debt.isSettled;
    setDebts((prev) => prev.map((r) => (r.id === debt.id ? { ...r, isSettled: next } : r)));
    try {
      await api.updateDebt(debt.id, { isSettled: next, updatedAt: new Date().toISOString() });
    } catch {
      load();
    }
  };

  const money = moneyIn(currency);
  const start = { textAlign: alignStart() } as const;
  const catList: readonly string[] =
    editor?.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const catPrefix = editor?.kind === 'income' ? 'fin.inc' : 'fin.exp';

  const sheetTitle = !editor
    ? ''
    : editor.kind === 'debt'
      ? t(editor.entry ? 'fin.editDebt' : 'fin.addDebt')
      : editor.kind === 'income'
        ? t(editor.entry ? 'fin.editIncome' : 'fin.addIncome')
        : t(editor.entry ? 'fin.editExpense' : 'fin.addExpense');

  return (
    <Screen>
      {/* The headline keeps a gear beside it: Finance took this tab from the
          profile screen, and the language picker and the hours the assistant
          schedules around still live there. */}
      <View style={styles.headerRow}>
        <Text style={[styles.headline, start]}>{t('fin.title')}</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            navigation.navigate('Settings');
          }}
          style={styles.gearBtn}
          accessibilityRole="button"
          accessibilityLabel={t('tab.profile')}
        >
          <Settings2 color={colors.text} size={20} strokeWidth={2} />
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* ── The month, as one card ── */}
        <Entrance delay={40} from={20}>
          <BalanceCard
            balance={totals.balance}
            income={totals.income}
            expenses={totals.expenses}
            debt={totals.debtTotal}
            money={money}
          />
        </Entrance>

        {/* ── Income ── */}
        <Entrance delay={110}>
          <View style={[styles.section, { borderStartColor: AURA.green.ink }]}>
            <View style={styles.sectionHead}>
              <View style={[styles.sectionIcon, { backgroundColor: AURA.green.tint }]}>
                <TrendingUp color={AURA.green.ink} size={17} strokeWidth={2.2} />
              </View>
              <Text style={[styles.sectionTitle, start]}>{t('fin.income')}</Text>
              <Pressable
                onPress={() => openMoney('income', null)}
                style={styles.addChip}
                accessibilityRole="button"
                accessibilityLabel={t('fin.addIncome')}
              >
                <Plus color={colors.primaryText} size={17} strokeWidth={2.6} />
              </Pressable>
            </View>

            {income.length === 0 ? (
              <Text style={[styles.emptyLine, start]}>{t('fin.empty.income')}</Text>
            ) : (
              income.map((e) => (
                <Pressable
                  key={e.id}
                  onPress={() => openMoney('income', e)}
                  style={styles.row}
                  accessibilityRole="button"
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, start]} numberOfLines={1}>
                      {e.description}
                    </Text>
                    <Text style={[styles.rowMeta, start]} numberOfLines={1}>
                      {shortDate(e.date)}
                      {e.category ? ` · ${t(`fin.inc.${e.category}`)}` : ''}
                    </Text>
                  </View>
                  <Text style={[styles.amount, { color: AURA.green.ink }]}>+{money(e.amount)}</Text>
                  <Pressable onPress={() => deleteEntry(e)} hitSlop={8} accessibilityRole="button">
                    <Trash2 color={colors.textMuted} size={16} />
                  </Pressable>
                </Pressable>
              ))
            )}
          </View>
        </Entrance>

        {/* ── Expenses ── */}
        <Entrance delay={170}>
          <View style={[styles.section, { borderStartColor: AURA.yellow.ink }]}>
            <View style={styles.sectionHead}>
              <View style={[styles.sectionIcon, { backgroundColor: AURA.yellow.tint }]}>
                <TrendingDown color={AURA.yellow.ink} size={17} strokeWidth={2.2} />
              </View>
              <Text style={[styles.sectionTitle, start]}>{t('fin.expenses')}</Text>
              <Pressable
                onPress={() => openMoney('expense', null)}
                style={styles.addChip}
                accessibilityRole="button"
                accessibilityLabel={t('fin.addExpense')}
              >
                <Plus color={colors.primaryText} size={17} strokeWidth={2.6} />
              </Pressable>
            </View>

            {expenses.length === 0 ? (
              <Text style={[styles.emptyLine, start]}>{t('fin.empty.expenses')}</Text>
            ) : (
              expenses.map((e) => (
                <Pressable
                  key={e.id}
                  onPress={() => openMoney('expense', e)}
                  style={styles.row}
                  accessibilityRole="button"
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, start]} numberOfLines={1}>
                      {e.description}
                    </Text>
                    <Text style={[styles.rowMeta, start]} numberOfLines={1}>
                      {shortDate(e.date)}
                      {e.category ? ` · ${t(`fin.exp.${e.category}`)}` : ''}
                    </Text>
                  </View>
                  <Text style={[styles.amount, { color: AURA.yellow.ink }]}>
                    −{money(e.amount)}
                  </Text>
                  <Pressable onPress={() => deleteEntry(e)} hitSlop={8} accessibilityRole="button">
                    <Trash2 color={colors.textMuted} size={16} />
                  </Pressable>
                </Pressable>
              ))
            )}
          </View>
        </Entrance>

        {/* ── Debts ── */}
        <Entrance delay={230}>
          <View style={[styles.section, { borderStartColor: AURA.blue.ink }]}>
            <View style={styles.sectionHead}>
              <View style={[styles.sectionIcon, { backgroundColor: AURA.blue.tint }]}>
                <Handshake color={AURA.blue.ink} size={17} strokeWidth={2.2} />
              </View>
              <Text style={[styles.sectionTitle, start]}>{t('fin.debts')}</Text>
              <Pressable
                onPress={() => openDebt(null)}
                style={styles.addChip}
                accessibilityRole="button"
                accessibilityLabel={t('fin.addDebt')}
              >
                <Plus color={colors.primaryText} size={17} strokeWidth={2.6} />
              </Pressable>
            </View>

            {sortedDebts.length === 0 ? (
              <Text style={[styles.emptyLine, start]}>{t('fin.empty.debts')}</Text>
            ) : (
              sortedDebts.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => openDebt(d)}
                  style={[styles.row, d.isSettled && styles.rowSettled]}
                  accessibilityRole="button"
                >
                  <Pressable
                    onPress={() => toggleSettled(d)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t(d.isSettled ? 'fin.markUnpaid' : 'fin.markPaid')}
                  >
                    <View style={[styles.settleBtn, d.isSettled && styles.settleBtnDone]}>
                      {d.isSettled ? (
                        <RotateCcw color={colors.textMuted} size={14} strokeWidth={2.4} />
                      ) : (
                        <Check color={colors.text} size={14} strokeWidth={2.8} />
                      )}
                    </View>
                  </Pressable>

                  <View style={{ flex: 1 }}>
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
                      // Owing is the only figure here that should feel like a
                      // pull on the balance; being owed is neutral good news.
                      { color: d.direction === 'owe' ? colors.danger : AURA.green.ink },
                      d.isSettled && styles.amountSettled,
                    ]}
                  >
                    {money(d.amount)}
                  </Text>
                  <Pressable onPress={() => deleteDebt(d)} hitSlop={8} accessibilityRole="button">
                    <Trash2 color={colors.textMuted} size={16} />
                  </Pressable>
                </Pressable>
              ))
            )}
          </View>
        </Entrance>
      </ScrollView>

      {/* ── One sheet, three shapes ── */}
      <Modal
        visible={editor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditor(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setEditor(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, start]}>{sheetTitle}</Text>
              <Pressable
                onPress={() => setEditor(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('notes.close')}
              >
                <X color={colors.textMuted} size={20} />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetBody}>
              {editor?.kind === 'debt' ? (
                <>
                  <Text style={[styles.fieldLabel, start]}>{t('fin.person')}</Text>
                  <TextInput
                    value={fPerson}
                    onChangeText={setFPerson}
                    placeholder={t('fin.personHint')}
                    placeholderTextColor={colors.textMuted}
                    style={[styles.input, start]}
                    autoFocus
                  />

                  <Text style={[styles.fieldLabel, start]}>{t('fin.category')}</Text>
                  <View style={styles.chipWrap}>
                    {(['owe', 'owed'] as const).map((dir) => {
                      const active = fDirection === dir;
                      return (
                        <Pressable
                          key={dir}
                          onPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            setFDirection(dir);
                          }}
                          style={[styles.chip, active && styles.chipActive]}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
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
              />

              <Text style={[styles.fieldLabel, start]}>{t('fin.date')}</Text>
              <TextInput
                value={fDate}
                onChangeText={setFDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, start]}
              />

              {editor?.kind === 'debt' ? (
                <>
                  <Text style={[styles.fieldLabel, start]}>{t('fin.description')}</Text>
                  <TextInput
                    value={fDesc}
                    onChangeText={setFDesc}
                    style={[styles.input, start]}
                    placeholderTextColor={colors.textMuted}
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
                            setFCat(cat as IncomeCategory | ExpenseCategory);
                          }}
                          style={[styles.chip, active && styles.chipActive]}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
                            {t(`${catPrefix}.${cat}`)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}
            </ScrollView>

            <Pressable onPress={save} style={styles.saveBtn} accessibilityRole="button">
              <Text style={styles.saveText}>{t('profile.save')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gearBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  headline: {
    fontSize: 32,
    ...font(700),
    color: colors.text,
    letterSpacing: -0.8,
    marginBottom: spacing.md,
  },
  content: { paddingBottom: spacing.md },

  // ── The month, as one card ──
  hero: {
    borderRadius: radius.lg,
    padding: spacing.md + 4,
    marginBottom: spacing.sm,
  },
  heroKicker: {
    fontSize: 12,
    ...font(700),
    color: colors.text,
    opacity: 0.6,
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
    // The remainder of the track is the expense half, so the bar needs no
    // second filled view — the ground colour is the other number.
    backgroundColor: colors.primary,
    overflow: 'hidden',
    marginTop: spacing.md,
  },
  splitIn: { height: '100%', backgroundColor: AURA.green.ink },
  heroLegend: { flexDirection: 'row', gap: spacing.md, marginTop: 10 },
  legendItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 12, ...font(600), color: colors.text, opacity: 0.65 },
  legendValue: { flex: 1, fontSize: 13, ...font(700), color: colors.text, textAlign: 'right' },
  heroDebt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 100,
    paddingHorizontal: 11,
    paddingVertical: 6,
    marginTop: spacing.md,
  },
  heroDebtText: { fontSize: 12.5, ...font(700), color: colors.text },

  // ── Summary ──

  // ── Sections ──
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    // A coloured spine down the leading edge, so a scroll says which list you
    // are in without stopping to read the heading.
    borderStartWidth: 4,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  sectionIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: { flex: 1, fontSize: 17, ...font(700), color: colors.text },
  addChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowSettled: { opacity: 0.55 },
  rowTitle: { fontSize: 15, ...font(600), color: colors.text },
  rowTitleSettled: { textDecorationLine: 'line-through' },
  rowMeta: { fontSize: 12, ...font(500), color: colors.textMuted, marginTop: 2 },
  amount: { fontSize: 15.5, ...font(700), letterSpacing: -0.3 },
  amountSettled: { textDecorationLine: 'line-through' },

  settleBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settleBtnDone: { backgroundColor: 'transparent' },

  emptyLine: {
    fontSize: 13.5,
    ...font(500),
    color: colors.textMuted,
    paddingVertical: spacing.md,
  },

  // ── Sheet ──
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 21, 15, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: spacing.sm,
  },
  sheetTitle: { flex: 1, fontSize: 19, ...font(700), color: colors.text },
  sheetBody: { flexGrow: 0 },

  fieldLabel: {
    ...font(600),
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 7,
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    ...font(500),
    color: colors.text,
  },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 50,
    backgroundColor: colors.surfaceAlt,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { ...font(600), fontSize: 13, color: colors.text },
  chipTextActive: { color: colors.primaryText },

  saveBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: 100,
    paddingVertical: 15,
    alignItems: 'center',
  },
  saveText: { ...font(700), fontSize: 15.5, color: colors.primaryText },
});
