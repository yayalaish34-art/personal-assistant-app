import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  Animated,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import {
  useAudioRecorder,
  useAudioRecorderState,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';
import { X, Mic, Send, Check, Sparkles, Square } from 'lucide-react-native';

import { Screen } from '../components/ui';
import { api, ApiError, type ChatMessage } from '../lib/api';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, font, ACCENT_GRADIENT } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Assistant'>;

/** Turns create_event/create_task arguments into a readable confirmation line. */
function describeAction(tool: string, args: Record<string, unknown>): string {
  const title = typeof args.title === 'string' ? args.title : 'Untitled';
  const when = args.starts_at ?? args.due_at;
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

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const isRecording = recorderState.isRecording;

  // Pulsing ring while recording, so it's obvious the mic is live.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isRecording) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isRecording, pulse]);

  useEffect(() => {
    (async () => {
      // Microphone permission has to be granted before the first record call.
      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
      if (!granted) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    })();
  }, []);

  const append = useCallback((incoming: ChatMessage[]) => {
    setMessages((prev) => [...prev, ...incoming]);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const failed = (e: unknown) => {
    const msg =
      e instanceof ApiError && e.status === 429
        ? `Too many requests — try again in ${e.retryAfter ?? 60}s.`
        : (e as Error).message;
    Alert.alert('Assistant unavailable', msg);
  };

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || sending) return;
    setDraft('');
    setSending(true);
    // Show the user's line immediately; the server echoes it back in `messages`
    // but waiting for the round trip makes the UI feel broken.
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
      const { messages: incoming } = await api.sendMessage(body);
      // Drop the server's copy of our own message to avoid showing it twice.
      append(incoming.filter((m) => m.role !== 'user'));
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
      const { messages: incoming } = await api.confirmAction(messageId);
      // The server clears pendingAction on the original message once executed.
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, pendingAction: null } : m)),
      );
      append(incoming.filter((m) => m.role !== 'user'));
    } catch (e) {
      failed(e);
    } finally {
      setSending(false);
    }
  };

  const startRecording = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
      if (!granted) {
        Alert.alert('Microphone needed', 'Allow microphone access to talk to your assistant.');
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e) {
      Alert.alert('Couldn’t start recording', (e as Error).message);
    }
  };

  const stopAndTranscribe = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTranscribing(true);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('No audio was captured.');

      // The audio never touches our storage: it is posted straight through to
      // the server, which streams it to the STT provider and discards it.
      const { text } = await api.transcribe(uri);
      if (!text.trim()) {
        Alert.alert('Nothing heard', 'Try recording again and speak a little louder.');
        return;
      }
      await send(text);
    } catch (e) {
      failed(e);
    } finally {
      setTranscribing(false);
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
          <Pressable
            onPress={isRecording ? stopAndTranscribe : startRecording}
            disabled={transcribing}
          >
            <View>
              {isRecording ? (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.pulseRing,
                    {
                      opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                      transform: [
                        { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) },
                      ],
                    },
                  ]}
                />
              ) : null}
              <LinearGradient
                colors={
                  isRecording
                    ? (['#F0797C', '#E5484D'] as const as unknown as [string, string])
                    : (ACCENT_GRADIENT.colors as unknown as [string, string])
                }
                start={ACCENT_GRADIENT.start}
                end={ACCENT_GRADIENT.end}
                style={styles.micBtn}
              >
                {isRecording ? (
                  <Square color="#fff" size={17} fill="#fff" />
                ) : (
                  <Mic color="#fff" size={21} />
                )}
              </LinearGradient>
            </View>
          </Pressable>
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
  pulseRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#E5484D',
  },
  recordHint: {
    ...font(400),
    fontSize: 11.5,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 8,
  },
});
