import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  StyleSheet,
  Alert,
  Modal,
  Animated,
  Share,
  Switch,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import {
  ChevronLeft,
  Plus,
  Check,
  X,
  Trash2,
  ShoppingCart,
  ChevronDown,
  Share2,
  Sparkles,
  Wallet,
  ChartPie,
} from 'lucide-react-native';

import { Screen, LitDisc } from '../components/ui';
import {
  CountUp,
  Entrance,
  PopIn,
  Pressable,
  animateLayout,
  useFloat,
  useGrow,
  useReducedMotion,
} from '../components/motion';
import { LinearGradient } from 'expo-linear-gradient';
import {
  api,
  uuid,
  SHOPPING_CATEGORIES,
  type ShoppingItem,
  type ShoppingCategory,
} from '../lib/api';
import {
  itemEmoji,
  listAsText,
  parseQuickAdd,
  sameItem,
  suggestionsFrom,
  type ShoppingHistory,
  type Suggestion,
} from '../lib/shopping';
import { estimateCart, learnFactor } from '../lib/prices';
import { formatMoney } from '../lib/currency';
import { storage } from '../lib/storage';
import { toDateStr } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import {
  colors,
  spacing,
  font,
  AURA,
  AURA_CYCLE,
  IRIDESCENT,
  NIGHT,
  TAB_BAR_CLEARANCE,
  themed,
} from '../theme';
import { t, locale, alignStart, startAt, endAt, isRTL } from '../lib/i18n';

// The shopping list. One job, done fast: type a thing, tick it off in the
// aisle, clear the trolley at the till.
//
// It replaces the notes board and keeps that screen's furniture — the same
// header, headline and empty state — so it reads as the screen that was always
// there rather than a bolted-on module. On the dark it borrows Home's pieces:
// the headline stands on the page, and each thing to buy is one of Home's
// glass rows, its edge in the colour of its aisle.

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ── How the page builds ──
// Header, headline, bar and quick add come in first, and the list follows in
// reading order: each aisle's heading, then its rows, then the trolley.

/** When the list starts building, once the quick add above it is on its way. */
const LIST_AT = 190;
/** When a row that arrives after the page has built starts, see `settled`. */
const SETTLED_AT = 40;
/** The gap between one thing in the list and the next. */
const STAGGER = 45;
/** Past this many, the rest come in together rather than keeping a long queue. */
const STAGGER_CAP = 8;
/** Long enough for the slowest entrance above to have come to rest. */
const BUILD_MS = 1000;

/**
 * How long a tapped tick shows in its row before the row moves to the other
 * list. Long enough to see the disc land; short enough that ticking down a
 * list at speed never waits on it.
 */
const TICK_BEAT = 320;

/**
 * For a count that is only on the page while there is something to count —
 * the badge, an aisle's heading, the trolley. Running up as the page opens,
 * it starts at one, so it never says 0 where 0 can't be the answer.
 */
const countFromOne = (n: number) => String(Math.max(1, Math.round(n)));

/** Categories borrow the gradient family, cycling in its own order. */
function categoryTint(cat: ShoppingCategory | null) {
  if (!cat) return null;
  const i = SHOPPING_CATEGORIES.indexOf(cat);
  // A category from outside the list lands here as -1, and `AURA_CYCLE[-1]` is
  // undefined — reading `.ink` off that is a hard crash. The type says it
  // cannot happen; a row written by an older build says otherwise.
  if (i === -1) return null;
  return AURA[AURA_CYCLE[i % AURA_CYCLE.length]];
}

/**
 * A row that ticks: the tick, the text, and a delete on the end. The edge at
 * the start is the aisle's colour, and it goes once the thing is in the
 * trolley — the way a done row loses its edge on Home.
 */
