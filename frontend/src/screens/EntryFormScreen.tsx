import { useState } from 'react';
import { ScrollView, View, Text, TextInput, Pressable, StyleSheet, Alert } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import {
  X,
  Check,
  Calendar as CalendarIcon,
  Clock,
  Folder,
  ChevronDown,
  Plus,
} from 'lucide-react-native';

import { Screen, Button } from '../components/ui';
import { api, uuid } from '../lib/api';
import { storage } from '../lib/storage';
import { withPriority, toDateStr, toUtcIso, nowIso, plusHour } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, PRIORITY_COLORS, type Priority } from '../theme';
import { t } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList, 'EntryForm'>;
type Route = RouteProp<RootStackParamList, 'EntryForm'>;

const PROJECTS = ['Personal', 'Work', 'Website Redesign'];

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
  const { kind } = useRoute<Route>().params;
  const isTask = kind === 'task';

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority | null>('Medium');
  const [date, setDate] = useState(toDateStr(new Date()));
  const [time, setTime] = useState('');
  const [project, setProject] = useState(0);
  const [tags, setTags] = useState<string[]>(['Design', 'UI/UX', 'Work']);
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) {
      Alert.alert(t('form.missingTitle'), t('form.missingTitleBody'));
      return;
    }
    setSaving(true);
    try {
      // Ids are client-generated so creates work offline and replays are
      // idempotent server-side (200 on same-id replay, 409 across users).
      const id = uuid();
      const updatedAt = nowIso();
      const notes = withPriority(body, priority);

      if (isTask) {
        await api.createTask({
          id,
          title: title.trim(),
          notes,
          // An undated task is valid: dueAt is nullable.
          dueAt: date.trim() ? toUtcIso(date.trim(), time.trim() || '09:00') : undefined,
          updatedAt,
        });
      } else {
        if (!date.trim()) {
          Alert.alert(t('form.missingDate'), t('form.missingDateBody'));
          setSaving(false);
          return;
        }
        const startTime = time.trim() || '09:00';
        await api.createEvent({
          id,
          title: title.trim(),
          note: notes,
          // Events are UTC instants; convert from the local date + time.
          startsAt: toUtcIso(date.trim(), startTime),
          endsAt: toUtcIso(date.trim(), plusHour(startTime)),
          reminderMinutesBefore: 15,
          updatedAt,
        });
      }
      await storage.bumpEntryCount();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e) {
      Alert.alert(t('form.saveFailed'), (e as Error).message);
    } finally {
      setSaving(false);
    }
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
          <Text style={styles.headerTitle}>{isTask ? t('form.newTask') : t('form.newEvent')}</Text>
          <Pressable onPress={save} style={styles.circleWhite}>
            <Check color={colors.text} size={20} />
          </Pressable>
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

            {/* ── Project ── */}
            <Text style={styles.label}>{t('form.project')}</Text>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setProject((p) => (p + 1) % PROJECTS.length);
              }}
              style={styles.projectRow}
            >
              <Folder color={colors.text} size={18} />
              <Text style={styles.projectText}>{PROJECTS[project]}</Text>
              <View style={{ flex: 1 }} />
              <ChevronDown color={colors.textMuted} size={18} />
            </Pressable>

            {/* ── Tags ── */}
            <Text style={styles.label}>{t('form.tags')}</Text>
            <View style={styles.tagsRow}>
              {tags.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setTags((prev) => prev.filter((x) => x !== t));
                  }}
                  style={styles.tagChip}
                >
                  <Text style={styles.tagText}>{t}</Text>
                  <X color={colors.primary} size={13} />
                </Pressable>
              ))}
              {addingTag ? (
                <TextInput
                  value={newTag}
                  onChangeText={setNewTag}
                  autoFocus
                  placeholder="Tag"
                  placeholderTextColor={colors.textMuted}
                  style={styles.tagInput}
                  onSubmitEditing={() => {
                    const t = newTag.trim();
                    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
                    setNewTag('');
                    setAddingTag(false);
                  }}
                  onBlur={() => setAddingTag(false)}
                />
              ) : (
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setAddingTag(true);
                  }}
                  style={[styles.tagChip, styles.tagAdd]}
                >
                  <Plus color={colors.text} size={13} />
                  <Text style={[styles.tagText, { color: colors.text }]}>Add</Text>
                </Pressable>
              )}
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

  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 17,
    marginBottom: spacing.md + 2,
  },
  projectText: { ...font(500), fontSize: 14, color: colors.text },

  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, alignItems: 'center' },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.2,
    borderColor: '#C9BCF7',
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  tagText: { ...font(500), fontSize: 13, color: colors.primary },
  tagAdd: { borderColor: '#DDD6E4' },
  tagInput: {
    minWidth: 70,
    borderWidth: 1.2,
    borderColor: '#C9BCF7',
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingHorizontal: 13,
    paddingVertical: 9,
    ...font(400),
    fontSize: 13,
    color: colors.text,
  },
});
