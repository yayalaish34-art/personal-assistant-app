import { useCallback, useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
// For what importing it does, not for anything it exports: it installs the
// WebRTC globals and the native audio session that the client below opens its
// conversation over. The React Native package only re-exports the hooks; the
// session object itself comes from the client it wraps (the same pinned copy).
import '@elevenlabs/react-native';
import { VoiceConversation, type Language } from '@elevenlabs/client';

import { uuid } from './api';
import { t, locale, getVoiceLanguage } from './i18n';
import { startLocationTracking, stopLocationTracking } from './location';
import { requestMicrophone } from './permissions';
import {
  agentAgenda,
  applyActions,
  generateImage,
  openAgentSession,
  runAgentTool,
  parseCards,
  parseOffer,
  parseChecklist,
  parseConfirmation,
  parseBudget,
  parseTimeline,
  parseActions,
  parseDebt,
  parseWeather,
  parseSummary,
  clearConversation,
  loadConversation,
  saveConversation,
  VoiceUnavailableError,
  type AppliedChange,
  type CardSet,
  type ChecklistData,
  type ConfirmationData,
  type BudgetData,
  type TimelineData,
  type QuickActionsData,
  type DebtData,
  type WeatherData,
  type SummaryData,
  type TurnMessage,
  type TimeOffer,
  type VoiceAction,
} from './voice';

// The conversation itself, live, with an ElevenLabs agent.
//
// ElevenLabs does the spoken loop end to end over one WebRTC connection: it
// hears, decides when the user has finished, thinks, and talks — and the user
// can talk over it. There is no record-upload-transcribe-answer-speak cycle on
// this side any more; what is left here is the thread on screen, the tools
// (each one forwarded to our server with this phone's data), and the changes
// and cards those tools bring back.
//
// Callbacks handed to the SDK live as long as the session does, so they read
// everything through refs: one that closed over a render would keep acting on
// a thread the screen has already moved past.

/** How often the orb samples the mic or her voice. */
const LEVEL_MS = 120;

/**
 * What a fresh conversation opens with. The prompt recognises this exact
 * string and greets the user with what is on their plate, in their own
 * language, rather than us shipping a hand-written greeting per language.
 * It is sent as text, so it never shows up as something the user said.
 */
const SESSION_START = '[SESSION START]';

/** Tool results that are shown rather than applied. */
const DISPLAY_TOOLS = new Set([
  'create_image', 'offer_times', 'present_cards',
  'present_checklist', 'present_confirmation', 'present_budget',
  'present_timeline', 'present_actions', 'present_debt',
  'present_weather', 'present_summary',
]);

export type VoiceState =
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'stopped'
  | 'unavailable';

export type Line = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** A drawing that has been asked for but has not arrived. */
  drawing?: boolean;
  /** `file://` uri of a picture she drew. */
  imageUri?: string;
  /** Times to choose from, when the one asked for will not work. */
  offer?: TimeOffer;
  /** Which of them was taken. The line itself is the record of the choice. */
  chosen?: string;
  /** Structured cards — options, summaries, key points. */
  cards?: CardSet;
  /** Which card was tapped, when the set is selectable. */
  chosenCard?: string;
  /** Interactive checklist (tasks / shopping). */
  checklist?: ChecklistData;
  /** Confirmation of a just-completed action. */
  confirmation?: ConfirmationData;
  /** Budget progress bars. */
  budget?: BudgetData;
  /** Day timeline. */
  timeline?: TimelineData;
  /** Follow-up action chips. */
  quickActions?: QuickActionsData;
  /** Debt cards. */
  debtSummary?: DebtData;
  /** Weather forecast. */
  weather?: WeatherData;
  /** Summary with stats and highlights. */
  summary?: SummaryData;
  /**
   * When it was said, for the clock under the bubble.
   *
   * Absent on lines restored from a saved conversation: only the words are
   * stored, so the alternative to no timestamp is a wrong one saying every
   * line arrived the moment the screen opened.
   */
  at?: number;
};

export interface VoiceSession {
  state: VoiceState;
  lines: Line[];
  /** 0–1, for the orb. Follows the mic while listening and her voice while she speaks. */
  level: number;
  error: string | null;
  /** Changes from the last turn that can still be taken back. */
  undoable: AppliedChange[];
  /** While she talks: silence the rest of what she is saying. */
  toggle: () => void;
  /** Same conversation, typed instead of spoken. */
  send: (text: string) => void;
  /** Take one of the offered times and put the meeting there. */
  chooseTime: (lineId: string, iso: string) => void;
  /** Pick one of the presented cards. */
  chooseCard: (lineId: string, label: string) => void;
  /** Tap a checklist item to check it off. */
  checkItem: (lineId: string, itemId: string) => void;
  /** Settle a debt from a debt card. */
  settleDebt: (lineId: string, debtId: string) => void;
  undoLast: () => void;
  /** Forget the thread and start over from a greeting. */
  startOver: () => void;
  /**
   * Open a new conversation after this one has stopped.
   *
   * Keeps the thread — this is "carry on", not "start over". The new session
   * is handed what was said so far, so she picks up where it left off.
   */
  restart: () => void;
  end: () => void;
}

