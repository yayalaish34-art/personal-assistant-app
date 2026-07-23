import { useCallback, useMemo, useState } from 'react';
import { SectionList, View, Pressable, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Screen, Card, Title, Muted, Button } from '../components/ui';
import { api, CalendarEvent } from '../lib/api';
import type { RootStackParamList } from '../navigation';
import { spacing, colors } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function CalendarScreen() {
  const navigation = useNavigation<Nav>();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      try {
        const data = await api.listEvents();
        if (active) {
          setEvents(data);
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

  // Group events by date into SectionList sections, sorted ascending.
  const sections = useMemo(() => {
    const byDate = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const list = byDate.get(e.date) ?? [];
      list.push(e);
      byDate.set(e.date, list);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        title: date,
        data: data.sort((a, b) => (a.time || '').localeCompare(b.time || '')),
      }));
  }, [events]);

  const confirmDelete = (evt: CalendarEvent) => {
    Alert.alert('מחיקת אירוע', `למחוק את "${evt.title}"?`, [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'מחק',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteEvent(evt.id);
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
      <View style={{ marginBottom: spacing.md }}>
        <Button label="+ אירוע חדש" onPress={() => navigation.navigate('EntryForm', { kind: 'event' })} />
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => (
          <Muted>
            {'  '}
            {section.title}
          </Muted>
        )}
        ListEmptyComponent={
          <Card>
            <Title>{error ? 'שגיאה בטעינה' : 'אין אירועים'}</Title>
            <Muted>{error ?? 'הוסף את האירוע הראשון שלך ללוח השנה.'}</Muted>
          </Card>
        }
        renderItem={({ item }) => (
          <Pressable onLongPress={() => confirmDelete(item)}>
            <Card>
              <Title>
                {item.time ? `${item.time}  ` : ''}
                {item.title}
              </Title>
              {item.notes ? <Muted>{item.notes}</Muted> : null}
            </Card>
          </Pressable>
        )}
        SectionSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
        stickySectionHeadersEnabled={false}
      />
    </Screen>
  );
}
