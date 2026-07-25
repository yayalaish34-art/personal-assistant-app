import { useCallback, useState } from 'react';
import { ScrollView, View, Text, TextInput, Switch, StyleSheet, Alert, Pressable } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { User, Globe, Bell, FileText } from 'lucide-react-native';

import { Screen, Button } from '../components/ui';
import { storage, defaultSettings, Settings } from '../lib/storage';
import { api } from '../lib/api';
import { colors, spacing } from '../theme';

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'U'
  );
}

// Lavender icon square, same pattern as the Today's Progress stat rows.
function IconSquare({ children }: { children: React.ReactNode }) {
  return <View style={styles.iconSquare}>{children}</View>;
}

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [count, setCount] = useState(0);
  const [testing, setTesting] = useState(false);

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
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await storage.saveSettings(settings);
    Alert.alert('Saved', 'Your settings were updated.');
  };

  const testConnection = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTesting(true);
    // Persist first so the API client reads the new base URL.
    await storage.saveSettings(settings);
    try {
      await api.health();
      Alert.alert('Connected', 'The server is responding.');
    } catch (e) {
      Alert.alert('Unavailable', (e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ── Headline ── */}
        <Text style={styles.headline}>Profile</Text>

        {/* ── Identity card ── */}
        <View style={styles.card}>
          <View style={styles.profileRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initialsOf(settings.displayName || 'You')}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.profileName}>{settings.displayName || 'Your name'}</Text>
              <Text style={styles.mutedText}>Personal workspace</Text>
            </View>
          </View>

          <View style={styles.cardHeaderRow}>
            <IconSquare>
              <User color={colors.primary} size={18} />
            </IconSquare>
            <Text style={styles.cardTitle}>Display Name</Text>
          </View>
          <TextInput
            value={settings.displayName}
            onChangeText={(displayName) => setSettings((s) => ({ ...s, displayName }))}
            placeholder="Your name"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
        </View>

        {/* ── Server card ── */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <IconSquare>
              <Globe color={colors.primary} size={18} />
            </IconSquare>
            <Text style={styles.cardTitle}>Server Connection</Text>
          </View>
          <TextInput
            value={settings.apiBaseUrl}
            onChangeText={(apiBaseUrl) => setSettings((s) => ({ ...s, apiBaseUrl }))}
            placeholder="http://localhost:5000"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Text style={[styles.mutedText, { marginTop: 10 }]}>
            On a physical device, replace localhost with your computer{'’'}s IP (e.g.
            http://192.168.1.10:5000).
          </Text>
          <Pressable
            onPress={testConnection}
            disabled={testing}
            style={[styles.ghostBtn, testing && { opacity: 0.6 }]}
          >
            <Text style={styles.ghostBtnText}>{testing ? 'Testing…' : 'Test Connection'}</Text>
          </Pressable>
        </View>

        {/* ── Notifications card ── */}
        <View style={styles.card}>
          <View style={[styles.cardHeaderRow, { marginBottom: 0 }]}>
            <IconSquare>
              <Bell color={colors.primary} size={18} />
            </IconSquare>
            <Text style={styles.cardTitle}>Notifications</Text>
            <View style={{ flex: 1 }} />
            <Switch
              value={settings.notifications}
              onValueChange={(notifications) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSettings((s) => ({ ...s, notifications }));
              }}
              trackColor={{ true: colors.primary, false: '#E5E0EC' }}
              thumbColor="#FFFFFF"
            />
          </View>
        </View>

        {/* ── Stats card ── */}
        <View style={styles.card}>
          <View style={[styles.cardHeaderRow, { marginBottom: 0 }]}>
            <IconSquare>
              <FileText color={colors.primary} size={18} />
            </IconSquare>
            <View>
              <Text style={styles.statValue}>{count}</Text>
              <Text style={styles.mutedText}>Entries created</Text>
            </View>
          </View>
        </View>

        <Button label="Save Settings" onPress={save} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headline: {
    fontWeight: '500',
    fontSize: 28,
    lineHeight: 34,
    color: colors.text,
    letterSpacing: -0.3,
    marginBottom: spacing.lg,
  },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: spacing.md + 2,
    marginBottom: 14,
    shadowColor: '#3F2E64',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },

  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: spacing.md + 2,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#E7DBF6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontWeight: '600', fontSize: 20, color: colors.primary },
  profileName: { fontWeight: '600', fontSize: 17, color: colors.text, marginBottom: 2 },

  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  iconSquare: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#F1EBFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontWeight: '600', fontSize: 16.5, color: colors.text },
  mutedText: { fontWeight: '400', fontSize: 13, color: colors.textMuted, lineHeight: 18 },

  input: {
    backgroundColor: '#F5F2F9',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    fontWeight: '400',
    color: colors.text,
  },

  ghostBtn: {
    marginTop: 12,
    backgroundColor: '#F1EDF8',
    borderRadius: 50,
    paddingVertical: 13,
    alignItems: 'center',
  },
  ghostBtnText: { fontWeight: '500', fontSize: 14, color: colors.text },

  statValue: { fontWeight: '600', fontSize: 21, color: colors.text },
});