/** The orb's level from the SDK's 0–1 volume, which sits low for speech. */
function toLevel(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return Math.min(1, Math.max(0, volume * 2.2));
}

export function useVoiceSession(options: {
  userName?: string;
  /** Called after changes land, so the screen behind can refresh. */
  onChanged?: () => void;
}): VoiceSession {
  const { userName, onChanged } = options;

  const [state, setState] = useState<VoiceState>('starting');
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<AppliedChange[]>([]);
  /**
   * Bumped to open a new conversation. The session lives in an effect keyed
   * on this, so raising it tears the old one down and opens a fresh one in
   * place — which is what `restart` does instead of remounting the screen.
   */
  const [runId, setRunId] = useState(0);

  const historyRef = useRef<TurnMessage[]>([]);
  /** The tap handlers need the current lines, not a render's. */
  const linesRef = useRef<Line[]>([]);
  linesRef.current = lines;
  const conversationRef = useRef<VoiceConversation | null>(null);
  /** Set once the screen is going away or the session was ended on purpose. */
  const doneRef = useRef(false);
  const stateRef = useRef<VoiceState>('starting');
  /** Her voice was turned down for the rest of a reply; back up when she stops. */
  const mutedRef = useRef(false);
  /** A line typed before the conversation was open, sent once it is. */
  const pendingRef = useRef<string | null>(null);
  const userNameRef = useRef(userName);
  userNameRef.current = userName;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const setPhase = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /** Into the thread on screen and into the saved history alike. */
  const say = useCallback((role: Line['role'], text: string) => {
    setLines((prev) => [...prev, { id: uuid(), role, text, at: Date.now() }]);
    historyRef.current = [...historyRef.current, { role, content: text }];
    // Saved after every line, so closing the screen mid-thought and coming
    // back does not lose what was already said.
    void saveConversation(historyRef.current);
  }, []);

  /** A line for the screen only — a notice, not part of what was said. */
  const notice = useCallback((text: string) => {
    setLines((prev) => [...prev, { id: uuid(), role: 'assistant', text, at: Date.now() }]);
  }, []);

  /**
   * Tells her the agenda moved under her.
   *
   * Her prompt was written when the conversation opened. After she adds a task
   * the new one has an id she has never seen, so "move it to five" would have
   * nothing to point at; this hands her the current list, ids and all.
   */
  const refreshAgenda = useCallback(() => {
    void (async () => {
      try {
        const agenda = await agentAgenda(userNameRef.current);
        conversationRef.current?.sendContextualUpdate(
          `The user's data has just changed. This is the current agenda — use these ids from now on:\n${agenda}`,
        );
      } catch {
        /* she still has the tool results; the next call sends fresh data anyway */
      }
    })();
  }, []);

  const changed = useCallback(
    (applied: AppliedChange[]) => {
      if (applied.length === 0) return;
      setUndoable(applied);
      onChangedRef.current?.();
      refreshAgenda();
    },
    [refreshAgenda],
  );

  // ── What a tool brings back ───────────────────────────────────────────────

  /**
   * Shows the cards a tool returned and applies its changes.
   *
   * Drawing is pulled out and run on its own. It takes ten to twenty seconds —
   * awaited here it would hold up the tool result, and she would sit silent
   * waiting for it. The placeholder goes in now and fills itself later.
   */
  const present = useCallback(
    async (actions: VoiceAction[]) => {
      const pick = <T,>(tool: string, parse: (a: Record<string, unknown>) => T | null) =>
        actions
          .filter((a) => a.tool === tool)
          .map((a) => parse(a.arguments ?? {}))
          .find((v): v is T => v !== null);

      for (const draw of actions.filter((a) => a.tool === 'create_image')) {
        const prompt = typeof draw.arguments?.prompt === 'string' ? draw.arguments.prompt : '';
        if (!prompt) continue;
        const shape = typeof draw.arguments?.shape === 'string' ? draw.arguments.shape : undefined;
        const id = uuid();
        setLines((prev) => [...prev, { id, role: 'assistant', text: '', drawing: true, at: Date.now() }]);
        void generateImage(prompt, shape)
          .then((imageUri) => {
            if (doneRef.current) return;
            setLines((prev) => prev.map((l) => (l.id === id ? { ...l, drawing: false, imageUri } : l)));
          })
          .catch((e: unknown) => {
            console.warn('[voice] drawing failed:', (e as Error)?.message ?? e);
            if (doneRef.current) return;
            setLines((prev) =>
              prev.map((l) => (l.id === id ? { ...l, drawing: false, text: t('voice.drawFailed') } : l)),
            );
          });
      }

      const visuals = {
        offer: pick('offer_times', parseOffer),
        cards: pick('present_cards', parseCards),
        checklist: pick('present_checklist', parseChecklist),
        confirmation: pick('present_confirmation', parseConfirmation),
        budget: pick('present_budget', parseBudget),
        timeline: pick('present_timeline', parseTimeline),
        quickActions: pick('present_actions', parseActions),
        debtSummary: pick('present_debt', parseDebt),
        weather: pick('present_weather', parseWeather),
        summary: pick('present_summary', parseSummary),
      };
      const shown = Object.fromEntries(Object.entries(visuals).filter(([, v]) => v));
      // Its own line, under whatever she is saying about it: the words arrive
      // separately, as she speaks them.
      if (Object.keys(shown).length > 0) {
        setLines((prev) => [...prev, { id: uuid(), role: 'assistant', text: '', at: Date.now(), ...shown }]);
      }

      const rest = actions.filter((a) => !DISPLAY_TOOLS.has(a.tool));
      if (rest.length > 0) changed(await applyActions(rest));
    },
    [changed],
  );

  /** One tool call from her: run it on the server, apply what it decided, answer. */
  const runTool = useCallback(
    async (name: string, params: unknown): Promise<string> => {
      if (stateRef.current !== 'speaking') setPhase('thinking');
      const args = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      const { result, actions } = await runAgentTool(name, args, userNameRef.current);
      if (!doneRef.current) await present(actions);
      return result;
    },
    [present, setPhase],
  );
  const runToolRef = useRef(runTool);
  runToolRef.current = runTool;

  // ── Failures ──────────────────────────────────────────────────────────────

  /**
   * Some failures are not bad luck: an exhausted quota or a server without the
   * agent set up will fail again on the next try, so the session stops and
   * says what is actually wrong instead of "sorry, I lost that one".
   */
  const fail = useCallback(
    (e: unknown) => {
      if (doneRef.current) return;
      const message = (e as Error)?.message ?? String(e);
      const reason =
        e instanceof VoiceUnavailableError
          ? e.reason
          : /quota|credit|limit/i.test(message)
            ? 'quota'
            : null;
      console.warn('[voice] session failed:', reason ?? '', message);
      setError(reason ?? message);
      notice(
        reason === 'quota'
          ? t('voice.noCredits')
          : reason === 'unconfigured'
            ? t('voice.notConfigured')
            : `${t('voice.hiccup')}\n⚠️ ${message}`,
      );
      setPhase('stopped');
    },
    [notice, setPhase],
  );

  // ── The session ───────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    doneRef.current = false;
    mutedRef.current = false;

    void startLocationTracking().catch(() => undefined);

    (async () => {
      const mic = await requestMicrophone();
      if (cancelled) return;
      if (mic !== 'granted') {
        setPhase('unavailable');
        // No error for a build without the native module: the screen says
        // that case on its own. A refusal is the user's to undo.
        setError(mic === 'unavailable' ? null : 'microphone');
        return;
      }

      // Pick the thread back up if there is a recent one. Only a conversation
      // that has gone cold gets a greeting — otherwise she would say hello
      // again in the middle of it.
      const earlier = await loadConversation();
      if (cancelled) return;
      historyRef.current = earlier;
      setLines(earlier.map((m) => ({ id: uuid(), role: m.role, text: m.content })));

      setPhase('starting');
      try {
        const session = await openAgentSession(earlier, userNameRef.current);
        if (cancelled) return;

        const clientTools = Object.fromEntries(
          session.tools.map((name) => [name, (params: unknown) => runToolRef.current(name, params)]),
        );

        const conversation = await VoiceConversation.startSession({
          conversationToken: session.conversationToken,
          connectionType: 'webrtc',
          overrides: {
            agent: {
              prompt: { prompt: session.prompt },
              language: getVoiceLanguage() as Language,
            },
          },
          clientTools,
          onMessage: ({ role, message }) => {
            const text = message.trim();
            if (!text || doneRef.current) return;
            if (role === 'user') {
              say('user', text);
              setPhase('thinking');
            } else {
              say('assistant', text);
            }
          },
          // Talked over, she stops mid-sentence; the line keeps only what was
          // actually heard, so the thread does not claim she said the rest.
          onAgentResponseCorrection: ({ original_agent_response, corrected_agent_response }) => {
            const before = original_agent_response.trim();
            const after = corrected_agent_response.trim();
            setLines((prev) => {
              const i = prev.map((l) => l.role === 'assistant' && l.text === before).lastIndexOf(true);
              if (i < 0) return prev;
              const next = [...prev];
              next[i] = { ...next[i]!, text: after };
              return next;
            });
            const h = historyRef.current;
            const j = h.map((m) => m.role === 'assistant' && m.content === before).lastIndexOf(true);
            if (j >= 0) {
              historyRef.current = [...h.slice(0, j), { role: 'assistant', content: after }, ...h.slice(j + 1)];
              void saveConversation(historyRef.current);
            }
          },
          onModeChange: ({ mode }) => {
            if (doneRef.current) return;
            if (mode === 'speaking') {
              if (!mutedRef.current) setPhase('speaking');
              return;
            }
            if (mutedRef.current) {
              mutedRef.current = false;
              conversationRef.current?.setVolume({ volume: 1 });
            }
            setPhase('listening');
          },
          onError: (message) => {
            console.warn('[voice] agent error:', message);
          },
          onDisconnect: (details) => {
            conversationRef.current = null;
            if (doneRef.current) return;
            if (details.reason === 'error') {
              fail(new Error(details.message));
              return;
            }
            // She hung up (the conversation's time limit, or a goodbye): the
            // thread stays, and the restart button opens a new one.
            setPhase('stopped');
          },
        });

        if (cancelled) {
          void conversation.endSession();
          return;
        }
        conversationRef.current = conversation;
        setPhase('listening');

        const typed = pendingRef.current;
        pendingRef.current = null;
        if (typed) {
          conversation.sendUserMessage(typed);
          setPhase('thinking');
        } else if (earlier.length === 0) {
          conversation.sendUserMessage(SESSION_START);
          setPhase('thinking');
        }
      } catch (e) {
        if (!cancelled) fail(e);
      }
    })();

    return () => {
      cancelled = true;
      doneRef.current = true;
      const conversation = conversationRef.current;
      conversationRef.current = null;
      void conversation?.endSession().catch(() => undefined);
      stopLocationTracking();
    };
    // Keyed on `runId` and nothing else: the session owns its own lifecycle,
    // and the only thing allowed to replace it is an explicit `restart()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // The orb follows whoever is talking.
  useEffect(() => {
    const timer = setInterval(() => {
      const conversation = conversationRef.current;
      if (!conversation) return;
      try {
        const speaking = stateRef.current === 'speaking';
        setLevel(toLevel(speaking ? conversation.getOutputVolume() : conversation.getInputVolume()));
      } catch {
        /* between sessions */
      }
    }, LEVEL_MS);
    return () => clearInterval(timer);
  }, []);

  // ── Controls ──────────────────────────────────────────────────────────────

  /** Silences the rest of her reply. Talking over her interrupts her outright. */
  const hush = useCallback(() => {
    const conversation = conversationRef.current;
    if (!conversation || stateRef.current !== 'speaking') return;
    mutedRef.current = true;
    conversation.setVolume({ volume: 0 });
    setPhase('listening');
  }, [setPhase]);

  const toggle = useCallback(() => {
    if (stateRef.current === 'speaking') hush();
  }, [hush]);

  const undoLast = useCallback(() => {
    const changes = undoable;
    setUndoable([]);
    void (async () => {
      // Newest first, so an update layered on a create unwinds cleanly.
      for (const change of [...changes].reverse()) {
        try {
          await change.undo();
        } catch {
          /* nothing better to do than carry on */
        }
      }
      onChangedRef.current?.();
      refreshAgenda();
    })();
  }, [refreshAgenda, undoable]);

  const end = useCallback(() => {
    doneRef.current = true;
    const conversation = conversationRef.current;
    conversationRef.current = null;
    void conversation?.endSession().catch(() => undefined);
    setPhase('stopped');
  }, [setPhase]);

  /**
   * Picks the conversation back up where it stopped.
   *
   * `doneRef` is lowered here as well as at the top of the effect: the
   * effect's own cleanup raises it, and a `restart` arriving in the same
   * commit would otherwise open a session that reads it as already finished.
   */
  const restart = useCallback(() => {
    doneRef.current = false;
    setError(null);
    setPhase('starting');
    setRunId((n) => n + 1);
  }, [setPhase]);

  /**
   * A typed turn. It joins the same conversation as a spoken one, so the two
   * can be mixed freely; her answer is spoken as well as shown.
   */
  const send = useCallback(
    (text: string) => {
      const said = text.trim();
      if (!said) return;
      // Typing while she talks means the user is done listening.
      hush();
      say('user', said);
      const conversation = conversationRef.current;
      if (conversation) {
        conversation.sendUserMessage(said);
        setPhase('thinking');
        return;
      }
      // No conversation open: open one, and this line is what it starts with.
      pendingRef.current = said;
      if (stateRef.current === 'stopped') restart();
    },
    [hush, restart, say, setPhase],
  );

  /**
   * Puts the meeting at one of the offered times.
   *
   * The choice is written onto the line rather than into component state, so
   * scrolling away and back does not forget it, and so an older offer further
   * up the thread keeps its own answer. She is told as well: otherwise she
   * would go on believing that hour is still free.
   */
  const chooseTime = useCallback(
    (lineId: string, iso: string) => {
      const line = linesRef.current.find((l) => l.id === lineId);
      const offer = line?.offer;
      if (!offer || line?.chosen) return;
      if (new Date(iso).getTime() <= Date.now()) return;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, chosen: iso } : l)));

      void (async () => {
        const endsAt = new Date(new Date(iso).getTime() + offer.durationMinutes * 60_000).toISOString();
        const applied = await applyActions([
          {
            tool: 'create_event',
            arguments: {
              title: offer.title,
              startsAt: iso,
              endsAt,
              ...(offer.location ? { location: offer.location } : {}),
            },
          },
        ]);

        if (applied.length === 0) {
          // `applyActions` swallows its own failures, so an empty result is
          // the only signal that nothing was written.
          setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, chosen: undefined } : l)));
          notice(t('voice.offerFailed'));
          return;
        }

        const when = new Date(iso).toLocaleString(locale(), {
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
        });
        historyRef.current = [
          ...historyRef.current,
          { role: 'user', content: t('voice.offerPicked', { time: when }) },
        ];
        say('assistant', t('voice.offerDone', { time: when }));
        conversationRef.current?.sendContextualUpdate(
          `The user picked ${iso} from the times you offered; "${offer.title}" is now booked then.`,
        );
        changed(applied);
      })();
    },
    [changed, notice, say],
  );

  const chooseCard = useCallback(
    (lineId: string, label: string) => {
      const line = linesRef.current.find((l) => l.id === lineId);
      if (!line?.cards?.selectable || line.chosenCard) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, chosenCard: label } : l)));
      send(label);
    },
    [send],
  );

  const checkItem = useCallback(
    (lineId: string, itemId: string) => {
      const line = linesRef.current.find((l) => l.id === lineId);
      if (!line?.checklist) return;
      const item = line.checklist.items.find((i) => i.id === itemId);
      if (!item || item.checked) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLines((prev) =>
        prev.map((l) =>
          l.id === lineId
            ? {
                ...l,
                checklist: {
                  ...l.checklist!,
                  items: l.checklist!.items.map((i) => (i.id === itemId ? { ...i, checked: true } : i)),
                },
              }
            : l,
        ),
      );
      const tool = line.checklist.kind === 'tasks' ? 'complete_task' : 'check_shopping_item';
      void applyActions([{ tool, arguments: { id: itemId, matchTitle: item.label } }]).then(changed);
    },
    [changed],
  );

  const settleDebt = useCallback(
    (lineId: string, debtId: string) => {
      const line = linesRef.current.find((l) => l.id === lineId);
      if (!line?.debtSummary) return;
      const debt = line.debtSummary.debts.find((d) => d.id === debtId);
      if (!debt) return;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLines((prev) =>
        prev.map((l) =>
          l.id === lineId
            ? {
                ...l,
                debtSummary: {
                  ...l.debtSummary!,
                  debts: l.debtSummary!.debts.filter((d) => d.id !== debtId),
                },
              }
            : l,
        ),
      );
      void applyActions([
        { tool: 'settle_debt', arguments: { id: debtId, matchTitle: debt.person } },
      ]).then(changed);
    },
    [changed],
  );

  const startOver = useCallback(() => {
    historyRef.current = [];
    setLines([]);
    setUndoable([]);
    void clearConversation();
  }, []);

  return {
    state,
    lines,
    level,
    error,
    undoable,
    toggle,
    send,
    chooseTime,
    chooseCard,
    checkItem,
    settleDebt,
    undoLast,
    startOver,
    restart,
    end,
  };
}
