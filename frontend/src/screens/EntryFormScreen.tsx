import { useState } from 'react';
import { ScrollView, View, Alert } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Screen, Field, Button, Muted, Title } from '../components/ui';
import { api } from '../lib/api';
import { storage } from '../lib/storage';
import type { RootStackParamList } from '../navigation';
import { spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'EntryForm'>;
type Route = RouteProp<RootStackParamList, 'EntryForm'>;

export default function EntryFormScreen() {
  const navigation = useNavigation<Nav>();
  const { kind } = useRoute<Route>().params;
  const isJournal = kind === 'journal';

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mood, setMood] = useState('neutral');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) {
      Alert.alert('חסר כותרת', 'יש להזין כותרת.');
      return;
    }
    setSaving(true);
    try {
      if (isJournal) {
        await api.createJournal({ title: title.trim(), body, mood });
      } else {
        if (!date.trim()) {
          Alert.alert('חסר תאריך', 'יש להזין תאריך בפורמט YYYY-MM-DD.');
          setSaving(false);
          return;
        }
        await api.createEvent({ title: title.trim(), date: date.trim(), time: time.trim(), notes: body });
      }
      await storage.bumpEntryCount();
      navigation.goBack();
    } catch (e) {
      Alert.alert('שגיאה בשמירה', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Title>{isJournal ? 'רשומת יומן חדשה' : 'אירוע חדש'}</Title>

        <Field label="כותרת" value={title} onChangeText={setTitle} placeholder="על מה מדובר?" />

        {!isJournal && (
          <>
            <Field label="תאריך (YYYY-MM-DD)" value={date} onChangeText={setDate} placeholder="2026-07-22" />
            <Field label="שעה (אופציונלי)" value={time} onChangeText={setTime} placeholder="10:00" />
          </>
        )}

        <Field
          label={isJournal ? 'תוכן' : 'הערות'}
          value={body}
          onChangeText={setBody}
          placeholder={isJournal ? 'מה קורה?' : 'פרטים נוספים…'}
          multiline
          numberOfLines={4}
          style={{ minHeight: 96, textAlignVertical: 'top' }}
        />

        {isJournal && (
          <View style={{ marginBottom: spacing.md }}>
            <Muted>מצב רוח</Muted>
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
              {(['good', 'neutral', 'bad'] as const).map((m) => (
                <View key={m} style={{ flex: 1 }}>
                  <Button
                    label={m === 'good' ? '😀' : m === 'neutral' ? '😐' : '😞'}
                    variant={mood === m ? 'primary' : 'ghost'}
                    onPress={() => setMood(m)}
                  />
                </View>
              ))}
            </View>
          </View>
        )}

        <Button label="שמור" onPress={save} loading={saving} />
      </ScrollView>
    </Screen>
  );
}
