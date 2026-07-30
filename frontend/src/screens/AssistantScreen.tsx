import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { MicButton } from '../components/MicButton';
import { X, Send, Check, Sparkles } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api, uuid, type ChatMessage } from '../lib/api';
import { respondTo, confirmationFor } from '../lib/assistant';
import type { RootStackParamList } from '../navigation';
import { useTheme } from '../lib/theme';
import { spacing, radius, font, cardStyle, type Palette } from '../theme';
import { t, isRTL } from '../lib/i18n';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Assistant'>;

/** Turns create_event/create_task arguments into a readable confirmation line. */
function describeAction(tool: string, args: Record<string, unknown>): string {
  const title = typeof args.title === 'string' ? args.title : 'Untitled';
  const when = args.startsAt ?? args.dueAt;
  if (typeof when === 'string') {
    const d = new Date(when);
    if (!Number.isNaN(d.getTime())) {
      const date = d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'long',
        day: 'numeric',
      });
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `${title}\n${date} at ${time}`;
    }
  }
  return title;
}

const ACTION_LABEL: Record<string, string> = {
  create_event: 'assistant.addEvent',
  create_task: 'assistant.addTask',
  update_event: 'assistant.updateEvent',
  update_task: 'assistant.updateTask',
  delete_event: 'assistant.deleteEvent',
  delete_task: 'assistant.deleteTask',
};

