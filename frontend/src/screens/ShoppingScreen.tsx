import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  Modal,
  Animated,
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
  ChevronUp,
} from 'lucide-react-native';

import { Screen } from '../components/ui';
import { Entrance } from '../components/motion';
import { LinearGradient } from 'expo-linear-gradient';
import {
  api,
  uuid,
  SHOPPING_CATEGORIES,
  type ShoppingItem,
  type ShoppingCategory,
} from '../lib/api';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, radius, AURA, AURA_CYCLE, IRIDESCENT } from '../theme';
import { t, alignStart } from '../lib/i18n';

// The shopping list. One job, done fast: type a thing, tick it off in the
// aisle, clear the trolley at the till.
//
// It replaces the notes board and keeps that screen's furniture — the same
// header, headline, empty state and card treatment — so it reads as the screen
// that was always there rather than a bolted-on module.

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Category chips borrow the gradient family, cycling in its own order. */
function categoryTint(cat: ShoppingCategory | null) {
  if (!cat) return null;
  const i = SHOPPING_CATEGORIES.indexOf(cat);
  // A category from outside the list lands here as -1, and `AURA_CYCLE[-1]` is
  // undefined — reading `.tint` off that is a hard crash. The type says it
  // cannot happen; a row written by an older build says otherwise.
  if (i === -1) return null;
  return AURA[AURA_CYCLE[i % AURA_CYCLE.length]];
}

