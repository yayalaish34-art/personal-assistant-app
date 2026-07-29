import { useCallback, useEffect, useRef, useState } from 'react';
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
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { MicButton } from '../components/MicButton';
import { X, Send, Check, Sparkles } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api, uuid, type ChatMessage } from '../lib/api';
import { respondTo, confirmationFor } from '../lib/assistant';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, ACCENT_GRADIENT } from '../theme';

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
  create_event: 'Add this event?',
  create_task: 'Add this task?',
  update_event: 'Update this event?',
  update_task: 'Update this task?',
  delete_event: 'Delete this event?',
  delete_task: 'Delete this task?',
};

export default function AssistantScreen() {
  const navigation = useNavigation<Nav>();
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
    const t = setTimeout(() => inputRef.current?.focus(), 350);
    return () => clearTimeout(t);
  }, []);

  const [isRecording, setIsRecording] = useState(false);



  const append = useCallback((incoming: ChatMessage[]) => {
    setMessages((prev) => [...prev, ...incoming]);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const failed = (e: unknown) => {
    Alert.alert('Something went wrong', (e as Error).message);
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
          <Sparkles color={colors.primary} size={19} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerTitle}>Assistant</Text>
          <Text style={styles.headerSub}>Ask for a task or an event</Text>
        </View>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            navigation.goBack();
          }}
          style={styles.circleWhite}
        >
          <X color={colors.text} size={20} />
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
            <Text style={styles.emptyTitle}>Try saying</Text>
            {[
              'Remind me to call the dentist tomorrow at 10',
              'Meeting with Maya on Thursday at 2pm',
              'Add a task to write the release notes',
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
                <LinearGradient
                  colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
                  start={ACCENT_GRADIENT.start}
                  end={ACCENT_GRADIENT.end}
                  style={styles.userBubble}
                >
                  <Text style={styles.userText}>{m.content}</Text>
                </LinearGradient>
              </View>
            );
          }

          // A `tool` message is the executed result; render it as a quiet note.
          if (m.role === 'tool') {
            return (
              <View key={m.id} style={styles.toolRow}>
                <Check color="#3EA06B" size={15} />
                <Text style={styles.toolText}>Done</Text>
              </View>
            );
          }

          return (
            <View key={m.id} style={styles.assistantRow}>
              {m.content ? (
                <View style={styles.assistantBubble}>
                  <Text style={styles.assistantText}>{m.content}</Text>
                </View>
              ) : null}

              {m.pendingAction ? (
                <View style={styles.actionCard}>
                  <Text style={styles.actionLabel}>
                    {ACTION_LABEL[m.pendingAction.tool] ?? 'Confirm this?'}
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
                      <Text style={styles.dismissText}>Not now</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => confirm(m.id)}
                      disabled={busy}
                      style={({ pressed }) => [{ flex: 1, opacity: pressed || busy ? 0.85 : 1 }]}
                    >
                      <LinearGradient
                        colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
                        start={ACCENT_GRADIENT.start}
                        end={ACCENT_GRADIENT.end}
                        style={styles.confirmBtn}
                      >
                        <Check color="#fff" size={17} />
                        <Text style={styles.confirmText}>Confirm</Text>
                      </LinearGradient>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}

        {busy ? (
          <View style={styles.thinkingRow}>
            <ActivityIndicator color={colors.primary} size="small" />
            <Text style={styles.thinkingText}>
              {transcribing ? 'Transcribing…' : 'Thinking…'}
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
          placeholder={isRecording ? 'Listening…' : 'Type a request…'}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          editable={!isRecording && !busy}
          onSubmitEditing={() => send(draft)}
          returnKeyType="send"
        />

        {draft.trim() ? (
          <Pressable onPress={() => send(draft)} disabled={busy}>
            <LinearGradient
              colors={ACCENT_GRADIENT.colors as unknown as [string, string]}
              start={ACCENT_GRADIENT.start}
              end={ACCENT_GRADIENT.end}
              style={styles.micBtn}
            >
              <Send color="#fff" size={20} />
            </LinearGradient>
          </Pressable>
        ) : (
          <MicButton disabled={transcribing} />
        )}
      </View>

      {isRecording ? (
        <Text style={styles.recordHint}>Tap the square when you’re done</Text>
      ) : Platform.OS === 'web' ? (
        <Text style={styles.recordHint}>
          Voice works best on a phone — typing works everywhere
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  badge: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: '#EFE7FD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { ...font(600), fontSize: 19, color: colors.text, letterSpacing: -0.3 },
  headerSub: { ...font(400), fontSize: 12.5, color: colors.textMuted, marginTop: 1 },
  circleWhite: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },

  emptyCard: {
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 24,
    padding: spacing.md + 2,
    gap: 9,
    borderWidth: 1,
    borderColor: 'rgba(136,117,246,0.14)',
  },
  emptyTitle: {
    ...font(500),
    fontSize: 12,
    letterSpacing: 0.05,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 2,
  },
  suggestion: {
    backgroundColor: '#FFFFFF',
    borderRadius: 15,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  suggestionText: { ...font(400), fontSize: 14, color: colors.text, lineHeight: 20 },

  userRow: { alignItems: 'flex-end', marginBottom: 10 },
  userBubble: {
    maxWidth: '86%',
    borderRadius: 20,
    borderBottomRightRadius: 7,
    paddingVertical: 12,
    paddingHorizontal: 15,
  },
  userText: { ...font(400), fontSize: 14.5, color: '#FFFFFF', lineHeight: 20 },

  assistantRow: { alignItems: 'flex-start', marginBottom: 10, width: '100%' },
  assistantBubble: {
    maxWidth: '90%',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderBottomLeftRadius: 7,
    paddingVertical: 12,
    paddingHorizontal: 15,
  },
  assistantText: { ...font(400), fontSize: 14.5, color: colors.text, lineHeight: 20 },

  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  toolText: { ...font(500), fontSize: 12.5, color: '#3EA06B' },

  actionCard: {
    marginTop: 8,
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(136,117,246,0.22)',
    shadowColor: '#5B3FA8',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.09,
    shadowRadius: 14,
    elevation: 3,
  },
  actionLabel: { ...font(500), fontSize: 12.5, color: colors.textMuted, marginBottom: 6 },
  actionBody: {
    ...font(600),
    fontSize: 16,
    color: colors.text,
    lineHeight: 23,
    marginBottom: spacing.md,
  },
  actionRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  dismissBtn: {
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 50,
    backgroundColor: '#F4F1F9',
  },
  dismissText: { ...font(500), fontSize: 14, color: colors.textMuted },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 50,
    paddingVertical: 14,
  },
  confirmText: { ...font(600), fontSize: 14.5, color: '#FFFFFF' },

  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8 },
  thinkingText: { ...font(400), fontSize: 13, color: colors.textMuted },

  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 50,
    paddingHorizontal: 18,
    paddingVertical: 16,
    fontSize: 15,
    ...font(400),
    color: colors.text,
    borderWidth: 1,
    borderColor: 'rgba(136,117,246,0.14)',
  },
  micBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
  },
  recordHint: {
    ...font(400),
    fontSize: 11.5,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
});
