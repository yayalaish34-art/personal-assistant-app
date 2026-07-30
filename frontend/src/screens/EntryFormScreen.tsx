import { useMemo, useState } from 'react';
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
import { useTheme } from '../lib/theme';
import { api, uuid } from '../lib/api';
import { storage } from '../lib/storage';
import { withPriority, toDateStr, toUtcIso, nowIso, plusHour } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { spacing, radius, font, priorityColors, type Priority, type Palette } from '../theme';
import { t, isRTL } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList, 'EntryForm'>;
type Route = RouteProp<RootStackParamList, 'EntryForm'>;

type Styles = ReturnType<typeof makeStyles>;

const PROJECTS = ['Personal', 'Work', 'Website Redesign'];

// Input with a leading icon, matching the mockup's date/time fields.
function IconInput({
  icon,
  c,
  styles,
  ...rest
}: {
  icon: React.ReactNode;
  c: Palette;
  styles: Styles;
} & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.iconInput}>
      {icon}
      <TextInput placeholderTextColor={c.textMuted} style={styles.iconInputText} {...rest} />
    </View>
  );
}

export default function EntryFormScreen() {
  const navigation = useNavigation<Nav>();
  const { kind } = useRoute<Route>().params;
  const isTask = kind === 'task';
  const { palette: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const pColors = useMemo(() => priorityColors(c), [c]);

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
          <Pressable onPress={close} style={styles.circleMuted}>
            <X color={c.text} size={20} />
          </Pressable>
          <Text style={styles.headerTitle}>{isTask ? t('form.newTask') : t('form.newEvent')}</Text>
          <Pressable onPress={save} style={styles.circleAccent}>
            <Check color={c.onAccent} size={20} />
          </Pressable>
        </View>

        {/* ── Title ── */}
        <Text style={[styles.label, { textAlign: isRTL() ? 'right' : 'left' }]}>
          {isTask ? t('form.taskTitle') : t('form.eventTitle')}
        </Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={isTask ? t('form.taskPlaceholder') : t('form.eventPlaceholder')}
          placeholderTextColor={c.textMuted}
          style={styles.input}
        />

        {/* ── Description ── */}
        <Text style={[styles.label, { textAlign: isRTL() ? 'right' : 'left' }]}>
          {t('form.description')}
        </Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder={t('form.descriptionPlaceholder')}
          placeholderTextColor={c.textMuted}
          style={[styles.input, styles.inputMultiline]}
          multiline
          numberOfLines={4}
        />

        {(
          <>
            {/* ── Due Date & time — dueAt for tasks, startsAt for events ── */}
            <Text style={[styles.label, { textAlign: isRTL() ? 'right' : 'left' }]}>
              {t('form.dueDate')}
            </Text>
            <View style={styles.rowGap}>
              <View style={{ flex: 1.4 }}>
                <IconInput
                  icon={<CalendarIcon color={c.textMuted} size={17} />}
                  c={c}
                  styles={styles}
                  value={date}
                  onChangeText={setDate}
                  placeholder="2026-07-25"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={{ flex: 1 }}>
                <IconInput
                  icon={<Clock color={c.textMuted} size={17} />}
                  c={c}
                  styles={styles}
                  value={time}
                  onChangeText={setTime}
                  placeholder="10:00"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>

            {/* ── Priority ── */}
            <Text style={[styles.label, { textAlign: isRTL() ? 'right' : 'left' }]}>
              {t('form.priority')}
            </Text>
            <View style={styles.rowGap}>
              {(Object.keys(pColors) as Priority[]).map((p) => {
                const pc = pColors[p];
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
                      { borderColor: pc.bg },
                      active ? { backgroundColor: pc.bg } : { backgroundColor: 'transparent' },
                    ]}
                  >
                    <Text style={[styles.priorityText, { color: active ? pc.color : pc.bg }]}>
                      {t(`form.priority.${p.toLowerCase()}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* ── Project ── */}
            <Text style={[styles.label, { textAlign: isRTL() ? 'right' : 'left' }]}>
              {t('form.project')}
            </Text>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setProject((p) => (p + 1) % PROJECTS.length);
              }}
              style={styles.projectRow}
            >
              <Folder color={c.text} size={18} />
              <Text style={styles.projectText}>{PROJECTS[project]}</Text>
              <View style={{ flex: 1 }} />
              <ChevronDown color={c.textMuted} size={18} />
            </Pressable>

            {/* ── Tags ── */}
            <Text style={[styles.label, { textAlign: isRTL() ? 'right' : 'left' }]}>
              {t('form.tags')}
            </Text>
            <View style={styles.tagsRow}>
              {tags.map((tag) => (
                <Pressable
                  key={tag}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setTags((prev) => prev.filter((x) => x !== tag));
                  }}
                  style={styles.tagChip}
                >
                  <Text style={styles.tagText}>{tag}</Text>
                  <X color={c.textMuted} size={13} />
                </Pressable>
              ))}
              {addingTag ? (
                <TextInput
                  value={newTag}
                  onChangeText={setNewTag}
                  autoFocus
                  placeholder={t('form.tagPlaceholder')}
                  placeholderTextColor={c.textMuted}
                  style={styles.tagInput}
                  onSubmitEditing={() => {
                    const tag = newTag.trim();
                    if (tag && !tags.includes(tag)) setTags((prev) => [...prev, tag]);
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
                  <Plus color={c.primary} size={13} />
                  <Text style={[styles.tagText, { color: c.primary }]}>{t('form.addTag')}</Text>
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

function makeStyles(c: Palette) {
  return StyleSheet.create({
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.lg,
    },
    headerTitle: {
      ...font(700),
      fontSize: 17,
      color: c.text,
      flex: 1,
      textAlign: 'center',
    },
    circleMuted: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    circleAccent: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },

    label: {
      ...font(500),
      fontSize: 14,
      color: c.text,
      marginBottom: spacing.sm,
    },
    input: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: 17,
      fontSize: 15,
      ...font(400),
      color: c.text,
      textAlign: 'auto',
      marginBottom: spacing.md + 2,
    },
    inputMultiline: { minHeight: 104, textAlignVertical: 'top' },

    rowGap: { flexDirection: 'row', gap: 10, marginBottom: spacing.md + 2 },
    iconInput: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 14,
    },
    iconInputText: {
      flex: 1,
      paddingVertical: 17,
      fontSize: 14,
      ...font(400),
      color: c.text,
      textAlign: 'auto',
    },

    priorityPill: {
      flex: 1,
      borderWidth: 1.4,
      borderRadius: radius.pill,
      paddingVertical: 14,
      alignItems: 'center',
    },
    priorityText: { ...font(500), fontSize: 14 },

    projectRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 14,
      paddingVertical: 17,
      marginBottom: spacing.md + 2,
    },
    projectText: { ...font(500), fontSize: 14, color: c.text },

    tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, alignItems: 'center' },
    tagChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      paddingHorizontal: 13,
      paddingVertical: 9,
    },
    tagText: { ...font(500), fontSize: 13, color: c.text },
    tagAdd: { borderColor: c.primary },
    tagInput: {
      minWidth: 70,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      paddingHorizontal: 13,
      paddingVertical: 9,
      ...font(400),
      fontSize: 13,
      color: c.text,
      textAlign: 'auto',
    },
  });
}