/** A row that ticks, with the checkbox, the text, and a delete on the end. */
function ItemRow({
  item,
  index,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: ShoppingItem;
  index: number;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tint = categoryTint(item.category);
  const start = { textAlign: alignStart() } as const;

  // The tick springs rather than snapping — the one flourish on the row, and
  // the only feedback that the tap landed while a phone is in a trolley.
  const pop = useRef(new Animated.Value(item.isBought ? 1 : 0)).current;
  const tick = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Animated.spring(pop, {
      toValue: item.isBought ? 0 : 1,
      friction: 6,
      tension: 90,
      useNativeDriver: true,
    }).start();
    onToggle();
  };

  return (
    <Entrance delay={Math.min(index * 45, 360)}>
      <View style={styles.row}>
        <Pressable
          onPress={tick}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: item.isBought }}
          accessibilityLabel={item.name}
        >
          <View style={[styles.checkbox, item.isBought && styles.checkboxDone]}>
            <Animated.View style={{ transform: [{ scale: pop }], opacity: pop }}>
              <Check color={colors.primaryText} size={14} strokeWidth={3.2} />
            </Animated.View>
          </View>
        </Pressable>

        <Pressable style={{ flex: 1 }} onPress={onEdit} accessibilityRole="button">
          <View style={styles.rowTitleLine}>
            <Text
              style={[styles.rowTitle, start, item.isBought && styles.rowTitleDone]}
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
          </View>

          {/* The category is the group header now, so a row only carries
              what is particular to it. */}
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
          <Trash2 color={colors.textMuted} size={17} />
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

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const { items: rows } = await api.listShopping();
        if (active) setItems(rows);
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

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

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDraft('');
    const id = uuid();
    // Optimistic: the row is there before storage answers, so typing several
    // items in a row never waits.
    const optimistic: ShoppingItem = {
      id,
      name,
      quantity: null,
      note: null,
      category: null,
      isBought: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    setItems((prev) => [optimistic, ...prev]);
    try {
      await api.createShoppingItem({ id, name, updatedAt: new Date().toISOString() });
    } catch (e) {
      load();
      Alert.alert(t('common.error'), (e as Error).message);
    }
  };

  const toggle = async (item: ShoppingItem) => {
    const next = !item.isBought;
    setItems((prev) => prev.map((r) => (r.id === item.id ? { ...r, isBought: next } : r)));
    try {
      await api.updateShoppingItem(item.id, {
        isBought: next,
        updatedAt: new Date().toISOString(),
      });
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

  const clearBought = () => {
    if (bought.length === 0) return;
    Alert.alert(
      t('shop.clearBought'),
      t('shop.clearBoughtConfirm', { count: bought.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setItems((prev) => prev.filter((r) => !r.isBought));
            try {
              await api.clearBoughtShopping();
            } catch (e) {
              load();
              Alert.alert(t('common.error'), (e as Error).message);
            }
          },
        },
      ],
    );
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

  return (
    <Screen>
      {/* ── Back, and the assistant, exactly where they were ── */}
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
          <ChevronLeft color={colors.text} size={22} />
        </Pressable>
        <View style={{ flex: 1 }} />
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

      {/* ── How far through the shop you are ──
          A list is a progress bar with words on it, and this is the one fact
          the old headline could not tell you: whether you are nearly done. */}
      <Entrance delay={40} from={16}>
        <LinearGradient
          colors={IRIDESCENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.banner}
        >
          <View style={styles.bannerTop}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.bannerTitle, start]}>{t('shop.title')}</Text>
              <Text style={[styles.bannerSub, start]}>
                {t('today.completedOf', { done: bought.length, total: items.length })}
              </Text>
            </View>
            <View style={styles.bannerBadge}>
              <ShoppingCart color={colors.text} size={22} strokeWidth={2} />
              {toBuy.length > 0 ? (
                <View style={styles.bannerCount}>
                  <Text style={styles.bannerCountText}>{toBuy.length}</Text>
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.bannerTrack}>
            <View
              style={[
                styles.bannerFill,
                { width: `${items.length ? (bought.length / items.length) * 100 : 0}%` },
              ]}
            />
          </View>
        </LinearGradient>
      </Entrance>

      {/* ── The quick add, the one thing this screen is for ── */}
      <View style={styles.addRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t('shop.add.placeholder')}
          placeholderTextColor={colors.textMuted}
          style={[styles.addInput, start]}
          returnKeyType="done"
          onSubmitEditing={add}
          // Stays open for the next item: a list is written in bursts.
          blurOnSubmit={false}
        />
        <Pressable
          onPress={add}
          disabled={!draft.trim()}
          style={[styles.addBtn, !draft.trim() && styles.addBtnIdle]}
          accessibilityRole="button"
          accessibilityLabel={t('shop.add')}
        >
          <Plus color={colors.primaryText} size={22} strokeWidth={2.6} />
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
        {items.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <ShoppingCart color={AURA.green.ink} size={26} strokeWidth={1.8} />
            </View>
            <Text style={styles.emptyTitle}>{t('shop.empty.title')}</Text>
            <Text style={styles.emptyBody}>{t('shop.empty.body')}</Text>
          </View>
        ) : null}

        {/* ── One card per aisle ── */}
        {groups.map((group, gi) => {
          const skin =
            group.key === 'none'
              ? null
              : AURA[AURA_CYCLE[SHOPPING_CATEGORIES.indexOf(group.key) % AURA_CYCLE.length]];
          return (
            <Entrance key={group.key} delay={80 + gi * 60} from={16}>
              <View style={styles.groupCard}>
                <View
                  style={[
                    styles.groupHead,
                    { backgroundColor: skin?.tint ?? colors.surfaceAlt },
                  ]}
                >
                  <Text
                    style={[styles.groupTitle, { color: skin?.ink ?? colors.textMuted }, start]}
                    numberOfLines={1}
                  >
                    {group.key === 'none' ? t('shop.noCategory') : t(`shop.cat.${group.key}`)}
                  </Text>
                  <Text style={[styles.groupCount, { color: skin?.ink ?? colors.textMuted }]}>
                    {group.items.length}
                  </Text>
                </View>
                <View style={styles.groupBody}>
                  {group.items.map((item, i) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      index={i}
                      onToggle={() => toggle(item)}
                      onEdit={() => openEdit(item)}
                      onDelete={() => confirmDelete(item)}
                    />
                  ))}
                </View>
              </View>
            </Entrance>
          );
        })}

        {/* ── The trolley: one bar, opened only if you want it ──
            It used to be a second full-height list competing with the one that
            still needs doing, which is the wrong way round. */}
        {bought.length > 0 ? (
          <Entrance delay={80 + groups.length * 60} from={16}>
            <View style={styles.troll}>
              <Pressable
                onPress={() => setShowBought((v) => !v)}
                style={({ pressed }) => [styles.trollHead, pressed && { opacity: 0.72 }]}
                accessibilityRole="button"
                accessibilityState={{ expanded: showBought }}
              >
                <View style={styles.trollCheck}>
                  <Check color={colors.primaryText} size={13} strokeWidth={3.2} />
                </View>
                <Text style={[styles.trollTitle, start]}>{t('shop.bought')}</Text>
                <Text style={styles.trollCount}>{bought.length}</Text>
                {showBought ? (
                  <ChevronUp color={colors.textMuted} size={18} />
                ) : (
                  <ChevronDown color={colors.textMuted} size={18} />
                )}
              </Pressable>

              {showBought ? (
                <View style={styles.groupBody}>
                  {bought.map((item, i) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      index={i}
                      onToggle={() => toggle(item)}
                      onEdit={() => openEdit(item)}
                      onDelete={() => confirmDelete(item)}
                    />
                  ))}
                </View>
              ) : null}

              <Pressable
                onPress={clearBought}
                style={({ pressed }) => [styles.clearBtn, pressed && { opacity: 0.72 }]}
                accessibilityRole="button"
              >
                <Trash2 color={colors.danger} size={15} strokeWidth={2.2} />
                <Text style={styles.clearText}>{t('shop.clearBought')}</Text>
              </Pressable>
            </View>
          </Entrance>
        ) : null}
      </ScrollView>

      {/* ── Editing one item: the same sheet shape the rest of the app uses ── */}
      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setEditing(null)}>
          {/* Swallow taps on the card so they don't fall through. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, start]}>{t('shop.edit')}</Text>
              <Pressable
                onPress={() => setEditing(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('notes.close')}
              >
                <X color={colors.textMuted} size={20} />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={styles.sheetBody}>
              <Text style={[styles.fieldLabel, start]}>{t('shop.name')}</Text>
              <TextInput
                value={fName}
                onChangeText={setFName}
                style={[styles.input, start]}
                placeholderTextColor={colors.textMuted}
                autoFocus
              />

              <Text style={[styles.fieldLabel, start]}>{t('shop.quantity')}</Text>
              <TextInput
                value={fQty}
                onChangeText={setFQty}
                placeholder={t('shop.quantityHint')}
                placeholderTextColor={colors.textMuted}
                style={[styles.input, start]}
              />

              <Text style={[styles.fieldLabel, start]}>{t('shop.note')}</Text>
              <TextInput
                value={fNote}
                onChangeText={setFNote}
                style={[styles.input, start]}
                placeholderTextColor={colors.textMuted}
              />

              <Text style={[styles.fieldLabel, start]}>{t('shop.category')}</Text>
              <View style={styles.chipWrap}>
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setFCat(null);
                  }}
                  style={[styles.chip, fCat === null && styles.chipActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: fCat === null }}
                >
                  <Text style={[styles.chipText, fCat === null && styles.chipTextActive]}>
                    {t('shop.noCategory')}
                  </Text>
                </Pressable>
                {SHOPPING_CATEGORIES.map((cat) => {
                  const active = fCat === cat;
                  return (
                    <Pressable
                      key={cat}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setFCat(cat);
                      }}
                      style={[styles.chip, active && styles.chipActive]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {t(`shop.cat.${cat}`)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>

            <Pressable onPress={saveEdit} style={styles.saveBtn} accessibilityRole="button">
              <Text style={styles.saveText}>{t('profile.save')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  iconBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnRaised: {
    backgroundColor: colors.surface,
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },


  // ── Quick add ──
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.md },
  addInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 100,
    paddingHorizontal: 18,
    paddingVertical: 15,
    fontSize: 15,
    ...font(500),
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnIdle: { opacity: 0.35 },

  list: { paddingBottom: spacing.md },

  // ── The banner ──
  banner: {
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  bannerTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bannerTitle: { fontSize: 26, ...font(700), color: colors.text, letterSpacing: -0.7 },
  bannerSub: {
    fontSize: 13,
    ...font(600),
    color: colors.text,
    opacity: 0.65,
    marginTop: 2,
  },
  bannerBadge: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The outstanding count, sat on the badge like a notification dot. */
  bannerCount: {
    position: 'absolute',
    top: -3,
    insetInlineEnd: -3,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerCountText: { fontSize: 11, ...font(700), color: colors.primaryText },
  bannerTrack: {
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.5)',
    overflow: 'hidden',
    marginTop: spacing.md,
  },
  bannerFill: { height: '100%', borderRadius: 4, backgroundColor: colors.primary },

  // ── One card per aisle ──
  groupCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: 10,
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  groupTitle: { flex: 1, fontSize: 13, ...font(700), letterSpacing: 0.2 },
  groupCount: { fontSize: 12.5, ...font(700), opacity: 0.75 },
  groupBody: { paddingHorizontal: 14 },

  // ── The trolley, collapsed ──
  troll: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  trollHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  trollCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trollTitle: { flex: 1, fontSize: 14.5, ...font(700), color: colors.text },
  trollCount: { fontSize: 12.5, ...font(700), color: colors.textMuted },


  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  clearText: { fontSize: 13, ...font(600), color: colors.danger },

  /** Already in the trolley — present, but no longer the point. */

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.8,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: colors.primary, borderColor: colors.primary },

  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { flexShrink: 1, fontSize: 15.5, ...font(600), color: colors.text },
  rowTitleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
  qtyChip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  qtyText: { fontSize: 11.5, ...font(700), color: colors.textMuted },

  rowNote: { flexShrink: 1, fontSize: 12.5, ...font(500), color: colors.textMuted },

  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: 6 },
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
    paddingHorizontal: spacing.lg,
  },

  // ── Edit sheet ──
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
    maxHeight: '82%',
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
