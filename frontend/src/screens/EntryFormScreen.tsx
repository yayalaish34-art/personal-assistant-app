import { useEffect, useState } from 'react';
import { ScrollView, View, Text, TextInput, Pressable, StyleSheet, Alert } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { X, Check, Calendar as CalendarIcon, Clock, Trash2 } from 'lucide-react-native';

import { Screen, Button } from '../components/ui';
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
import { colors, spacing, font, PRIORITY_COLORS, type Priority } from '../theme';
import { t } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList, 'EntryForm'>;
type Route = RouteProp<RootStackParamList, 'EntryForm'>;

// Input with a leading icon, matching the mockup's date/time fields.
function IconInput({
  icon,
  ...rest
}: { icon: React.ReactNode } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.iconInput}>
      {icon}
      <TextInput
        placeholderTextColor={colors.textMuted}
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

  return (
    <Screen clearTabBar={false}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* ── Header: X, title, ✓ ── */}
        <View style={styles.headerRow}>
          <Pressable onPress={close} style={styles.circleWhite}>
            <X color={colors.text} size={20} />
          </Pressable>
          <Text style={styles.headerTitle}>
            {isEditing
              ? isTask
                ? t('form.editTask')
                : t('form.editEvent')
              : isTask
                ? t('form.newTask')
                : t('form.newEvent')}
          </Text>
          <View style={styles.headerActions}>
            {isEditing ? (
              <Pressable onPress={remove} style={styles.circleWhite} accessibilityRole="button">
                <Trash2 color={colors.danger} size={19} />
              </Pressable>
            ) : null}
            <Pressable onPress={save} style={styles.circleWhite} accessibilityRole="button">
              <Check color={colors.text} size={20} />
            </Pressable>
          </View>
        </View>

        {/* ── Title ── */}
        <Text style={styles.label}>{isTask ? t('form.taskTitle') : t('form.eventTitle')}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={isTask ? t('form.taskPlaceholder') : t('form.eventPlaceholder')}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />

        {/* ── Description ── */}
        <Text style={styles.label}>{t('form.description')}</Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder={t('form.descriptionPlaceholder')}

          placeholderTextColor={colors.textMuted}
          style={[styles.input, styles.inputMultiline]}
          multiline
          numberOfLines={4}
        />

        {(
          <>
            {/* A task can carry a start date as well as a due date; an event's
                start lives in the date/time fields below instead. */}
            {isTask ? (
              <>
                <Text style={styles.label}>{t('form.startDate')}</Text>
                <View style={styles.rowGap}>
                  <View style={{ flex: 1.4 }}>
                    <IconInput
                      icon={<CalendarIcon color={colors.text} size={17} />}
                      value={startDate}
                      onChangeText={setStartDate}
                      placeholder="2026-07-25"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <IconInput
                      icon={<Clock color={colors.text} size={17} />}
                      value={startTime}
                      onChangeText={setStartTime}
                      placeholder="09:00"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                </View>
              </>
            ) : null}

            {/* ── Due Date & time — dueAt for tasks, startsAt for events ── */}
            <Text style={styles.label}>{t('form.dueDate')}</Text>
            <View style={styles.rowGap}>
              <View style={{ flex: 1.4 }}>
                <IconInput
                  icon={<CalendarIcon color={colors.text} size={17} />}
                  value={date}
                  onChangeText={setDate}
                  placeholder="2026-07-25"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={{ flex: 1 }}>
                <IconInput
                  icon={<Clock color={colors.text} size={17} />}
                  value={time}
                  onChangeText={setTime}
                  placeholder="10:00"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>

            {/* An event has an end as well as a start; a task only has a due
                moment, so this belongs to events alone. */}
            {!isTask ? (
              <>
                <Text style={styles.label}>{t('form.endTime')}</Text>
                <View style={{ flex: 1 }}>
                  <IconInput
                    icon={<Clock color={colors.text} size={17} />}
                    value={endTime}
                    onChangeText={setEndTime}
                    placeholder="11:00"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </>
            ) : null}

            {/* ── Priority ── */}
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
                    style={[
                      styles.priorityPill,
                      { borderColor: pc.color },
                      active && { backgroundColor: pc.bg },
                    ]}
                  >
                    <Text style={[styles.priorityText, { color: pc.color }]}>{p}</Text>
                  </Pressable>
                );
              })}
            </View>

          </>
        )}


        <View style={{ height: spacing.lg }} />
        <Button
          label={isTask ? t('form.createTask') : t('form.createEvent')}
          onPress={save}
          loading={saving}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  headerTitle: { ...font(600), fontSize: 16, color: colors.text },
  circleWhite: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },

  label: {
    ...font(500),
    fontSize: 14,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: 17,
    fontSize: 15,
    ...font(400),
    color: colors.text,
    marginBottom: spacing.md + 2,
  },
  inputMultiline: { minHeight: 104, textAlignVertical: 'top' },

  rowGap: { flexDirection: 'row', gap: 10, marginBottom: spacing.md + 2 },
  iconInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 14,
  },
  iconInputText: {
    flex: 1,
    paddingVertical: 17,
    fontSize: 14,
    ...font(400),
    color: colors.text,
  },

  priorityPill: {
    flex: 1,
    borderWidth: 1.4,
    borderRadius: 50,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  priorityText: { ...font(500), fontSize: 14 },
});
