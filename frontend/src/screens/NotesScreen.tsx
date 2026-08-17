import { useCallback, useMemo, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  Modal,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, Plus, Pin, X, Trash2 } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api, type Note } from '../lib/api';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, radius } from '../theme';
import { t, locale } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const COLUMNS = 3;
const GRID_GAP = 12;
const SIDE_PADDING = spacing.md + 4; // matches Screen's own horizontal padding
/** Every note leans the same way — pinned on a board, not laid flat. */
const TILT = '5deg';

/** "12 Aug, 14:03" — short enough for a card this small. */
function noteStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

export default function NotesScreen() {
  const navigation = useNavigation<Nav>();
  const { width } = useWindowDimensions();
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState<Note | null>(null);

  const cardSize = (width - SIDE_PADDING * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS;

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const { notes: rows } = await api.listNotes();
        if (active) setNotes(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      } catch {
        /* local storage; nothing to retry against */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const confirmDelete = useCallback((note: Note) => {
    const snippet = note.text.length > 30 ? `${note.text.slice(0, 30)}…` : note.text;
    Alert.alert(t('common.deleteTitle'), t('common.deleteBody', { title: snippet }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteNote(note.id);
            setOpen((cur) => (cur?.id === note.id ? null : cur));
            setNotes((prev) => prev.filter((n) => n.id !== note.id));
          } catch (e) {
            Alert.alert(t('common.error'), (e as Error).message);
          }
        },
      },
    ]);
  }, []);

  const openAssistant = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate('Assistant');
  };

  const rows = useMemo(() => {
    const chunks: Note[][] = [];
    for (let i = 0; i < notes.length; i += COLUMNS) chunks.push(notes.slice(i, i + COLUMNS));
    return chunks;
  }, [notes]);

  return (
    <Screen>
      {/* ── Back, headline, add ── */}
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
          onPress={openAssistant}
          style={[styles.iconBtn, styles.iconBtnRaised]}
          accessibilityRole="button"
          accessibilityLabel={t('voice.title')}
        >
          <Plus color={colors.text} size={22} strokeWidth={2.2} />
        </Pressable>
      </View>

      <Text style={styles.headline}>{t('notes.title')}</Text>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.row}>
            {row.map((note) => (
              <Pressable
                key={note.id}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setOpen(note);
                }}
                onLongPress={() => confirmDelete(note)}
                style={[styles.noteWrap, { width: cardSize, height: cardSize }]}
                accessibilityRole="button"
                accessibilityLabel={note.text}
              >
                <View style={styles.pin}>
                  <Pin color={colors.danger} fill={colors.danger} size={16} strokeWidth={1.5} />
                </View>
                <View style={styles.noteCard}>
                  <Text style={styles.noteText} numberOfLines={4}>
                    {note.text}
                  </Text>
                  <Text style={styles.noteDate} numberOfLines={1}>
                    {noteStamp(note.createdAt)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ))}

        {notes.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t('notes.empty.title')}</Text>
            <Text style={styles.emptyBody}>{t('notes.empty.body')}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* ── The full note, tapped open ── */}
      <Modal visible={open !== null} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(null)}>
          {/* Swallow taps on the card itself so they don't fall through to the backdrop. */}
          <Pressable style={styles.fullCard} onPress={() => {}}>
            <View style={styles.fullHeaderRow}>
              <Pressable
                onPress={() => open && confirmDelete(open)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
              >
                <Trash2 color={colors.textMuted} size={19} />
              </Pressable>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => setOpen(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('notes.close')}
              >
                <X color={colors.textMuted} size={20} />
              </Pressable>
            </View>
            <ScrollView style={styles.fullBody} showsVerticalScrollIndicator={false}>
              <Text style={styles.fullText}>{open?.text}</Text>
            </ScrollView>
            <Text style={styles.fullDate}>{open ? noteStamp(open.createdAt) : ''}</Text>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  iconBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  iconBtnRaised: {
    backgroundColor: colors.surface,
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
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },

  list: { paddingBottom: spacing.md },
  row: { flexDirection: 'row', gap: GRID_GAP, marginBottom: spacing.lg },
  noteWrap: { transform: [{ rotate: TILT }] },
  pin: {
    position: 'absolute',
    top: -9,
    alignSelf: 'center',
    zIndex: 1,
  },
  noteCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: 10,
    justifyContent: 'space-between',
    shadowColor: '#14150F',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 3,
  },
  noteText: { fontSize: 12.5, ...font(500), color: colors.text, lineHeight: 17 },
  noteDate: { fontSize: 9.5, ...font(600), color: colors.textMuted, marginTop: 4 },

  empty: { alignItems: 'center', paddingVertical: spacing.xl, gap: 6 },
  emptyTitle: { fontSize: 17, ...font(700), color: colors.text },
  emptyBody: { fontSize: 14, ...font(500), color: colors.textMuted, textAlign: 'center' },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 21, 15, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  fullCard: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '75%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
  },
  fullHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  fullBody: { flexGrow: 0 },
  fullText: { fontSize: 16, ...font(500), color: colors.text, lineHeight: 24 },
  fullDate: {
    fontSize: 13,
    ...font(600),
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
});
