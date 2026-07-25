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
import { api } from '../lib/api';
import { storage } from '../lib/storage';
import { withPriority, toDateStr } from '../lib/tasks';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, PRIORITY_COLORS, type Priority } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'EntryForm'>;
type Route = RouteProp<RootStackParamList, 'EntryForm'>;

const PROJECTS = ['Personal', 'Work', 'Website Redesign'];

const MOODS: { key: string; label: string; palette: { color: string; bg: string } }[] = [
  { key: 'good', label: 'Good', palette: PRIORITY_COLORS.Low },
  { key: 'neutral', label: 'Okay', palette: PRIORITY_COLORS.Medium },
  { key: 'bad', label: 'Low', palette: PRIORITY_COLORS.High },
];

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
  const isJournal = kind === 'journal';

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mood, setMood] = useState('neutral');
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
      Alert.alert('Missing title', 'Please enter a title.');
      return;
    }
    setSaving(true);
    try {
      if (isJournal) {
        await api.createJournal({ title: title.trim(), body, mood });
      } else {
        if (!date.trim()) {
          Alert.alert('Missing date', 'Enter a date as YYYY-MM-DD.');
          setSaving(false);
          return;
        }
        await api.createEvent({
          title: title.trim(),
          date: date.trim(),
          time: time.trim(),
          notes: withPriority(body, priority),
        });
      }
      await storage.bumpEntryCount();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e) {
      Alert.alert('Couldn’t save', (e as Error).message);
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
          <Text style={styles.headerTitle}>{isJournal ? 'New Journal Entry' : 'Add New Task'}</Text>
          <Pressable onPress={save} style={styles.circleWhite}>
            <Check color={colors.text} size={20} />
          </Pressable>
        </View>

        {/* ── Title ── */}
        <Text style={styles.label}>{isJournal ? 'Entry Title' : 'Task Title'}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={isJournal ? 'What’s on your mind?' : 'Finish landing page design'}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />

        {/* ── Description ── */}
        <Text style={styles.label}>Description</Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder={
            isJournal ? 'Write it down…' : 'Design the new landing page for the product launch.'
          }
          placeholderTextColor={colors.textMuted}
          style={[styles.input, styles.inputMultiline]}
          multiline
          numberOfLines={4}
        />

        {!isJournal && (
          <>
            {/* ── Due Date & time ── */}
            <Text style={styles.label}>Due Date {'&'} time</Text>
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
            <Text style={styles.label}>Priority</Text>
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
            <Text style={styles.label}>Project</Text>
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
            <Text style={styles.label}>Tags</Text>
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

        {isJournal && (
          <>
            <Text style={styles.label}>Mood</Text>
            <View style={styles.rowGap}>
              {MOODS.map((m) => {
                const active = mood === m.key;
                return (
                  <Pressable
                    key={m.key}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setMood(m.key);
                    }}
                    style={[
                      styles.priorityPill,
                      { borderColor: m.palette.color },
                      active && { backgroundColor: m.palette.bg },
                    ]}
                  >
                    <Text style={[styles.priorityText, { color: m.palette.color }]}>{m.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        <View style={{ height: spacing.lg }} />
        <Button
          label={isJournal ? 'Save Entry' : 'Create Task'}
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
  headerTitle: { fontWeight: '600', fontSize: 16, color: colors.text },
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
    fontWeight: '500',
    fontSize: 14,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: 15,
    fontSize: 15,
    fontWeight: '400',
    color: colors.text,
    marginBottom: spacing.md + 2,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },

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
    paddingVertical: 15,
    fontSize: 14,
    fontWeight: '400',
    color: colors.text,
  },

  priorityPill: {
    flex: 1,
    borderWidth: 1.4,
    borderRadius: 50,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  priorityText: { fontWeight: '500', fontSize: 14 },

  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 15,
    marginBottom: spacing.md + 2,
  },
  projectText: { fontWeight: '500', fontSize: 14, color: colors.text },

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
    paddingVertical: 8,
  },
  tagText: { fontWeight: '500', fontSize: 13, color: colors.primary },
  tagAdd: { borderColor: '#DDD6E4' },
  tagInput: {
    minWidth: 70,
    borderWidth: 1.2,
    borderColor: '#C9BCF7',
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingHorizontal: 13,
    paddingVertical: 8,
    fontWeight: '400',
    fontSize: 13,
    color: colors.text,
  },
});
