import { useCallback, useState } from 'react';
import { ScrollView, View, Switch, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Screen, Card, Title, Muted, Field, Button } from '../components/ui';
import { storage, defaultSettings, Settings } from '../lib/storage';
import { api } from '../lib/api';
import { colors, spacing } from '../theme';

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [count, setCount] = useState(0);

  const load = useCallback(() => {
    let active = true;
    (async () => {
      const s = await storage.getSettings();
      const c = await storage.getEntryCount();
      if (active) {
        setSettings(s);
        setCount(c);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  const save = async () => {
    await storage.saveSettings(settings);
    Alert.alert('נשמר', 'ההגדרות עודכנו.');
  };

  const testConnection = async () => {
    // Persist first so the API client reads the new base URL.
    await storage.saveSettings(settings);
    try {
      await api.health();
      Alert.alert('מחובר 🟢', 'השרת מגיב.');
    } catch (e) {
      Alert.alert('לא זמין 🔴', (e as Error).message);
    }
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Card>
          <Title>פרופיל</Title>
          <Field
            label="שם תצוגה"
            value={settings.displayName}
            onChangeText={(displayName) => setSettings((s) => ({ ...s, displayName }))}
            placeholder="השם שלך"
          />
        </Card>

        <Card>
          <Title>חיבור לשרת</Title>
          <Field
            label="כתובת API"
            value={settings.apiBaseUrl}
            onChangeText={(apiBaseUrl) => setSettings((s) => ({ ...s, apiBaseUrl }))}
            placeholder="http://localhost:5000"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Muted>
            במכשיר פיזי החלף את localhost בכתובת ה-IP של המחשב (לדוגמה http://192.168.1.10:5000).
          </Muted>
          <View style={{ height: spacing.sm }} />
          <Button label="בדוק חיבור" variant="ghost" onPress={testConnection} />
        </Card>

        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Title>התראות</Title>
            <Switch
              value={settings.notifications}
              onValueChange={(notifications) => setSettings((s) => ({ ...s, notifications }))}
              trackColor={{ true: colors.primary, false: colors.surfaceAlt }}
            />
          </View>
        </Card>

        <Card>
          <Muted>סה"כ רשומות שנוצרו (מקומי)</Muted>
          <Title>{count}</Title>
        </Card>

        <Button label="שמור הגדרות" onPress={save} />
      </ScrollView>
    </Screen>
  );
}
