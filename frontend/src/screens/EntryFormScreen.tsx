import { useEffect, useRef, useState } from 'react';
import { ScrollView, View, Text, TextInput, StyleSheet, Alert, Animated, Easing } from 'react-native';
import {
  Entrance,
  PopIn,
  Pressable,
  useBreathe,
  useReducedMotion,
} from '../components/motion';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import {
  X,
  Check,
  Calendar as CalendarIcon,
  CalendarDays,
  Clock,
  ListTodo,
  Trash2,
} from 'lucide-react-native';

import { Screen, Button, Field, LitDisc } from '../components/ui';
import { api, uuid } from '../lib/api';
import { storage } from '../lib/storage';
import {
  withPriority,
  parsePriority,
  toDateStr,
  toTimeStr,
  toUtcIso,
  nowIso,
  plusHour,
} from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import {
  colors,
  spacing,
  radius,
  font,
  NIGHT,
  PRIORITY_COLORS,
  type Priority,
  themed,
} from '../theme';
import { t, alignStart } from '../lib/i18n';

// The form behind the + and behind a tapped row: one screen for a task or an
// event, new or being edited. On the dark like Home — glass discs for the
// chrome, the title big under them, fields a step off the page, and the blue
// kept for the two things that save.

type Nav = NativeStackNavigationProp<RootStackParamList, 'EntryForm'>;
type Route = RouteProp<RootStackParamList, 'EntryForm'>;

/** The side padding `Screen` gives every page, which the scroll undoes. */
const SCREEN_PAD = spacing.md + 4;

/**
 * The gap between one piece of the form arriving and the next. Quicker than a
 * page of cards: this is somewhere you came to type, and the last field should
 * be standing before a thumb gets to it.
 */
const STAGGER_MS = 35;
/** Where the nth piece of the form, in reading order, starts arriving. */
const at = (n: number) => n * STAGGER_MS;
/** How far each piece rises. Short, for the same reason. */
const RISE = 14;

/**
 * A field with a quiet glyph at its start. Same ground and edge as `Field`, so
 * the dates and times read as the same kind of thing as the title above them.
 */
function IconInput({
  icon,
  ...rest
}: { icon: React.ReactNode } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.iconInput}>
      {icon}
      <TextInput
        placeholderTextColor={colors.textMuted}
        selectionColor={NIGHT.blue[0]}
        style={styles.iconInputText}
        {...rest}
      />
    </View>
  );
}

