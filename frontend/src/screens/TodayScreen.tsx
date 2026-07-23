import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Screen, Card, Title, Muted, Button } from '../components/ui';
import { api, CalendarEvent } from '../lib/api';
import { storage } from '../lib/storage';
import type { RootStackParamList } from '../navigation';
import { spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function TodayScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [count, setCount] = useState(0);
  const [todayEvents, setTodayEvents] = useState<CalendarEvent[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const settings = await storage.getSettings();
      const c = await storage.getEntryCount();
      if (!active) return;
      setName(settings.displayName);
      setCount(c);
      try {
        await api.health();
        const events = await api.listEvents(today);
        if (!active) return;
        setOnline(true);
        setTodayEvents(events);
      } catch {
        if (active) setOnline(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [today]);

  useFocusEffect(load);

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Title>{name ? `שלום, ${name} 👋` : 'שלום 👋'}</Title>
        <Muted>הנה מבט מהיר על היום שלך.</Muted>

        <View style={{ height: spacing.lg }} />

        <Card>
          <Muted>אירועים היום</Muted>
          <Title>{todayEvents.length}</Title>
          {todayEvents.slice(0, 3).map((e) => (
            <Muted key={e.id}>
              • {e.time ? `${e.time} — ` : ''}
              {e.title}
            </Muted>
          ))}
          {todayEvents.length === 0 && online !== false ? (
            <Muted>אין אירועים מתוזמנים.</Muted>
          ) : null}
        </Card>

        <Card>
          <Muted>רשומות שנוצרו (מקומי)</Muted>
          <Title>{count}</Title>
        </Card>

        <Card>
          <Muted>סטטוס שרת</Muted>
          <Title>
            {online === null ? '…' : online ? '🟢 מחובר' : '🔴 לא זמין'}
          </Title>
          {online === false ? (
            <Muted>ודא שה-Backend רץ על פורט 5000 ושכתובת ה-API נכונה בהגדרות.</Muted>
          ) : null}
        </Card>

        <Button label="+ רשומת יומן חדשה" onPress={() => navigation.navigate('EntryForm', { kind: 'journal' })} />
        <View style={{ height: spacing.sm }} />
        <Button
          label="+ אירוע חדש"
          variant="ghost"
          onPress={() => navigation.navigate('EntryForm', { kind: 'event' })}
        />
      </ScrollView>
    </Screen>
  );
}
