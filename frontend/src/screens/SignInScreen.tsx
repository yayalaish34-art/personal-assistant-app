import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, TextInput } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Sparkles, LogIn, KeyRound } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api } from '../lib/api';
import { storage } from '../lib/storage';
import { colors, spacing, font, ACCENT_GRADIENT } from '../theme';

/**
 * Sign-in gate. Every data endpoint is behind `authMiddleware`, so without a
 * session the app can only show empty screens.
 *
 * Primary path is `POST /auth/dev`, which signs in as the permanent local dev
 * user (create it with `npx tsx --env-file=.env scripts/dev-user.mjs`). That
 * returns a 30-day refresh token, and the API client rotates it on 401, so
 * signing in is a one-time action.
 *
 * The paste-a-token field is a fallback for a hand-minted access token, which
 * expires after 15 minutes. Once GOOGLE_CLIENT_ID and expo-auth-session are
 * configured, `api.signInWithGoogle(idToken)` replaces both.
 */
export default function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const useToken = async () => {
    const t = token.trim();
    if (!t) {
      Alert.alert('No token', 'Paste an access token to continue.');
      return;
    }
    setBusy(true);
    try {
      // Store first so the client attaches the Bearer header, then verify it
      // against /me — a bad or expired token must not be persisted.
      await storage.saveSession({
        accessToken: t,
        refreshToken: '',
        user: { id: '', email: '', name: '', language: 'he', timezone: 'UTC' },
      });
      const { user } = await api.getMe();
      await storage.saveSession({
        accessToken: t,
        refreshToken: '',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          language: user.language,
          timezone: user.timezone,
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSignedIn();
    } catch (e) {
      await storage.clearSession();
      Alert.alert(
        'Token rejected',
        `${(e as Error).message}\n\nAccess tokens expire after 15 minutes — mint a fresh one.`,
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Signs in as the permanent local dev user via POST /auth/dev. The refresh
   * token it returns lasts 30 days and the API client rotates it automatically
   * on 401, so this is a one-time action — not a token that expires in 15 min.
   */
  const signInAsDev = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    try {
      const { user, accessToken, refreshToken } = await api.signInAsDevUser();
      await storage.saveSession({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          language: user.language,
          timezone: user.timezone,
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSignedIn();
    } catch (e) {
      Alert.alert(
        'Couldn’t sign in',
        `${(e as Error).message}

If the dev user is missing, run in backend/:
npx tsx --env-file=.env scripts/dev-user.mjs`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen clearTabBar={false}>
      <View style={styles.wrap}>
        <View style={styles.badge}>
          <Sparkles color={colors.primary} size={26} />
        </View>

        <Text style={styles.headline}>
          Welcome{'\n'}
          <Text style={styles.headlineStrong}>Back</Text>
        </Text>
        <Text style={styles.lede}>
          Sign in to load your tasks, events, and calendar from the server. The
          session lasts 30 days and renews itself.
        </Text>

        <Pressable
          onPress={signInAsDev}
          disabled={busy}
          style={({ pressed }) => [{ opacity: pressed || busy ? 0.9 : 1 }]}
        >
          <LinearGradient
            colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
            start={ACCENT_GRADIENT.start}
            end={ACCENT_GRADIENT.end}
            style={styles.primaryBtn}
          >
            <LogIn color="#fff" size={18} />
            <Text style={styles.primaryBtnText}>
              {busy ? 'Signing in…' : 'Continue as Dev User'}
            </Text>
          </LinearGradient>
        </Pressable>

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or paste a token</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.tokenBox}>
          <KeyRound color={colors.textMuted} size={17} />
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="Paste access token"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.tokenInput}
          />
        </View>

        <Pressable
          onPress={useToken}
          disabled={busy}
          style={({ pressed }) => [styles.ghostBtn, { opacity: pressed || busy ? 0.7 : 1 }]}
        >
          <Text style={styles.ghostBtnText}>{busy ? 'Verifying…' : 'Sign in with token'}</Text>
        </Pressable>

        <Text style={styles.hint}>
          Mint one in <Text style={styles.mono}>backend/</Text>:{'\n'}
          <Text style={styles.mono}>npx tsx --env-file=.env sign-token.ts {'<user-id>'}</Text>
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', paddingBottom: spacing.xl },
  badge: {
    width: 58,
    height: 58,
    borderRadius: 20,
    backgroundColor: '#EFE7FD',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md + 4,
  },
  headline: {
    ...font(400),
    fontSize: 34,
    lineHeight: 42,
    color: colors.text,
    letterSpacing: -0.6,
  },
  headlineStrong: { ...font(600) },
  lede: {
    ...font(400),
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.textMuted,
    marginTop: spacing.sm,
    marginBottom: spacing.lg + 4,
  },

  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: 50,
    paddingVertical: 18,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.32,
    shadowRadius: 14,
    elevation: 5,
  },
  primaryBtnText: { ...font(600), fontSize: 15.5, color: '#FFFFFF' },

  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: spacing.lg,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: 'rgba(25,23,33,0.10)' },
  dividerText: { ...font(500), fontSize: 12, color: colors.textMuted },

  tokenBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderRadius: 16,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(136,117,246,0.18)',
  },
  tokenInput: {
    flex: 1,
    ...font(400),
    fontSize: 14,
    color: colors.text,
    paddingVertical: 16,
  },

  ghostBtn: {
    marginTop: 12,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: 50,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(136,117,246,0.22)',
  },
  ghostBtnText: { ...font(600), fontSize: 14.5, color: colors.primary },

  hint: {
    ...font(400),
    fontSize: 11.5,
    lineHeight: 18,
    color: colors.textMuted,
    marginTop: spacing.md + 2,
  },
  mono: { fontSize: 11, color: colors.text },
});