/** Adds alpha to a `#rrggbb` palette colour for a low-opacity border/fill. */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function AssistantScreen() {
  const navigation = useNavigation<Nav>();
  const { palette: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);

  // The + button opens straight into this screen, so put the cursor in the
  // composer rather than making the user tap again. The keyboard's own
  // dictation key gives voice input without a native audio module.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, []);

  const [isRecording, setIsRecording] = useState(false);



  const append = useCallback((incoming: ChatMessage[]) => {
    setMessages((prev) => [...prev, ...incoming]);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const failed = (e: unknown) => {
    Alert.alert(t('assistant.failed'), (e as Error).message);
  };

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || sending) return;
    setDraft('');
    setSending(true);
    // Render the user's line before parsing so the bubble appears instantly.
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content: body,
        toolCalls: null,
        toolCallId: null,
        pendingAction: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    try {
      const replies = await respondTo(body);
      append(replies);
      await api.appendChat(replies);
    } catch (e) {
      failed(e);
    } finally {
      setSending(false);
    }
  };

  const confirm = async (messageId: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSending(true);
    try {
      const target = messages.find((m) => m.id === messageId);
      const action = target?.pendingAction;
      if (!action) return;

      const args = action.arguments as Record<string, string | undefined>;
      const updatedAt = new Date().toISOString();

      if (action.tool === 'create_event' && args.startsAt) {
        await api.createEvent({
          id: uuid(),
          title: args.title ?? 'Untitled',
          startsAt: args.startsAt,
          endsAt: args.endsAt,
          reminderMinutesBefore: 15,
          updatedAt,
        });
      } else {
        await api.createTask({
          id: uuid(),
          title: args.title ?? 'Untitled',
          dueAt: args.dueAt,
          updatedAt,
        });
      }

      // Clear the proposal so it can't be confirmed twice.
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, pendingAction: null } : m)),
      );

      const done: ChatMessage = {
        id: uuid(),
        role: 'assistant',
        content: confirmationFor(action.tool, action.arguments),
        toolCalls: null,
        toolCallId: null,
        pendingAction: null,
        createdAt: updatedAt,
      };
      append([done]);
      await api.appendChat([done]);
    } catch (e) {
      failed(e);
    } finally {
      setSending(false);
    }
  };



  const busy = sending || transcribing;

  return (
    <Screen clearTabBar={false}>
      {/* ── Header ── */}
      <View style={styles.headerRow}>
        <View style={styles.badge}>
          <Sparkles color={c.primary} size={19} />
        </View>
        <View style={{ flex: 1, marginStart: 12 }}>
          <Text style={[styles.headerTitle, { textAlign: isRTL() ? 'right' : 'left' }]}>
            {t('assistant.title')}
          </Text>
          <Text style={styles.headerSub}>{t('assistant.subtitle')}</Text>
        </View>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            navigation.goBack();
          }}
          style={styles.closeBtn}
        >
          <X color={c.text} size={20} />
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: spacing.md }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>{t('assistant.trySaying')}</Text>
            {[
              t('assistant.example1'),
              t('assistant.example2'),
              t('assistant.example3'),
            ].map((s) => (
              <Pressable key={s} onPress={() => send(s)} style={styles.suggestion}>
                <Text style={styles.suggestionText}>{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {messages.map((m) => {
          if (m.role === 'user') {
            return (
              <View key={m.id} style={styles.userRow}>
                <View
                  style={[
                    styles.userBubble,
                    isRTL() ? { borderBottomLeftRadius: 7 } : { borderBottomRightRadius: 7 },
                  ]}
                >
                  <Text style={styles.userText}>{m.content}</Text>
                </View>
              </View>
            );
          }

          // A `tool` message is the executed result; render it as a quiet note.
          if (m.role === 'tool') {
            return (
              <View key={m.id} style={styles.toolRow}>
                <Check color={c.success} size={15} />
                <Text style={styles.toolText}>{t('assistant.done')}</Text>
              </View>
            );
          }

          return (
            <View key={m.id} style={styles.assistantRow}>
              {m.content ? (
                <View
                  style={[
                    styles.assistantBubble,
                    isRTL() ? { borderBottomRightRadius: 7 } : { borderBottomLeftRadius: 7 },
                  ]}
                >
                  <Text style={styles.assistantText}>{m.content}</Text>
                </View>
              ) : null}

              {m.pendingAction ? (
                <View style={styles.actionCard}>
                  <Text style={styles.actionLabel}>
                    {t(ACTION_LABEL[m.pendingAction.tool] ?? 'assistant.addTask')}
                  </Text>
                  <Text style={styles.actionBody}>
                    {describeAction(m.pendingAction.tool, m.pendingAction.arguments)}
                  </Text>
                  <View style={styles.actionRow}>
                    <Pressable
                      onPress={() =>
                        setMessages((prev) =>
                          prev.map((x) => (x.id === m.id ? { ...x, pendingAction: null } : x)),
                        )
                      }
                      style={styles.dismissBtn}
                    >
                      <Text style={styles.dismissText}>{t('assistant.notNow')}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => confirm(m.id)}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.confirmBtn,
                        { opacity: pressed || busy ? 0.85 : 1 },
                      ]}
                    >
                      <Check color={c.onAccent} size={17} />
                      <Text style={styles.confirmText}>{t('assistant.confirm')}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}

        {busy ? (
          <View style={styles.thinkingRow}>
            <ActivityIndicator color={c.primary} size="small" />
            <Text style={styles.thinkingText}>
              {transcribing ? t('assistant.transcribing') : t('assistant.thinking')}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* ── Composer: type, or hold the mic ── */}
      <View style={styles.composer}>
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={setDraft}
          placeholder={isRecording ? t('assistant.listening') : t('assistant.placeholder')}
          placeholderTextColor={c.textMuted}
          style={styles.input}
          editable={!isRecording && !busy}
          onSubmitEditing={() => send(draft)}
          returnKeyType="send"
        />

        {draft.trim() ? (
          <Pressable
            onPress={() => send(draft)}
            disabled={busy}
            style={({ pressed }) => [styles.sendBtn, { opacity: pressed || busy ? 0.85 : 1 }]}
          >
            <Send color={c.onAccent} size={20} />
          </Pressable>
        ) : (
          <MicButton
            disabled={transcribing}
            onRecordingChange={setIsRecording}
            onTranscribing={setTranscribing}
            onTranscribed={send}
            onError={failed}
          />
        )}
      </View>

      {isRecording ? (
        <Text style={styles.recordHint}>{t('assistant.recordHint')}</Text>
      ) : Platform.OS === 'web' ? (
        <Text style={styles.recordHint}>{t('assistant.voiceWebHint')}</Text>
      ) : null}
    </Screen>
  );
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    badge: {
      width: 42,
      height: 42,
      borderRadius: radius.md,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: { ...font(600), fontSize: 19, color: c.text, letterSpacing: -0.3 },
    headerSub: { ...font(400), fontSize: 12.5, color: c.textMuted, marginTop: 1 },
    closeBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    emptyCard: {
      ...cardStyle(c),
      gap: 9,
    },
    emptyTitle: {
      ...font(500),
      fontSize: 12,
      letterSpacing: 0.05,
      textTransform: 'uppercase',
      color: c.textMuted,
      marginBottom: 2,
    },
    suggestion: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      paddingVertical: 13,
      paddingHorizontal: 14,
    },
    suggestionText: { ...font(400), fontSize: 14, color: c.text, lineHeight: 20 },

    userRow: { alignItems: 'flex-end', marginBottom: 10 },
    userBubble: {
      maxWidth: '86%',
      backgroundColor: c.primary,
      borderRadius: 20,
      paddingVertical: 12,
      paddingHorizontal: 15,
    },
    userText: { ...font(400), fontSize: 14.5, color: c.onAccent, lineHeight: 20 },

    assistantRow: { alignItems: 'flex-start', marginBottom: 10, width: '100%' },
    assistantBubble: {
      maxWidth: '90%',
      backgroundColor: c.surface,
      borderRadius: 20,
      paddingVertical: 12,
      paddingHorizontal: 15,
    },
    assistantText: { ...font(400), fontSize: 14.5, color: c.text, lineHeight: 20 },

    toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
    toolText: { ...font(500), fontSize: 12.5, color: c.textMuted },

    actionCard: {
      ...cardStyle(c),
      marginTop: 8,
      width: '100%',
      borderWidth: 1,
      borderColor: withAlpha(c.primary, 0.3),
    },
    actionLabel: { ...font(500), fontSize: 12.5, color: c.textMuted, marginBottom: 6 },
    actionBody: {
      ...font(600),
      fontSize: 16,
      color: c.text,
      lineHeight: 23,
      marginBottom: spacing.md,
    },
    actionRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
    dismissBtn: {
      paddingVertical: 14,
      paddingHorizontal: 18,
      borderRadius: radius.pill,
      backgroundColor: c.surfaceAlt,
    },
    dismissText: { ...font(500), fontSize: 14, color: c.textMuted },
    confirmBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      borderRadius: radius.pill,
      paddingVertical: 14,
      backgroundColor: c.primary,
    },
    confirmText: { ...font(600), fontSize: 14.5, color: c.onAccent },

    thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8 },
    thinkingText: { ...font(400), fontSize: 13, color: c.textMuted },

    composer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingTop: spacing.sm,
    },
    input: {
      flex: 1,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      paddingHorizontal: 18,
      paddingVertical: 16,
      fontSize: 15,
      ...font(400),
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
    },
    sendBtn: {
      width: 54,
      height: 54,
      borderRadius: 27,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: c.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: c.shadowOpacity,
      shadowRadius: 10,
      elevation: 4,
    },
    recordHint: {
      ...font(400),
      fontSize: 11.5,
      color: c.textMuted,
      textAlign: 'center',
      marginTop: 8,
    },
  });
}
