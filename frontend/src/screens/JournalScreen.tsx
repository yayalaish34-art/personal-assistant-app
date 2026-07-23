import { useCallback, useState } from 'react';
import { FlatList, View, Pressable, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Screen, Card, Title, Muted, Button } from '../components/ui';
import { api, JournalEntry } from '../lib/api';
import type { RootStackParamList } from '../navigation';
import { spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const moodEmoji: Record<string, string> = {
  good: '😀',
  neutral: '😐',
  bad: '😞',
};

export default function JournalScreen() {
  const navigation = useNavigation<Nav>();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const data = await api.listJournal();
        if (active) {
          setEntries(data);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const confirmDelete = (entry: JournalEntry) => {
    Alert.alert('מחיקת רשומה', `למחוק את "${entry.title}"?`, [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'מחק',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteJournal(entry.id);
            load();
          } catch (e) {
            Alert.alert('שגיאה', (e as Error).message);
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <View style={{ marginBottom: spacing.md }}>
            <Button
              label="+ רשומה חדשה"
              onPress={() => navigation.navigate('EntryForm', { kind: 'journal' })}
            />
          </View>
        }
        ListEmptyComponent={
          <Card>
            <Title>{error ? 'שגיאה בטעינה' : 'אין רשומות עדיין'}</Title>
            <Muted>{error ?? 'צור את רשומת היומן הראשונה שלך.'}</Muted>
          </Card>
        }
        renderItem={({ item }) => (
          <Pressable onLongPress={() => confirmDelete(item)}>
            <Card>
              <Title>
                {moodEmoji[item.mood] ?? ''} {item.title}
              </Title>
              {item.body ? <Muted>{item.body}</Muted> : null}
              <View style={{ height: spacing.sm }} />
              <Muted>{new Date(item.createdAt).toLocaleString('he-IL')}</Muted>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}