export default function EntryFormScreen() {
  const navigation = useNavigation<Nav>();
  const { kind, id: editingId } = useRoute<Route>().params;
  const isTask = kind === 'task';
  const isEditing = Boolean(editingId);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority | null>('Medium');
  /** Tasks only: when work on it begins. Left blank if there is none. */
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [date, setDate] = useState(toDateStr(new Date()));
  const [time, setTime] = useState('');
  /** Events only. Left blank on a new event, which then runs an hour. */
  const [endTime, setEndTime] = useState('');
  const [saving, setSaving] = useState(false);

  // The save disc breathes once there is something to save — a title is the
  // one thing the form insists on — and settles when there isn't. The breath
  // runs all along and `ready` fades it in and out, so it never snaps from the
  // middle of a swell back to rest.
  const reduce = useReducedMotion();
  const canSave = Boolean(title.trim()) && !saving;
  const breath = useBreathe(0, 0.06, 1400);
  const ready = useRef(new Animated.Value(canSave ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) {
      ready.setValue(canSave ? 1 : 0);
      return;
    }
    const anim = Animated.timing(ready, {
      toValue: canSave ? 1 : 0,
      duration: 360,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [canSave, reduce, ready]);
  const saveScale = Animated.add(1, Animated.multiply(breath, ready));

  // Editing: pull the row in and fill the fields from it.
  useEffect(() => {
    if (!editingId) return;
    let active = true;
    (async () => {
      try {
        if (isTask) {
          const { tasks } = await api.listTasks();
          const row = tasks.find((r) => r.id === editingId);
          if (!row || !active) return;
          const parsed = parsePriority(row.notes);
          setTitle(row.title);
          setBody(parsed.text);
          setPriority(parsed.priority);
          if (row.dueAt) {
            const d = new Date(row.dueAt);
            setDate(toDateStr(d));
            setTime(toTimeStr(d));
          } else {
            setDate('');
            setTime('');
          }
          if (row.startAt) {
            const s = new Date(row.startAt);
            setStartDate(toDateStr(s));
            setStartTime(toTimeStr(s));
          } else {
            setStartDate('');
            setStartTime('');
          }
        } else {
          const { events } = await api.listEvents();
          const row = events.find((r) => r.id === editingId);
          if (!row || !active) return;
          const parsed = parsePriority(row.note);
          const start = new Date(row.startsAt);
          setTitle(row.title);
          setBody(parsed.text);
          setPriority(parsed.priority);
          setDate(toDateStr(start));
          setTime(toTimeStr(start));
          setEndTime(toTimeStr(new Date(row.endsAt)));
        }
      } catch {
        /* a row that vanished leaves an empty form rather than an error */
      }
    })();
    return () => {
      active = false;
    };
  }, [editingId, isTask]);

  const save = async () => {
    if (!title.trim()) {
      Alert.alert(t('form.missingTitle'), t('form.missingTitleBody'));
      return;
    }
    setSaving(true);
    try {
      // Ids are client-generated so creates work offline and replays are
      // idempotent server-side (200 on same-id replay, 409 across users).
      const id = editingId ?? uuid();
      const updatedAt = nowIso();
      const notes = withPriority(body, priority);

      if (isTask) {
        // An undated task is valid: startAt and dueAt are both nullable.
        const startAt = startDate.trim()
          ? toUtcIso(startDate.trim(), startTime.trim() || '09:00')
          : undefined;
        const dueAt = date.trim() ? toUtcIso(date.trim(), time.trim() || '09:00') : undefined;
        if (isEditing) {
          await api.updateTask(id, {
            title: title.trim(),
            notes,
            startAt: startAt ?? null,
            dueAt: dueAt ?? null,
            updatedAt,
          });
        } else {
          await api.createTask({ id, title: title.trim(), notes, startAt, dueAt, updatedAt });
        }
      } else {
        if (!date.trim()) {
          Alert.alert(t('form.missingDate'), t('form.missingDateBody'));
          setSaving(false);
          return;
        }
        const startTime = time.trim() || '09:00';
        // Events are UTC instants; convert from the local date + time.
        const startsAt = toUtcIso(date.trim(), startTime);
        const endsAt = toUtcIso(date.trim(), endTime.trim() || plusHour(startTime));
        if (new Date(endsAt) <= new Date(startsAt)) {
          Alert.alert(t('form.badEndTime'), t('form.badEndTimeBody'));
          setSaving(false);
          return;
        }
        if (isEditing) {
          await api.updateEvent(id, { title: title.trim(), note: notes, startsAt, endsAt, updatedAt });
        } else {
          await api.createEvent({
            id,
            title: title.trim(),
            note: notes,
            startsAt,
            endsAt,
            reminderMinutesBefore: 15,
            updatedAt,
          });
        }
      }
      if (!isEditing) await storage.bumpEntryCount();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e) {
      Alert.alert(t('form.saveFailed'), (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!editingId) return;
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: title || '—' }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            // Tasks and events are separate resources with separate ids.
            if (isTask) await api.deleteTask(editingId);
            else await api.deleteEvent(editingId);
            navigation.goBack();
          } catch (e) {
            Alert.alert(t('common.error'), (e as Error).message);
          }
        },
      },
    ]);
  };

  const close = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigation.goBack();
  };

  const heading = isEditing
    ? isTask
      ? t('form.editTask')
      : t('form.editEvent')
    : isTask
      ? t('form.newTask')
      : t('form.newEvent');
  const cta = isTask ? t('form.createTask') : t('form.createEvent');
  // The same glyphs Home's counts use for the two kinds, on the same discs —
  // except a task's is the to-do mark rather than the tick, which beside the
  // save disc would read as a second way to save.
  const KindGlyph = isTask ? ListTodo : CalendarDays;

  return (
    <Screen clearTabBar={false}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {/* The form builds in reading order as the sheet comes up: the chrome,
            what this is, then each field, then the button. A task and an event
            have the same number of date groups, so the button lands on the same
            beat for both. */}

        {/* ── Chrome: close at the start, delete and save at the end ── */}
        <View style={styles.chromeRow}>
          <Entrance delay={at(0)} from={RISE}>
            <Pressable
              onPress={close}
              style={({ pressed }) => [styles.chrome, pressed && styles.pressedDim]}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
            >
              <X color={colors.text} size={20} />
            </Pressable>
          </Entrance>
          <Entrance delay={at(1)} from={RISE} style={styles.chromeEnd}>
            {isEditing ? (
              <Pressable
                onPress={remove}
                style={({ pressed }) => [styles.chrome, pressed && styles.pressedDim]}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
              >
                <Trash2 color={colors.danger} size={19} />
              </Pressable>
            ) : null}
            {/* The breath is on a wrapper, not the button: the press has its
                own spring on the button's scale, and the two would fight. */}
            <Animated.View style={{ transform: [{ scale: saveScale }] }}>
              <Pressable
                onPress={save}
                style={({ pressed }) => [
                  styles.chrome,
                  styles.chromeSave,
                  pressed && styles.pressedDim,
                ]}
                accessibilityRole="button"
                accessibilityLabel={cta}
              >
                <LinearGradient
                  colors={NIGHT.blue}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  // Rounded itself rather than clipped by the disc: clipping on
                  // iOS takes the disc's glow with it.
                  style={[StyleSheet.absoluteFill, styles.chromeSaveFill]}
                />
                {/* In a View of its own: on the web the fill above is positioned and
                    a bare svg is not, so the fill would paint over the check. */}
                <View pointerEvents="none">
                  <Check color={colors.primaryText} size={20} strokeWidth={2.4} />
                </View>
              </Pressable>
            </Animated.View>
          </Entrance>
        </View>

        {/* ── What this is: the kind's disc, and the title, big ── */}
        <Entrance delay={at(2)} from={RISE} style={styles.titleRow}>
          <LitDisc colors={isTask ? NIGHT.discs.tasks : NIGHT.discs.meetings} size={40}>
            <KindGlyph color={NIGHT.glyph} size={19} strokeWidth={2.2} />
          </LitDisc>
          <Text
            style={[styles.screenTitle, { textAlign: alignStart() }]}
            accessibilityRole="header"
          >
            {heading}
          </Text>
        </Entrance>

        {/* ── Title ── */}
        <Entrance delay={at(3)} from={RISE}>
          <Field
            label={isTask ? t('form.taskTitle') : t('form.eventTitle')}
            value={title}
            onChangeText={setTitle}
            placeholder={isTask ? t('form.taskPlaceholder') : t('form.eventPlaceholder')}
          />
        </Entrance>

        {/* ── Description ── */}
        <Entrance delay={at(4)} from={RISE}>
          <Field
            label={t('form.description')}
            value={body}
            onChangeText={setBody}
            placeholder={t('form.descriptionPlaceholder')}
            style={styles.multiline}
            multiline
            numberOfLines={4}
          />
        </Entrance>

        {/* A task can carry a start date as well as a due date; an event's
            start lives in the date/time fields below instead. */}
        {isTask ? (
          <Entrance delay={at(5)} from={RISE}>
            <Text style={styles.label}>{t('form.startDate')}</Text>
            <View style={styles.rowGap}>
              <View style={{ flex: 1.4 }}>
                <IconInput
                  icon={<CalendarIcon color={colors.textMuted} size={17} />}
                  value={startDate}
                  onChangeText={setStartDate}
                  placeholder="2026-07-25"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={{ flex: 1 }}>
                <IconInput
                  icon={<Clock color={colors.textMuted} size={17} />}
                  value={startTime}
                  onChangeText={setStartTime}
                  placeholder="09:00"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>
          </Entrance>
        ) : null}

        {/* ── Due Date & time — dueAt for tasks, startsAt for events ── */}
        <Entrance delay={at(isTask ? 6 : 5)} from={RISE}>
          <Text style={styles.label}>{t('form.dueDate')}</Text>
          <View style={styles.rowGap}>
            <View style={{ flex: 1.4 }}>
              <IconInput
                icon={<CalendarIcon color={colors.textMuted} size={17} />}
                value={date}
                onChangeText={setDate}
                placeholder="2026-07-25"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={{ flex: 1 }}>
              <IconInput
                icon={<Clock color={colors.textMuted} size={17} />}
                value={time}
                onChangeText={setTime}
                placeholder="10:00"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>
        </Entrance>

        {/* An event has an end as well as a start; a task only has a due
            moment, so this belongs to events alone. */}
        {!isTask ? (
          <Entrance delay={at(6)} from={RISE}>
            <Text style={styles.label}>{t('form.endTime')}</Text>
            <View style={styles.fieldGap}>
              <IconInput
                icon={<Clock color={colors.textMuted} size={17} />}
                value={endTime}
                onChangeText={setEndTime}
                placeholder="11:00"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </Entrance>
        ) : null}

        {/* ── Priority ── */}
        <Entrance delay={at(7)} from={RISE}>
          <Text style={styles.label}>{t('form.priority')}</Text>
          <View style={styles.rowGap}>
            {(Object.keys(PRIORITY_COLORS) as Priority[]).map((p) => {
              const pc = PRIORITY_COLORS[p];
              const active = priority === p;
              return (
                <Pressable
                  key={p}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setPriority(active ? null : p);
                  }}
                  style={({ pressed }) => [
                    styles.priorityChip,
                    active && styles.priorityChipOn,
                    pressed && styles.pressedDim,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  {/* The chosen one's tint and edge spring in rather than
                      switching on. The chip goes clear under them, so once
                      landed they sit on the page exactly as the chip's own
                      background did. The dot and label after it are positioned
                      views on the web too, so the fill stays under them. */}
                  {active ? (
                    <PopIn
                      from={0.8}
                      style={[
                        styles.priorityFill,
                        { backgroundColor: pc.bg, borderColor: pc.color },
                      ]}
                    />
                  ) : null}
                  <View style={[styles.priorityDot, { backgroundColor: pc.color }]} />
                  <Text
                    style={[
                      styles.priorityText,
                      active && [styles.priorityTextOn, { color: pc.color }],
                    ]}
                  >
                    {p}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Entrance>

        <View style={{ height: spacing.lg }} />
        <Entrance delay={at(8)} from={RISE}>
          <Button label={cta} onPress={save} loading={saving} />
        </Entrance>
      </ScrollView>
    </Screen>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    /** A press that reads as a press without moving anything under the finger. */
    pressedDim: { opacity: 0.72 },

    /**
     * Out to the page's edges and down to its foot.
     *
     * The scroll clips to its own box, so inside the page's padding it would
     * shave the glow off the save disc and the button at the bottom. It undoes
     * the padding and carries the same amount inside, with room at the foot for
     * the button's glow.
     */
    scroll: { marginHorizontal: -SCREEN_PAD, marginBottom: -spacing.lg },
    scrollContent: {
      paddingHorizontal: SCREEN_PAD,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xl + spacing.sm,
    },

    // ── Chrome ──
    chromeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    chromeEnd: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    /** A round pane of glass, like the bell on Home. */
    chrome: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: NIGHT.cardAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** Save is the lit one: the button's blue, glowing the way the chosen day does. */
    chromeSave: {
      backgroundColor: NIGHT.blue[1],
      borderWidth: 0,
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 10,
      elevation: 6,
    },
    chromeSaveFill: { borderRadius: 22 },

    // ── Title ──
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      marginTop: spacing.lg,
      marginBottom: spacing.lg,
    },
    screenTitle: {
      flex: 1,
      fontSize: 32,
      lineHeight: 36,
      ...font(700),
      color: colors.text,
      letterSpacing: -1,
    },

    // ── Fields ──
    /** The label `Field` sets over its input, for the rows built here. */
    label: {
      ...font(600),
      fontSize: 15,
      color: colors.text,
      marginBottom: spacing.sm,
    },
    multiline: { minHeight: 104, textAlignVertical: 'top' },

    rowGap: { flexDirection: 'row', gap: 10, marginBottom: spacing.md },
    fieldGap: { marginBottom: spacing.md },
    /** `Field`'s input, with room for a glyph. */
    iconInput: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: 14,
    },
    iconInputText: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 16,
      fontSize: 15,
      ...font(400),
      color: colors.text,
    },

    // ── Priority ──
    /**
     * Glass until chosen, then its own colour's tint and edge. The edge is a
     * full pixel either way, so choosing one doesn't nudge its label; the dot
     * keeps each one's colour in sight while it is still glass.
     */
    priorityChip: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      minHeight: 48,
      borderRadius: 14,
      backgroundColor: NIGHT.card,
      borderWidth: 1,
      borderColor: NIGHT.line,
    },
    /** Chosen: the chip steps aside for the fill, keeping its edge's width. */
    priorityChipOn: { backgroundColor: 'transparent', borderColor: 'transparent' },
    /**
     * The chosen chip's tint and edge. Out by the width of the chip's own edge on
     * every side — an absolute child starts inside its parent's border — so it
     * covers the chip exactly.
     */
    priorityFill: {
      position: 'absolute',
      top: -1,
      left: -1,
      right: -1,
      bottom: -1,
      borderRadius: 14,
      borderWidth: 1,
    },
    priorityDot: { width: 7, height: 7, borderRadius: 3.5 },
    priorityText: { ...font(600), fontSize: 15, color: colors.textMuted },
    priorityTextOn: { ...font(700) },
  }),
);