function ItemRow({
  item,
  price,
  delay,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: ShoppingItem;
  /** What one of the row is likely to cost, formatted in the user's currency,
   *  or null when there is no currency yet or the row has no price. */
  price: string | null;
  /** When it enters; the screen works this out from where the row sits. */
  delay: number;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const aura = categoryTint(item.category);
  const start = { textAlign: alignStart() } as const;
  const reduce = useReducedMotion();

  // A ticked row moves to the trolley by being built again there — a new row
  // under a different heading, not this one travelling. Toggled on the tap,
  // this one would fade out still open and the tick would never be seen to
  // land. So the tap is shown here first, and the row moves a beat later.
  const [held, setHeld] = useState<boolean | null>(null);
  const beat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checked = held ?? item.isBought;

  // The mark springs rather than snapping — the one flourish on the row, and
  // the only feedback that the tap landed while a phone is in a trolley. A row
  // that arrives already ticked, opening the trolley, springs its mark in too.
  const pop = useRef(new Animated.Value(reduce && item.isBought ? 1 : 0)).current;
  useEffect(() => {
    const to = checked ? 1 : 0;
    if (reduce) {
      pop.setValue(to);
      return;
    }
    const anim = Animated.spring(pop, {
      toValue: to,
      friction: 6,
      tension: 90,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [checked, reduce, pop]);

  const tick = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Nothing to watch land, so nothing to wait for.
    if (reduce) {
      onToggle();
      return;
    }
    // A second tap inside the beat is a change of mind: the tick goes back
    // and the row stays where it is.
    if (beat.current) {
      clearTimeout(beat.current);
      beat.current = null;
      setHeld(null);
      return;
    }
    setHeld(!item.isBought);
    // Not cleared if the row goes first: the tap still counts.
    beat.current = setTimeout(() => {
      beat.current = null;
      setHeld(null);
      onToggle();
    }, TICK_BEAT);
  };

  return (
    <Entrance delay={delay}>
      <View style={styles.row}>
        {aura && !checked ? (
          <View style={[styles.rowEdge, startAt(0), { backgroundColor: aura.ink }]} />
        ) : null}

        <Pressable
          onPress={tick}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={item.name}
        >
          {/* The disc pops in under the mark as the mark springs, both on the
              tap, so it reads as landed before the row moves on. */}
          <View style={[styles.tick, !checked && styles.tickOpen]}>
            {checked ? (
              <PopIn style={[StyleSheet.absoluteFill, styles.tickFill]}>
                <LinearGradient
                  colors={NIGHT.discs.tasks}
                  start={{ x: 0.15, y: 0.1 }}
                  end={{ x: 0.85, y: 0.95 }}
                  style={[StyleSheet.absoluteFill, styles.tickFill]}
                />
              </PopIn>
            ) : null}
            <Animated.View style={{ transform: [{ scale: pop }], opacity: pop }}>
              <Check color={NIGHT.glyph} size={13} strokeWidth={3} />
            </Animated.View>
          </View>
        </Pressable>

        <Pressable style={styles.rowBody} onPress={onEdit} accessibilityRole="button">
          <View style={styles.rowTitleLine}>
            {/* What the thing is, before its name. Out of the reading order:
                the row already says the name, and "leafy green" read out after
                it is noise. It fades with the title once the thing is in. */}
            <Text
              style={[styles.rowEmoji, checked && styles.rowEmojiDone]}
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              {itemEmoji(item)}
            </Text>
            <Text
              style={[styles.rowTitle, start, checked && styles.rowTitleDone]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
            {item.quantity ? (
              <View style={styles.qtyChip}>
                <Text style={styles.qtyText} numberOfLines={1}>
                  {item.quantity}
                </Text>
              </View>
            ) : null}
            {/* The market-price guess for this row, next to its quantity —
                so a glance across the list says what each thing will cost
                as well as what it is, and the trolley total below the
                heading is a sum of numbers already on the page. */}
            {price && !checked ? (
              <View style={styles.priceChip}>
                <Text style={styles.priceText} numberOfLines={1}>
                  {price}
                </Text>
              </View>
            ) : null}
          </View>

          {/* The category is the group heading and the edge, so a row only
              carries what is particular to it. */}
          {item.note ? (
            <Text style={[styles.rowNote, start]} numberOfLines={1}>
              {item.note}
            </Text>
          ) : null}
        </Pressable>

        <Pressable
          onPress={onDelete}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.delete')}
        >
          <Trash2 color={colors.textMuted} size={20} strokeWidth={1.7} />
        </Pressable>
      </View>
    </Entrance>
  );
}

export default function ShoppingScreen() {
  const navigation = useNavigation<Nav>();
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<ShoppingItem | null>(null);

  // The edit sheet's fields, held apart from the row until Save.
  const [fName, setFName] = useState('');
  const [fQty, setFQty] = useState('');
  const [fNote, setFNote] = useState('');
  const [fCat, setFCat] = useState<ShoppingCategory | null>(null);

  /** What has been bought before — the ground the suggestions grow from. */
  const [history, setHistory] = useState<ShoppingHistory>({});
  /** What money to price the trolley in, and how far off the table has been. */
  const [currency, setCurrency] = useState<string | null>(null);
  const [priceFactor, setPriceFactor] = useState(1);
  const [showEstimates, setShowEstimates] = useState(false);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const [{ items: rows }, past, profile, factor, settings] = await Promise.all([
          api.listShopping(),
          api.shoppingHistory(),
          storage.getProfile(),
          api.getPriceFactor(),
          storage.getSettings(),
        ]);
        if (!active) return;
        setItems(rows);
        setHistory(past);
        setCurrency(profile.currency);
        setPriceFactor(factor);
        setShowEstimates(settings.shoppingEstimates);
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.shoppingHistory());
    } catch {
      /* the suggestions just stay as they were */
    }
  }, []);

  // ── A line under the quick add that says what just happened ──
  // Typing several things at once, or something already there, needs saying:
  // otherwise "milk" vanishing from the field and no new row looks broken.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const [inputFocused, setInputFocused] = useState(false);

  const suggestions = useMemo(() => suggestionsFrom(history, items), [history, items]);

  // The checkout sheet: open while clearing the trolley asks what it cost.
  const [checkout, setCheckout] = useState(false);
  const [spent, setSpent] = useState('');

  /**
   * Whether the page has finished building since it last came into view.
   *
   * Until it has, the list comes in in reading order. After, a row that
   * arrives on its own — typed in, ticked across, the trolley opened — is not
   * made to wait its turn behind rows that are already standing there; it
   * starts at once and staggers only against its own list. Leaving the page
   * resets it, so coming back builds in order again.
   */
  const [settled, setSettled] = useState(false);
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => setSettled(true), BUILD_MS);
      return () => {
        clearTimeout(timer);
        setSettled(false);
      };
    }, []),
  );

  const { toBuy, bought, groups } = useMemo(() => {
    const byNewest = (a: ShoppingItem, b: ShoppingItem) =>
      b.createdAt.localeCompare(a.createdAt);
    const open = items.filter((i) => !i.isBought).sort(byNewest);

    // Grouped by aisle, in the order the categories are declared, so walking
    // the list matches walking the shop. Uncategorised items land last under
    // their own heading rather than being scattered through the others.
    const byCategory = new Map<ShoppingCategory | 'none', ShoppingItem[]>();
    for (const item of open) {
      const key = item.category ?? 'none';
      const bucket = byCategory.get(key);
      if (bucket) bucket.push(item);
      else byCategory.set(key, [item]);
    }
    const ordered: { key: ShoppingCategory | 'none'; items: ShoppingItem[] }[] = [];
    for (const cat of SHOPPING_CATEGORIES) {
      const rows = byCategory.get(cat);
      if (rows?.length) ordered.push({ key: cat, items: rows });
    }
    const none = byCategory.get('none');
    if (none?.length) ordered.push({ key: 'none', items: none });

    return {
      toBuy: open,
      bought: items.filter((i) => i.isBought).sort(byNewest),
      groups: ordered,
    };
  }, [items]);

  /** Whether the trolley is expanded. Collapsed by default — it is history. */
  const [showBought, setShowBought] = useState(false);

  /** How far through the shop, which the bar grows to. */
  const progress = useGrow(items.length ? bought.length / items.length : 0);

  /**
   * What the trolley is likely to come to: everything still to buy, plus what
   * is already in it, so the figure is the shop rather than what is left of it.
   */
  const estimate = useMemo(
    () => estimateCart(items, currency, priceFactor),
    [items, currency, priceFactor],
  );
  /** Just the part still to buy, which is what the bar above is about. */
  const openEstimate = useMemo(
    () => estimateCart(toBuy, currency, priceFactor),
    [toBuy, currency, priceFactor],
  );

  /**
   * A price per row, in the reader's money and rounded — what the row chip
   * shows. Held as a map keyed by id so re-rendering one row does not re-price
   * the whole list, and formatted here so the row component stays free of
   * currency knowledge.
   */
  const rowPrices = useMemo(() => {
    const map = new Map<string, string>();
    if (!showEstimates) return map;
    for (const item of items) {
      const one = estimateCart([item], currency, priceFactor).total;
      if (one > 0) map.set(item.id, t('shop.estimatedPrice', { amount: formatMoney(Math.round(one), currency, locale()) }));
    }
    return map;
  }, [items, currency, priceFactor, showEstimates]);

  /**
   * Puts things on the list, the way a person means them.
   *
   * A typed line can hold several things with their amounts ("2 milk, bread,
   * eggs x12"), each shelved under the aisle its name implies. Something still
   * waiting on the list is not added twice — a new amount updates it — and
   * something already in the trolley comes back out rather than growing a twin.
   */
  const addParsed = async (
    parsed: { name: string; quantity: string | null; note: string | null; category: ShoppingCategory | null }[],
  ) => {
    if (parsed.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const stamp = new Date().toISOString();
    const current = items;
    const creates: ShoppingItem[] = [];
    const patches: { id: string; patch: Partial<ShoppingItem> }[] = [];
    const notes: string[] = [];
    let repeated = false;

    for (const p of parsed) {
      // Two of the same in one line count once.
      if (creates.some((c) => sameItem(c.name, p.name))) continue;
      const existing = current.find((i) => sameItem(i.name, p.name));
      if (existing && !existing.isBought) {
        if (p.quantity && p.quantity !== existing.quantity) {
          patches.push({ id: existing.id, patch: { quantity: p.quantity } });
          notes.push(t('shop.notice.qty', { name: existing.name }));
        } else {
          notes.push(t('shop.notice.already', { name: existing.name }));
          repeated = true;
        }
        continue;
      }
      if (existing) {
        patches.push({
          id: existing.id,
          patch: { isBought: false, ...(p.quantity ? { quantity: p.quantity } : {}) },
        });
        notes.push(t('shop.notice.back', { name: existing.name }));
        continue;
      }
      creates.push({
        id: uuid(),
        name: p.name,
        quantity: p.quantity,
        note: p.note,
        category: p.category,
        isBought: false,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      });
    }

    if (creates.length > 1) notes.unshift(t('shop.notice.added', { count: creates.length }));
    if (notes.length) say(notes.join(' · '));
    if (repeated) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    // Nothing to write: only things that were already there.
    if (creates.length === 0 && patches.length === 0) return;

    // Optimistic: the rows are there before storage answers, so typing
    // several items in a row never waits. The rows below open a space for
    // them rather than jumping down.
    animateLayout();
    setItems((prev) => [
      ...creates,
      ...prev.map((r) => {
        const hit = patches.find((x) => x.id === r.id);
        return hit ? { ...r, ...hit.patch } : r;
      }),
    ]);
    try {
      for (const c of creates) {
        await api.createShoppingItem({
          id: c.id,
          name: c.name,
          quantity: c.quantity,
          note: c.note,
          category: c.category,
          updatedAt: stamp,
        });
      }
      for (const { id, patch } of patches) {
        await api.updateShoppingItem(id, { ...patch, updatedAt: stamp });
      }
      if (patches.some((x) => x.patch.isBought === false)) void refreshHistory();
    } catch (e) {
      load();
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const add = async () => {
    const parsed = parseQuickAdd(draft);
    if (parsed.length === 0) return;
    setDraft('');
    await addParsed(parsed);
  };

  const addSuggestion = (s: Suggestion) =>
    addParsed([{ name: s.name, quantity: null, note: null, category: s.category }]);

  const forgetSuggestion = (s: Suggestion) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(t('shop.suggest.title'), t('shop.suggest.forget', { name: s.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          animateLayout();
          await api.forgetShoppingSuggestion(s.name);
          await refreshHistory();
        },
      },
    ]);
  };

  const shareList = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const text = listAsText(
      t('shop.title'),
      items,
      (k) => (k === 'none' ? t('shop.noCategory') : t(`shop.cat.${k}`)),
      SHOPPING_CATEGORIES,
    );
    try {
      await Share.share({ message: text });
    } catch {
      /* dismissed, or no share sheet on this platform */
    }
  };

  const toggle = async (item: ShoppingItem) => {
    const next = !item.isBought;
    // Out of its aisle and into the trolley, or back: the list closes over
    // the gap it leaves and opens one where it lands.
    animateLayout();
    setItems((prev) => prev.map((r) => (r.id === item.id ? { ...r, isBought: next } : r)));
    try {
      await api.updateShoppingItem(item.id, {
        isBought: next,
        updatedAt: new Date().toISOString(),
      });
      // The tick is history now; the suggestions learn from it.
      void refreshHistory();
    } catch {
      load();
    }
  };

  const confirmDelete = (item: ShoppingItem) => {
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: item.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          animateLayout();
          setItems((prev) => prev.filter((r) => r.id !== item.id));
          try {
            await api.deleteShoppingItem(item.id);
          } catch (e) {
            load();
            Alert.alert(t('common.error'), (e as Error).message);
          }
        },
      },
    ]);
  };

  /**
   * Clearing the trolley is the end of a shop, which is the moment to ask what
   * it cost: the sheet takes the total and files it in Finance, or is skipped.
   */
  const clearBought = () => {
    if (bought.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // A recorded expense must come from the amount actually paid.
    setSpent('');
    setCheckout(true);
  };

  const finishCheckout = async (record: boolean) => {
    const count = bought.length;
    const amount = Number(spent.replace(',', '.'));
    if (record && (!Number.isFinite(amount) || amount <= 0)) {
      Alert.alert(t('fin.missingAmount'), t('fin.missingAmountBody'));
      return;
    }
    // What the table thought this shop would cost, before the rows go: the
    // difference between that and what was paid is the only lesson available
    // about real prices, and it is worth learning from.
    const guessed = estimateCart(bought, currency, priceFactor).total;
    setCheckout(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    animateLayout();
    setItems((prev) => prev.filter((r) => !r.isBought));
    try {
      await api.clearBoughtShopping();
      if (record) {
        const next = learnFactor(priceFactor, guessed, amount);
        if (next !== priceFactor) {
          setPriceFactor(next);
          await api.setPriceFactor(next);
        }
        await api.createMoneyEntry({
          id: uuid(),
          kind: 'expense',
          description: t('shop.checkout.desc', { count }),
          amount,
          date: toDateStr(new Date()),
          category: 'food',
          updatedAt: new Date().toISOString(),
        });
        say(t('shop.checkout.done'));
      }
    } catch (e) {
      load();
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const openEdit = (item: ShoppingItem) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFName(item.name);
    setFQty(item.quantity ?? '');
    setFNote(item.note ?? '');
    setFCat(item.category);
    setEditing(item);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const name = fName.trim();
    if (!name) {
      Alert.alert(t('form.missingTitle'), t('form.missingTitleBody'));
      return;
    }
    const patch = {
      name,
      quantity: fQty.trim() || null,
      note: fNote.trim() || null,
      category: fCat,
      updatedAt: new Date().toISOString(),
    };
    // A new aisle moves the row under another heading; let it travel.
    animateLayout();
    setItems((prev) => prev.map((r) => (r.id === editing.id ? { ...r, ...patch } : r)));
    setEditing(null);
    try {
      await api.updateShoppingItem(editing.id, patch);
    } catch (e) {
      load();
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const start = { textAlign: alignStart() } as const;
  const canAdd = draft.trim().length > 0;

  // Handed out top to bottom as the list renders, so the build follows the
  // reading order whatever aisles are on the list today. `local` is the place
  // in its own list, which is all that counts once the page has settled.
  let order = 0;
  const listDelay = (local: number) => {
    const slot = order++;
    return settled
      ? SETTLED_AT + Math.min(local, STAGGER_CAP) * STAGGER
      : LIST_AT + Math.min(slot, STAGGER_CAP) * STAGGER;
  };

  return (
    <Screen>
      {/* ── Back, and the assistant, exactly where they were ── */}
      <Entrance delay={0} from={12}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() =>
              (
                navigation as unknown as {
                  navigate: (name: string, params: { screen: string }) => void;
                }
              ).navigate('Tabs', { screen: 'Today' })
            }
            style={styles.iconBtn}
            accessibilityRole="button"
          >
            <ChevronLeft color={colors.text} size={22} style={{ transform: [{ scaleX: isRTL() ? -1 : 1 }] }} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.navigate('Stats', { kind: 'shopping' });
            }}
            style={[styles.iconBtn, styles.iconBtnRaised, styles.iconBtnGap]}
            accessibilityRole="button"
            accessibilityLabel={t('stats.button')}
          >
            <ChartPie color={colors.text} size={19} strokeWidth={2} />
          </Pressable>
          {toBuy.length > 0 ? (
            <Pressable
              onPress={shareList}
              style={[styles.iconBtn, styles.iconBtnRaised, styles.iconBtnGap]}
              accessibilityRole="button"
              accessibilityLabel={t('shop.share')}
            >
              <Share2 color={colors.text} size={19} strokeWidth={2} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              navigation.navigate('Assistant');
            }}
            style={[styles.iconBtn, styles.iconBtnRaised]}
            accessibilityRole="button"
            accessibilityLabel={t('voice.title')}
          >
            <Plus color={colors.text} size={22} strokeWidth={2.2} />
          </Pressable>
        </View>
      </Entrance>

      {/* ── How far through the shop you are ──
          A list is a progress bar with words on it, and this is the one fact
          the old headline could not tell you: whether you are nearly done. The
          headline stands on the page as Home's does; the sweep fills the bar. */}
      <View style={styles.headline}>
        <Entrance delay={40} from={16}>
          <View style={styles.headlineTop}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.headlineText, start]}>{t('shop.title')}</Text>
              {/* Only the done count runs: it is the number a tick moves. */}
              <CountUp
                value={bought.length}
                format={(n) =>
                  t('today.completedOf', { done: Math.round(n), total: items.length })
                }
                style={[styles.headlineSub, start]}
              />
            </View>
            <View>
              <LitDisc colors={NIGHT.discs.tasks} size={46}>
                <ShoppingCart color={NIGHT.glyph} size={21} strokeWidth={2.2} />
              </LitDisc>
              {toBuy.length > 0 ? (
                <PopIn style={[styles.badgeCount, endAt(-4)]}>
                  <CountUp
                    value={toBuy.length}
                    format={countFromOne}
                    style={styles.badgeCountText}
                  />
                </PopIn>
              ) : null}
            </View>
          </View>
        </Entrance>

        {/* ── What it is likely to cost ──
            An estimate from typical shelf prices, never a promise, so it is
            written with a ≈ and says how much of it was guessed by aisle. It
            learns: the till total at checkout nudges the whole table. */}
        <View style={styles.estimateRow}>
          <Text style={[styles.estimateNote, start, { flex: 1 }]}>{t('shop.showEstimates')}</Text>
          <Switch value={showEstimates} accessibilityLabel={t('shop.showEstimates')}
            onValueChange={(value) => {
              setShowEstimates(value);
              void storage.getSettings().then((settings) => storage.saveSettings({ ...settings, shoppingEstimates: value }));
            }} />
        </View>
        {showEstimates && items.length > 0 ? (
          <Entrance delay={70} from={12}>
            <View style={styles.estimateRow}>
              <Wallet color={AURA.green.ink} size={15} strokeWidth={2.2} />
              <Text style={[styles.estimateText, start]} numberOfLines={1}>
                {t('shop.estimate', {
                  amount: `≈ ${formatMoney(Math.round(estimate.total), currency, locale())}`,
                })}
              </Text>
              {toBuy.length > 0 && bought.length > 0 ? (
                <Text style={styles.estimateLeft} numberOfLines={1}>
                  {t('shop.estimateLeft', {
                    amount: formatMoney(Math.round(openEstimate.total), currency, locale()),
                  })}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.estimateNote, start]} numberOfLines={1}>
              {estimate.guessed > 0
                ? t('shop.estimateGuessed', { count: estimate.guessed })
                : t('shop.estimateNote')}
            </Text>
          </Entrance>
        ) : null}

        <Entrance delay={90} from={12}>
          <View style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            >
              <LinearGradient
                colors={IRIDESCENT}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[StyleSheet.absoluteFill, styles.progressPaint]}
              />
            </Animated.View>
          </View>
        </Entrance>
      </View>

      {/* ── The quick add, the one thing this screen is for ── */}
      <Entrance delay={140} from={16}>
        <View style={styles.addRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('shop.add.placeholder')}
            placeholderTextColor={colors.textMuted}
            selectionColor={NIGHT.blue[0]}
            style={[styles.addInput, start]}
            returnKeyType="done"
            onSubmitEditing={add}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            // Stays open for the next item: a list is written in bursts.
            blurOnSubmit={false}
          />
          {/* Lit only once there is something to add; until then it sits back
              with the rest of the page rather than glowing at nothing. The
              light pops on with the first letter, the plus with it. */}
          <Pressable
            onPress={add}
            disabled={!canAdd}
            style={[styles.addBtn, !canAdd && styles.addBtnIdle]}
            accessibilityRole="button"
            accessibilityLabel={t('shop.add')}
          >
            {canAdd ? (
              <PopIn style={[StyleSheet.absoluteFill, styles.addBtnFill]}>
                <LinearGradient
                  colors={NIGHT.blue}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={[StyleSheet.absoluteFill, styles.addBtnFill]}
                />
              </PopIn>
            ) : null}
            {/* In a View of its own: on the web the fill above is positioned and
                a bare svg is not, so the fill would paint over the plus. */}
            <View pointerEvents="none">
              {canAdd ? (
                <PopIn from={0.6}>
                  <Plus color={colors.primaryText} size={22} strokeWidth={2.6} />
                </PopIn>
              ) : (
                <Plus color={colors.textMuted} size={22} strokeWidth={2.6} />
              )}
            </View>
          </Pressable>
        </View>
        {/* What just happened, or — while typing into an empty field — that
            several things can go in at once. */}
        {notice ? (
          <PopIn from={0.96}>
            <Text style={[styles.notice, start]} numberOfLines={2}>
              {notice}
            </Text>
          </PopIn>
        ) : inputFocused && !draft ? (
          <Text style={[styles.hint, start]} numberOfLines={1}>
            {t('shop.add.smart')}
          </Text>
        ) : null}
      </Entrance>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Buy again: what the ticks say is due, then the usual things ── */}
        {suggestions.length > 0 ? (
          <Entrance delay={listDelay(0)} from={12}>
            <View style={styles.suggestHead}>
              <Sparkles color={AURA.yellow.ink} size={15} strokeWidth={2.2} />
              <Text style={[styles.suggestTitle, start]}>{t('shop.suggest.title')}</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.suggestRow}
              keyboardShouldPersistTaps="handled"
            >
              {suggestions.map((s) => (
                <Pressable
                  key={s.name}
                  onPress={() => addSuggestion(s)}
                  onLongPress={() => forgetSuggestion(s)}
                  style={[styles.suggestChip, s.due && styles.suggestChipDue]}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('shop.add')}: ${s.name}`}
                  accessibilityHint={t('shop.suggest.hint')}
                >
                  <Text style={styles.suggestEmoji}>{itemEmoji(s)}</Text>
                  <View>
                    <Text style={styles.suggestName} numberOfLines={1}>
                      {s.name}
                    </Text>
                    {s.due ? (
                      <Text style={styles.suggestDue} numberOfLines={1}>
                        {t('shop.suggest.due')}
                      </Text>
                    ) : null}
                  </View>
                  <Plus color={colors.textMuted} size={15} strokeWidth={2.4} />
                </Pressable>
              ))}
            </ScrollView>
          </Entrance>
        ) : null}

        {items.length === 0 ? <EmptyList delay={listDelay(0)} /> : null}
        {items.length > 0 && toBuy.length === 0 ? (
          <Entrance delay={listDelay(0)} from={12}>
            <View style={styles.allDone}>
              <Check color={AURA.green.ink} size={16} strokeWidth={2.6} />
              <Text style={[styles.allDoneText, start]}>{t('shop.allDone')}</Text>
            </View>
          </Entrance>
        ) : null}

        {/* ── One heading per aisle, its rows under it ──
            The heading and each row enter on their own rather than as one
            block, so the rows follow their heading down instead of riding it. */}
        {groups.map((group) => {
          const skin = group.key === 'none' ? null : categoryTint(group.key);
          return (
            <View key={group.key} style={styles.group}>
              <Entrance delay={listDelay(0)} from={16}>
                <View style={styles.groupHead}>
                  <View
                    style={[styles.groupDot, { backgroundColor: skin?.ink ?? colors.textMuted }]}
                  />
                  <Text
                    style={[styles.groupTitle, !skin && styles.groupTitleQuiet, start]}
                    numberOfLines={1}
                  >
                    {group.key === 'none' ? t('shop.noCategory') : t(`shop.cat.${group.key}`)}
                  </Text>
                  <CountUp
                    value={group.items.length}
                    format={countFromOne}
                    style={styles.groupCount}
                  />
                </View>
              </Entrance>
              {group.items.map((item, i) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  price={rowPrices.get(item.id) ?? null}
                  delay={listDelay(i + 1)}
                  onToggle={() => toggle(item)}
                  onEdit={() => openEdit(item)}
                  onDelete={() => confirmDelete(item)}
                />
              ))}
            </View>
          );
        })}

        {/* ── The trolley: one bar, opened only if you want it ──
            It used to be a second full-height list competing with the one that
            still needs doing, which is the wrong way round. */}
        {bought.length > 0 ? (
          <View style={styles.troll}>
            <Entrance delay={listDelay(0)} from={16}>
              <Pressable
                onPress={() => {
                  // The rows open out of the bar and the button below moves
                  // down to make room, rather than the page jumping.
                  animateLayout();
                  setShowBought((v) => !v);
                }}
                style={({ pressed }) => [styles.trollHead, pressed && styles.pressedDim]}
                accessibilityRole="button"
                accessibilityState={{ expanded: showBought }}
              >
                <LinearGradient
                  colors={NIGHT.discs.tasks}
                  start={{ x: 0.15, y: 0.1 }}
                  end={{ x: 0.85, y: 0.95 }}
                  style={styles.tick}
                >
                  <Check color={NIGHT.glyph} size={13} strokeWidth={3} />
                </LinearGradient>
                <Text style={[styles.trollTitle, start]}>{t('shop.bought')}</Text>
                <CountUp value={bought.length} format={countFromOne} style={styles.trollCount} />
                <TurningChevron open={showBought} />
              </Pressable>
            </Entrance>

            {showBought
              ? bought.map((item, i) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    price={rowPrices.get(item.id) ?? null}
                    delay={listDelay(i + 1)}
                    onToggle={() => toggle(item)}
                    onEdit={() => openEdit(item)}
                    onDelete={() => confirmDelete(item)}
                  />
                ))
              : null}

            <Entrance delay={listDelay(1 + (showBought ? bought.length : 0))} from={16}>
              <Pressable
                onPress={clearBought}
                style={({ pressed }) => [styles.clearBtn, pressed && styles.pressedDim]}
                accessibilityRole="button"
              >
                <Trash2 color={colors.danger} size={15} strokeWidth={2.2} />
                <Text style={styles.clearText}>{t('shop.clearBought')}</Text>
              </Pressable>
            </Entrance>
          </View>
        ) : null}
      </ScrollView>

      {/* ── Editing one item: the same sheet shape the rest of the app uses ── */}
      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable style={[styles.backdrop, { direction: isRTL() ? 'rtl' : 'ltr' }]} onPress={() => setEditing(null)}>
          {/* The card springs up out of the dim as the dim fades in — every
              time, since the Modal mounts what is in it each time it opens.
              The spring holds the card's size (see `sheetFrame`); the card
              keeps its look and still swallows the taps. */}
          <PopIn from={0.92} style={styles.sheetFrame}>
            {/* Swallow taps on the card so they don't fall through. */}
            <Pressable style={styles.sheet} onPress={() => {}}>
              <View style={styles.sheetHead}>
                <Text style={[styles.sheetTitle, start]}>{t('shop.edit')}</Text>
                <Pressable
                  onPress={() => setEditing(null)}
                  hitSlop={8}
                  style={styles.sheetClose}
                  accessibilityRole="button"
                  accessibilityLabel={t('notes.close')}
                >
                  <X color={colors.text} size={18} strokeWidth={2.4} />
                </Pressable>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetBody}>
                {/* The same guess, up on the label, so a rename shows what
                    the row will carry before it is saved and closed. */}
                <View style={styles.fieldLabelLine}>
                  <Text style={[styles.fieldLabel, styles.fieldLabelText, start]}>
                    {t('shop.name')}
                  </Text>
                  <Text style={styles.fieldLabelEmoji}>
                    {itemEmoji({ name: fName, category: fCat })}
                  </Text>
                </View>
                <TextInput
                  value={fName}
                  onChangeText={setFName}
                  style={[styles.input, start]}
                  placeholderTextColor={colors.textMuted}
                  selectionColor={NIGHT.blue[0]}
                  autoFocus
                />

                <Text style={[styles.fieldLabel, start]}>{t('shop.quantity')}</Text>
                <TextInput
                  value={fQty}
                  onChangeText={setFQty}
                  placeholder={t('shop.quantityHint')}
                  placeholderTextColor={colors.textMuted}
                  selectionColor={NIGHT.blue[0]}
                  style={[styles.input, start]}
                />

                <Text style={[styles.fieldLabel, start]}>{t('shop.note')}</Text>
                <TextInput
                  value={fNote}
                  onChangeText={setFNote}
                  style={[styles.input, start]}
                  placeholderTextColor={colors.textMuted}
                  selectionColor={NIGHT.blue[0]}
                />

                <Text style={[styles.fieldLabel, start]}>{t('shop.category')}</Text>
                <View style={styles.chipWrap}>
                  <CategoryChip
                    label={t('shop.noCategory')}
                    active={fCat === null}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setFCat(null);
                    }}
                  />
                  {SHOPPING_CATEGORIES.map((cat) => (
                    <CategoryChip
                      key={cat}
                      label={t(`shop.cat.${cat}`)}
                      active={fCat === cat}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setFCat(cat);
                      }}
                    />
                  ))}
                </View>
              </ScrollView>

              {/* The primary button's look, kept inline for the role it carries. */}
              <Pressable
                onPress={saveEdit}
                style={({ pressed }) => [styles.saveBtn, pressed && styles.pressedDim]}
                accessibilityRole="button"
              >
                <LinearGradient
                  colors={NIGHT.blue}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  // Rounded itself rather than clipped by the button: clipping on
                  // iOS takes the button's glow with it.
                  style={[StyleSheet.absoluteFill, styles.saveFill]}
                />
                <Text style={styles.saveText}>{t('profile.save')}</Text>
              </Pressable>
            </Pressable>
          </PopIn>
        </Pressable>
      </Modal>

      {/* ── Checkout: what the shop came to, filed in Finance ── */}
      <Modal
        visible={checkout}
        transparent
        animationType="fade"
        onRequestClose={() => setCheckout(false)}
      >
        <Pressable style={[styles.backdrop, { direction: isRTL() ? 'rtl' : 'ltr' }]} onPress={() => setCheckout(false)}>
          <PopIn from={0.92} style={styles.sheetFrame}>
            <Pressable style={styles.sheet} onPress={() => {}} pressScale={1}>
              <View style={styles.sheetHead}>
                <Text style={[styles.sheetTitle, start]}>{t('shop.checkout.title')}</Text>
                <Pressable
                  onPress={() => setCheckout(false)}
                  hitSlop={8}
                  style={styles.sheetClose}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.close')}
                >
                  <X color={colors.text} size={18} strokeWidth={2.4} />
                </Pressable>
              </View>
              <Text style={[styles.checkoutBody, start]}>{t('shop.checkout.body')}</Text>
              <Text style={[styles.fieldLabel, start]}>{t('fin.amount')}</Text>
              <TextInput
                value={spent}
                onChangeText={setSpent}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={colors.textMuted}
                selectionColor={NIGHT.blue[0]}
                style={[styles.input, start]}
                autoFocus
                onSubmitEditing={() => finishCheckout(true)}
              />
              <Pressable
                onPress={() => finishCheckout(true)}
                style={({ pressed }) => [styles.saveBtn, pressed && styles.pressedDim]}
                accessibilityRole="button"
              >
                <LinearGradient
                  colors={NIGHT.blue}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={[StyleSheet.absoluteFill, styles.saveFill]}
                />
                <Text style={styles.saveText}>{t('shop.checkout.save')}</Text>
              </Pressable>
              <Pressable
                onPress={() => finishCheckout(false)}
                style={({ pressed }) => [styles.skipBtn, pressed && styles.pressedDim]}
                accessibilityRole="button"
              >
                <Text style={styles.skipText}>{t('shop.checkout.skip')}</Text>
              </Pressable>
            </Pressable>
          </PopIn>
        </Pressable>
      </Modal>
    </Screen>
  );
}

/** A category in the edit sheet: quiet until chosen, then lit the app's blue. */
function CategoryChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      {/* Mounted only while chosen, so choosing is what pops it in. */}
      {active ? (
        <PopIn style={[StyleSheet.absoluteFill, styles.chipFill]}>
          <LinearGradient
            colors={NIGHT.blue}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={[StyleSheet.absoluteFill, styles.chipFill]}
          />
        </PopIn>
      ) : null}
      {/* One weight either way: a bolder label would widen the chip and nudge
          the rest of the wrap along as the choice moves. */}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Nothing on the list yet. The cart drifts — the one thing on this page that
 * moves at rest, and only while there is nothing else to look at.
 */
function EmptyList({ delay }: { delay: number }) {
  const drift = useFloat(4, 2600);
  return (
    <Entrance delay={delay} from={16}>
      <View style={styles.empty}>
        <Animated.View style={[styles.emptyIcon, { transform: [{ translateY: drift }] }]}>
          <ShoppingCart color={AURA.green.ink} size={26} strokeWidth={1.8} />
        </Animated.View>
        <Text style={styles.emptyTitle}>{t('shop.empty.title')}</Text>
        <Text style={styles.emptyBody}>{t('shop.empty.body')}</Text>
      </View>
    </Entrance>
  );
}

/**
 * The trolley's chevron turns over rather than swapping for its opposite, so
 * the bar reads as opening. It swings a touch past and settles.
 */
function TurningChevron({ open }: { open: boolean }) {
  const reduce = useReducedMotion();
  const turn = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    const to = open ? 1 : 0;
    if (reduce) {
      turn.setValue(to);
      return;
    }
    const anim = Animated.spring(turn, {
      toValue: to,
      friction: 6,
      tension: 120,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [open, reduce, turn]);

  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <ChevronDown color={colors.textMuted} size={18} />
    </Animated.View>
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

/**
 * The chosen thing's blue and the glow under it — the ground a gradient is
 * laid over, so the glow has something opaque to cast from.
 */
const lit = {
  // Getters, like `glass`, so a rebuilt sheet reads the blue in force.
  get backgroundColor() {
    return NIGHT.blue[1];
  },
  get shadowColor() {
    return NIGHT.blue[1];
  },
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.5,
  shadowRadius: 10,
  elevation: 6,
} as const;

const styles = themed(() =>
  StyleSheet.create({
    /** A press that reads as a press without moving anything under the finger. */
    pressedDim: { opacity: 0.72 },

    headerRow: { flexDirection: 'row', alignItems: 'center' },
    iconBtn: {
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** The bell's disc from Home: lifted by its edge, not a shadow. */
    iconBtnRaised: {
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },

    // ── The headline ──
    headline: { marginTop: spacing.md },
    headlineTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    headlineText: {
      fontSize: 34,
      lineHeight: 38,
      ...font(700),
      color: colors.text,
      letterSpacing: -1,
    },
    headlineSub: { fontSize: 15, ...font(500), color: colors.textMuted, marginTop: 4 },
    /**
     * The outstanding count, sat on the disc like a notification dot. The ring
     * is the page's own colour, cutting it out of the disc it overlaps.
     */
    badgeCount: {
      position: 'absolute',
      top: -4,
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 5,
      borderWidth: 2,
      borderColor: colors.bg,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeCountText: { fontSize: 11, ...font(700), color: colors.primaryText },
    // ── The estimate ──
    estimateRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: spacing.md },
    estimateText: { fontSize: 15, ...font(700), color: colors.text },
    estimateLeft: { flex: 1, fontSize: 13, ...font(600), color: colors.textMuted },
    estimateNote: { fontSize: 12, ...font(500), color: colors.textMuted, marginTop: 3 },

    progressTrack: {
      height: 7,
      borderRadius: 4,
      backgroundColor: NIGHT.cardAlt,
      overflow: 'hidden',
      marginTop: spacing.md,
    },
    progressFill: { height: '100%', borderRadius: 4 },
    /** The sweep, rounded itself: the fill holding it grows, and doesn't clip. */
    progressPaint: { borderRadius: 4 },

    // ── Quick add ──
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: spacing.md + 2,
      marginBottom: spacing.md,
    },
    addInput: {
      flex: 1,
      backgroundColor: colors.surfaceAlt,
      borderRadius: 100,
      paddingHorizontal: 18,
      paddingVertical: 15,
      fontSize: 15,
      ...font(500),
      color: colors.text,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    addBtn: {
      ...lit,
      width: 50,
      height: 50,
      borderRadius: 25,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnFill: { borderRadius: 25 },
    addBtnIdle: {
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      shadowOpacity: 0,
      elevation: 0,
    },

    /** Ends clear of the floating bar: the page runs under it (see `Screen`). */
    list: { paddingBottom: TAB_BAR_CLEARANCE },

    // ── One heading per aisle ──
    group: { marginBottom: spacing.sm },
    groupHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 4,
      marginTop: 4,
      marginBottom: spacing.sm + 2,
    },
    groupDot: { width: 8, height: 8, borderRadius: 4 },
    groupTitle: { flex: 1, fontSize: 17, ...font(700), color: colors.text, letterSpacing: -0.3 },
    /** No aisle: the heading steps back, as its rows have no edge. */
    groupTitleQuiet: { color: colors.textMuted },
    groupCount: { fontSize: 14, ...font(600), color: colors.textMuted },

    // ── The trolley, collapsed ──
    troll: { marginTop: spacing.sm },
    trollHead: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      minHeight: 56,
      borderRadius: 13,
      paddingHorizontal: 18,
      marginBottom: 7,
    },
    trollTitle: { flex: 1, fontSize: 16, ...font(600), color: colors.text },
    trollCount: { fontSize: 14, ...font(600), color: colors.textMuted },

    clearBtn: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      minHeight: 48,
      borderRadius: 13,
    },
    clearText: { fontSize: 14, ...font(600), color: colors.danger },

    // ── Rows ──
    row: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      minHeight: 60,
      borderRadius: 13,
      paddingVertical: 9,
      paddingHorizontal: 18,
      marginBottom: 7,
      overflow: 'hidden',
    },
    /** Which aisle this is, in that aisle's ink. */
    rowEdge: {
      position: 'absolute',
      top: 3,
      bottom: 3,
      width: 4,
      borderRadius: 2,
    },
    tick: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tickOpen: { borderWidth: 2, borderColor: NIGHT.tickRing },
    tickFill: { borderRadius: 11 },

    /** The whole height of the row opens the item, not just the line of type. */
    rowBody: { flex: 1, alignSelf: 'stretch', justifyContent: 'center', gap: 2 },
    rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    /**
     * Sized just under the title and given a line height of its own, so a name
     * with an emoji before it keeps the same baseline — and the same row
     * height — as one without.
     */
    rowEmoji: { fontSize: 17, lineHeight: 21 },
    /** Fades with the title, so a row in the trolley is dim right across. */
    rowEmojiDone: { opacity: 0.45 },
    rowTitle: { flexShrink: 1, fontSize: 16, ...font(600), color: colors.text },
    /** Already in the trolley — present, but no longer the point. */
    rowTitleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
    /**
     * The market-price guess for one row, next to its quantity.
     *
     * Green because it is money, and the same green as the wallet on the
     * headline — one language for prices across the page. Kept quiet: this
     * is a hint, not a receipt.
     */
    priceChip: {
      paddingHorizontal: 8,
      height: 22,
      borderRadius: 11,
      backgroundColor: AURA.green.tint,
      alignItems: 'center',
      justifyContent: 'center',
    },
    priceText: { fontSize: 12, ...font(700), color: AURA.green.ink },
    qtyChip: {
      backgroundColor: NIGHT.cardAlt,
      borderRadius: 100,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    qtyText: { fontSize: 12, ...font(700), color: colors.textMuted },

    rowNote: { flexShrink: 1, fontSize: 14, ...font(500), color: colors.textMuted },

    empty: {
      ...glass,
      borderRadius: 16,
      alignItems: 'center',
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
      gap: 6,
    },
    emptyIcon: {
      width: 56,
      height: 56,
      borderRadius: 18,
      backgroundColor: AURA.green.tint,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.sm,
    },
    emptyTitle: { fontSize: 17, ...font(700), color: colors.text },
    emptyBody: {
      fontSize: 14,
      ...font(500),
      color: colors.textMuted,
      textAlign: 'center',
    },

    // ── Edit sheet ──
    backdrop: {
      flex: 1,
      backgroundColor: NIGHT.backdrop,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
    },
    /**
     * The card's size, on the spring that holds it. Measured against the dim as
     * the card itself used to be; the card shrinks inside it when the fields run
     * taller, and its own scroll takes up the rest.
     */
    sheetFrame: {
      width: '100%',
      maxWidth: 420,
      maxHeight: '82%',
    },
    /** Opaque, unlike the cards: glass over a dimmed page would show it through. */
    sheet: {
      flexShrink: 1,
      backgroundColor: colors.surface,
      borderRadius: 28,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      padding: spacing.md + 2,
    },
    sheetHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: spacing.sm,
    },
    sheetTitle: { flex: 1, fontSize: 20, ...font(700), color: colors.text, letterSpacing: -0.4 },
    sheetClose: {
      width: 34,
      height: 34,
      borderRadius: 17,
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
    /** The name's label and its emoji on one line, the emoji on the far end. */
    fieldLabelLine: { flexDirection: 'row', alignItems: 'center' },
    fieldLabelText: { flex: 1 },
    fieldLabelEmoji: { fontSize: 17, lineHeight: 21, marginTop: 12, marginBottom: 7 },
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

    /** Room under the last line of chips so the chosen one's glow isn't clipped. */
    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 12 },
    chip: {
      paddingHorizontal: 13,
      paddingVertical: 9,
      borderRadius: 50,
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    chipActive: { ...lit, borderColor: NIGHT.blue[1] },
    chipFill: { borderRadius: 50 },
    chipText: { ...font(600), fontSize: 13, color: colors.textMuted },
    chipTextActive: { color: colors.primaryText },

    /** `Button`'s primary look: the blue, lit from the top, on its glow. */
    saveBtn: {
      marginTop: spacing.sm,
      minHeight: 58,
      borderRadius: 100,
      paddingVertical: 18,
      paddingHorizontal: spacing.md,
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
    skipBtn: {
      marginTop: spacing.sm,
      minHeight: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    skipText: { ...font(600), fontSize: 15, color: colors.textMuted },
    checkoutBody: { ...font(500), fontSize: 14, lineHeight: 20, color: colors.textMuted },

    iconBtnGap: { marginEnd: 8 },

    // ── Under the quick add ──
    notice: {
      ...font(600),
      fontSize: 13,
      color: AURA.green.ink,
      marginTop: -spacing.sm,
      marginBottom: spacing.sm,
      paddingHorizontal: 6,
    },
    hint: {
      ...font(500),
      fontSize: 13,
      color: colors.textMuted,
      marginTop: -spacing.sm,
      marginBottom: spacing.sm,
      paddingHorizontal: 6,
    },

    // ── Buy again ──
    suggestHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 4,
      marginBottom: 8,
    },
    suggestTitle: { flex: 1, fontSize: 14, ...font(700), color: colors.textMuted },
    suggestRow: { gap: 8, paddingBottom: spacing.md, paddingHorizontal: 2 },
    suggestChip: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 44,
      borderRadius: 100,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    /** Probably run out: edged in the warm ink the budgets warn in. */
    suggestChipDue: { borderColor: AURA.yellow.ink, borderWidth: 1 },
    suggestEmoji: { fontSize: 16, lineHeight: 20 },
    suggestName: { fontSize: 14, ...font(600), color: colors.text, maxWidth: 140 },
    suggestDue: { fontSize: 11, ...font(600), color: AURA.yellow.ink },

    allDone: {
      ...glass,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 52,
      borderRadius: 13,
      paddingHorizontal: 18,
      marginBottom: spacing.sm,
    },
    allDoneText: { flex: 1, fontSize: 15, ...font(600), color: colors.text },
  }),
);
