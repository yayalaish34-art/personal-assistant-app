import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

import { uuid } from './api';
import { t, locale } from './i18n';
import { startLocationTracking, stopLocationTracking } from './location';
import { createSpeechActivity } from './speechActivity';
import {
  applyActions,
  buildSnapshotWithProfile,
  generateImage,
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
  speechUrl,
  transcribe,
  voiceTurn,
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
} from './voice';

// The conversation itself: listen, understand, act, answer, listen again.
//
// The loop runs on refs rather than state because each step decides what the
// next one does, and a step that read its instructions from a stale render
// would keep listening after the user had already closed the screen.

/**
 * expo-audio ships native code, so `requireNativeModule('ExpoAudio')` in its
 * module body throws where that code isn't present. The require is wrapped so
 * such a build shows "voice unavailable" instead of failing to render at all.
 *
 * The literal in `require('expo-audio')` is load-bearing: Metro finds
 * dependencies by reading require calls at build time, so assigning `require`
 * to a variable first — as this file used to — leaves the module out of the
 * bundle entirely and every build fails with "Requiring unknown module". The
 * native side was never the problem.
 */
type AudioApi = typeof import('expo-audio');

/**
 * Flattens a recording preset into what the native recorder takes.
 *
 * The presets keep their platform settings nested under `ios` / `android` /
 * `web`, and the native side expects the ones for this platform merged into
 * the top level. expo-audio does that in `createRecordingOptions`, which it
 * does not export, so the shape is reproduced here — handing over the raw
 * preset gets the nested objects and none of the settings that matter.
 */
function recordingOptions(audio: AudioApi): Record<string, unknown> {
  const preset = audio.RecordingPresets.HIGH_QUALITY as unknown as Record<string, unknown>;
  const { ios, android, web, ...common } = preset;
  const forPlatform = Platform.OS === 'ios' ? ios : Platform.OS === 'android' ? android : web;
  return { ...common, ...(forPlatform as object | undefined), isMeteringEnabled: true };
}

type Recorder = {
  prepareToRecordAsync: (options?: Record<string, unknown>) => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  getStatus: () => { metering?: number; isRecording: boolean; durationMillis: number };
  uri: string | null;
};

type Player = {
  play: () => void;
  pause: () => void;
  remove: () => void;
  addListener: (
    event: 'playbackStatusUpdate',
    listener: (status: { didJustFinish: boolean; isLoaded: boolean }) => void,
  ) => { remove: () => void };
};

let cachedAudio: AudioApi | null | undefined;
function getAudio(): AudioApi | null {
  if (cachedAudio !== undefined) return cachedAudio;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedAudio = require('expo-audio') as AudioApi;
  } catch {
    cachedAudio = null;
  }
  return cachedAudio;
}

// ── Tuning ──────────────────────────────────────────────────────────────────

/** Above this (dBFS) counts as someone talking rather than room noise. */
const SPEECH_DB = -35;
/**
 * How long a pause has to last before her turn starts.
 *
 * 1.1s is enough to breathe between sentences without feeling sluggish.
 * Below ~900ms she cuts into "tomorrow at..." before the hour arrives;
 * above ~1.4s every turn opens with dead air.
 */
const SILENCE_MS = 1100;
/** Don't cut anyone off mid-thought, even if they started quietly. */
const MIN_LISTEN_MS = 900;
/** A recording this long is someone who forgot to stop, or a noisy room. */
const MAX_LISTEN_MS = 25_000;
const POLL_MS = 150;
/** Metering is optional; if none arrives by now, fall back to tap-to-stop. */
const METERING_GRACE_MS = 1200;
/** Failures in a row before the conversation is treated as genuinely broken. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** After TTS finishes, wait this long before reopening the mic so the room echo dissipates. */
const POST_SPEAK_MS = 250;

/**
 * The turn the assistant opens with. The server recognises this exact string
 * and greets the user with what is on their plate, in their own language,
 * rather than us shipping a hand-written greeting per language.
 */
const SESSION_START = '[SESSION START]';

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
  /** 0–1, for the orb. Follows the mic while listening. */
  level: number;
  error: string | null;
  /** Changes from the last turn that can still be taken back. */
  undoable: AppliedChange[];
  /** Interrupt her and listen, or stop listening and answer now. */
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
   * Open the microphone again after the conversation has stopped.
   *
   * Keeps the thread — this is "carry on", not "start over". Until this
   * existed a stopped session could only be revived by remounting the screen,
   * which is why the app had to be navigated away from and back into.
   */
  restart: () => void;
  end: () => void;
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
   * Bumped to start the loop over. The loop lives in an effect keyed on this,
   * so raising it tears the old one down and runs a fresh one in place —
   * which is what `restart` does instead of remounting the screen.
   */
  const [runId, setRunId] = useState(0);

  const historyRef = useRef<TurnMessage[]>([]);
  /** The loop and the tap handler both need the current lines, not a render's. */
  const linesRef = useRef<Line[]>([]);
  linesRef.current = lines;
  const recorderRef = useRef<Recorder | null>(null);
  const playerRef = useRef<Player | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Set once the screen is going away; every step checks it before continuing. */
  const doneRef = useRef(false);
  /** Resolves the current listen: 'speech' when the user spoke, 'aborted' otherwise. */
  const stopListeningRef = useRef<((reason: 'stopped' | 'aborted') => void) | null>(null);
  const stateRef = useRef<VoiceState>('starting');
  /**
   * Resolves the turn currently being spoken, if there is one.
   *
   * Held in a ref because whoever interrupts her — a tap, a typed line, the
   * screen closing — is nowhere near the promise that has to be settled.
   */
  const speakFinishRef = useRef<(() => void) | null>(null);

  const setPhase = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const addLine = useCallback((role: Line['role'], text: string) => {
    setLines((prev) => [...prev, { id: uuid(), role, text, at: Date.now() }]);
  }, []);

  // ── Speaking ──────────────────────────────────────────────────────────────

  /**
   * Ends her turn and releases whatever `speak` is waiting on.
   *
   * The second half is the point. Stopping the player used to be all this did,
   * and `speak` was awaiting a promise that only the player's own
   * `didJustFinish` event could resolve — an event a removed player never
   * sends. So interrupting her left the loop parked inside `speak` until a
   * sixty-second guard timer fired: the mic stayed shut, the state stayed
   * 'speaking', and the screen sat there doing nothing. That is what made
   * talking back to her look like a crash, and why leaving the screen and
   * coming back was the only thing that helped — a fresh mount was a fresh
   * loop. Interrupting now resolves it in the same tick and the loop moves
   * straight on to listening.
   */
  const stopSpeaking = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      try {
        player.pause();
        player.remove();
      } catch {
        /* already gone */
      }
    }
    // Cleared before it is called: `finish` calls back into here, and the ref
    // being empty by then is what stops the two bouncing off each other.
    const finish = speakFinishRef.current;
    speakFinishRef.current = null;
    finish?.();
  }, []);

  const speak = useCallback(
    async (text: string, token?: string) => {
      const audio = getAudio();
      if (!audio || !text.trim() || doneRef.current) return;

      setPhase('speaking');
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          subscription?.remove();
          speakFinishRef.current = null;
          stopSpeaking();
          resolve();
        };
        speakFinishRef.current = finish;

        void audio
          .setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
          .catch(() => undefined);

        let subscription: { remove: () => void } | undefined;
        const guard = setTimeout(finish, 60_000);

        try {
          const player = (
            audio as unknown as { createAudioPlayer: (source: { uri: string }) => Player }
          ).createAudioPlayer({ uri: speechUrl(text, token) });
          playerRef.current = player;
          subscription = player.addListener('playbackStatusUpdate', (status) => {
            if (status.didJustFinish) finish();
          });
          player.play();
        } catch {
          finish();
        }
      });
    },
    [setPhase, stopSpeaking],
  );

  // ── Listening ─────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** Records until the user stops talking (or taps). Resolves with the audio uri. */
  const listen = useCallback(async (): Promise<string | null> => {
    const audio = getAudio();
    if (!audio || doneRef.current) return null;

    let step = 'setAudioMode';
    let recorder: Recorder;
    try {
      await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      step = 'getRecorder';
      const Ctor = (
        audio as unknown as { AudioModule?: { AudioRecorder?: new (options: unknown) => Recorder } }
      ).AudioModule?.AudioRecorder;
      if (typeof Ctor !== 'function') throw new Error('AudioRecorder not found on AudioModule');

      step = 'buildOptions';
      const preset = {
        ...audio.RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      } as unknown as Record<string, unknown>;
      const opts = recordingOptions(audio);

      step = 'newRecorder';
      recorder = new Ctor(opts);
      recorderRef.current = recorder;

      step = 'prepare';
      await recorder.prepareToRecordAsync(preset);

      step = 'record';
      recorder.record();
    } catch (e) {
      recorderRef.current = null;
      throw new Error(`[${step}] ${(e as Error)?.message ?? e}`);
    }
    setPhase('listening');

    const startedAt = Date.now();
    let heardSpeech = false;
    const activity = createSpeechActivity(SPEECH_DB);
    let sawMetering = false;

    const reason = await new Promise<'stopped' | 'aborted'>((resolve) => {
      stopListeningRef.current = resolve;

      pollRef.current = setInterval(() => {
        if (doneRef.current) return resolve('aborted');

        let status: { metering?: number; durationMillis: number } | null = null;
        try {
          status = recorder.getStatus();
        } catch {
          return resolve('stopped');
        }

        const elapsed = Date.now() - startedAt;
        if (elapsed > MAX_LISTEN_MS) return resolve('stopped');

        const db = status?.metering;
        if (typeof db !== 'number' || Number.isNaN(db)) {
          // Without levels there is nothing to detect silence with; the user
          // taps to finish instead.
          if (elapsed > METERING_GRACE_MS && !sawMetering) setLevel(0.35);
          return;
        }
        sawMetering = true;

        // dBFS: about -60 is a quiet room, 0 is clipping.
        const loudness = Math.min(1, Math.max(0, (db + 60) / 55));
        setLevel(loudness);

        const detected = activity.sample(db, Date.now());
        heardSpeech = detected.heardSpeech;
        if (heardSpeech && elapsed >= MIN_LISTEN_MS && detected.quietMs > SILENCE_MS) {
          resolve('stopped');
        }
      }, POLL_MS);
    });

    stopPolling();
    stopListeningRef.current = null;
    setLevel(0);
    recorderRef.current = null;

    try {
      await recorder.stop();
    } catch {
      return null;
    }

    if (reason === 'aborted' || doneRef.current) return null;
    // Nothing but room noise: no point paying for a transcription.
    if (!heardSpeech && sawMetering) return null;
    return recorder.uri;
  }, [setPhase, stopPolling]);

  // ── One full turn ─────────────────────────────────────────────────────────

  const runTurn = useCallback(
    async (said: string, prebuilt?: { snapshot: Awaited<ReturnType<typeof buildSnapshotWithProfile>>['snapshot']; profile: unknown }): Promise<void> => {
      setPhase('thinking');
      const result = await voiceTurn(said, historyRef.current, userName, prebuilt);
      if (doneRef.current) return;

      // Nothing was made out. She says so and the exchange is forgotten: there
      // is no user line to keep, and keeping her half would leave "say that
      // again?" sitting in the thread as though it answered something.
      if (result.heard === false) {
        addLine('assistant', result.reply);
        if (result.reply && result.canSpeak) await speak(result.reply, result.speakToken);
        // Let room echo dissipate before reopening the microphone.
        await new Promise((r) => setTimeout(r, POST_SPEAK_MS));
        return;
      }

      // The opening turn was not something the user said, so it does not go
      // into the history — she would read it back and greet them twice.
      const turn: TurnMessage[] = said === SESSION_START ? [] : [{ role: 'user', content: said }];
      if (result.reply) turn.push({ role: 'assistant', content: result.reply });
      historyRef.current = [...historyRef.current, ...turn];
      // Persisted after every turn, so closing the screen mid-thought and
      // coming back does not lose what was already said.
      void saveConversation(historyRef.current);

      // Drawing is pulled out of the action list and run on its own. It takes
      // ten to twenty seconds — awaited here it would hold up the reply, the
      // speech and the next turn of listening, and she would appear to have
      // frozen. The placeholder goes in now and fills itself later.
      const drawings = result.actions.filter((a) => a.tool === 'create_image');
      const offer = result.actions
        .filter((a) => a.tool === 'offer_times')
        .map((a) => parseOffer(a.arguments ?? {}))
        .find((o): o is TimeOffer => o !== null);
      const cards = result.actions
        .filter((a) => a.tool === 'present_cards')
        .map((a) => parseCards(a.arguments ?? {}))
        .find((c): c is CardSet => c !== null);
      const checklist = result.actions
        .filter((a) => a.tool === 'present_checklist')
        .map((a) => parseChecklist(a.arguments ?? {}))
        .find((c): c is ChecklistData => c !== null);
      const confirmation = result.actions
        .filter((a) => a.tool === 'present_confirmation')
        .map((a) => parseConfirmation(a.arguments ?? {}))
        .find((c): c is ConfirmationData => c !== null);
      const budget = result.actions
        .filter((a) => a.tool === 'present_budget')
        .map((a) => parseBudget(a.arguments ?? {}))
        .find((c): c is BudgetData => c !== null);
      const timeline = result.actions
        .filter((a) => a.tool === 'present_timeline')
        .map((a) => parseTimeline(a.arguments ?? {}))
        .find((c): c is TimelineData => c !== null);
      const quickActions = result.actions
        .filter((a) => a.tool === 'present_actions')
        .map((a) => parseActions(a.arguments ?? {}))
        .find((c): c is QuickActionsData => c !== null);
      const debtSummary = result.actions
        .filter((a) => a.tool === 'present_debt')
        .map((a) => parseDebt(a.arguments ?? {}))
        .find((c): c is DebtData => c !== null);
      const weather = result.actions
        .filter((a) => a.tool === 'present_weather')
        .map((a) => parseWeather(a.arguments ?? {}))
        .find((c): c is WeatherData => c !== null);
      const summary = result.actions
        .filter((a) => a.tool === 'present_summary')
        .map((a) => parseSummary(a.arguments ?? {}))
        .find((c): c is SummaryData => c !== null);
      const DISPLAY_TOOLS = new Set([
        'create_image', 'offer_times', 'present_cards',
        'present_checklist', 'present_confirmation', 'present_budget',
        'present_timeline', 'present_actions', 'present_debt',
        'present_weather', 'present_summary',
      ]);
      const rest = result.actions.filter((a) => !DISPLAY_TOOLS.has(a.tool));

      for (const draw of drawings) {
        const prompt = typeof draw.arguments?.prompt === 'string' ? draw.arguments.prompt : '';
        if (!prompt) continue;
        const shape =
          typeof draw.arguments?.shape === 'string' ? draw.arguments.shape : undefined;
        const id = uuid();
        setLines((prev) => [
          ...prev,
          { id, role: 'assistant', text: '', drawing: true, at: Date.now() },
        ]);

        void generateImage(prompt, shape)
          .then((imageUri) => {
            if (doneRef.current) return;
            setLines((prev) =>
              prev.map((l) => (l.id === id ? { ...l, drawing: false, imageUri } : l)),
            );
          })
          .catch((e: unknown) => {
            console.warn('[voice] drawing failed:', (e as Error)?.message ?? e);
            if (doneRef.current) return;
            setLines((prev) =>
              prev.map((l) =>
                l.id === id ? { ...l, drawing: false, text: t('voice.drawFailed') } : l,
              ),
            );
          });
      }

      if (rest.length > 0) {
        const applied = await applyActions(rest);
        if (applied.length > 0) {
          setUndoable(applied);
          onChanged?.();
        }
      }

      const hasVisual = offer || cards || checklist || confirmation || budget || timeline || quickActions || debtSummary || weather || summary;
      if (result.reply || hasVisual) {
        setLines((prev) => [
          ...prev,
          {
            id: uuid(),
            role: 'assistant',
            text: result.reply,
            at: Date.now(),
            ...(offer ? { offer } : {}),
            ...(cards ? { cards } : {}),
            ...(checklist ? { checklist } : {}),
            ...(confirmation ? { confirmation } : {}),
            ...(budget ? { budget } : {}),
            ...(timeline ? { timeline } : {}),
            ...(quickActions ? { quickActions } : {}),
            ...(debtSummary ? { debtSummary } : {}),
            ...(weather ? { weather } : {}),
            ...(summary ? { summary } : {}),
          },
        ]);
        if (result.reply && result.canSpeak) await speak(result.reply, result.speakToken);
        await new Promise((r) => setTimeout(r, POST_SPEAK_MS));
      }
    },
    [addLine, onChanged, setPhase, speak, userName],
  );

  /**
   * Puts the meeting at one of the offered times.
   *
   * The choice is written onto the line rather than into component state, so
   * scrolling away and back does not forget it, and so an older offer further
   * up the thread keeps its own answer.
   *
   * Both halves of the exchange go into the history. Without them she is told
   * nothing about what was decided and will say that hour is still free.
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
        const endsAt = new Date(
          new Date(iso).getTime() + offer.durationMinutes * 60_000,
        ).toISOString();
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
          setLines((prev) =>
            prev.map((l) => (l.id === lineId ? { ...l, chosen: undefined } : l)),
          );
          addLine('assistant', t('voice.offerFailed'));
          return;
        }

        setUndoable(applied);
        onChanged?.();

        const when = new Date(iso).toLocaleString(locale(), {
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
        });
        historyRef.current = [
          ...historyRef.current,
          { role: 'user', content: t('voice.offerPicked', { time: when }) },
          { role: 'assistant', content: t('voice.offerDone', { time: when }) },
        ];
        void saveConversation(historyRef.current);
        addLine('assistant', t('voice.offerDone', { time: when }));
      })();
    },
    [addLine, onChanged],
  );

  // ── The loop ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const audio = getAudio();
    if (!audio) {
      setPhase('unavailable');
      return;
    }

    let cancelled = false;
    doneRef.current = false;

    void startLocationTracking().catch(() => undefined);

    (async () => {
      const { granted } = await audio.AudioModule.requestRecordingPermissionsAsync().catch(
        () => ({ granted: false }),
      );
      if (cancelled || doneRef.current) return;
      if (!granted) {
        setPhase('unavailable');
        setError('microphone');
        return;
      }

      // Pick the thread back up if there is a recent one. Only a conversation
      // that has gone cold gets a greeting — otherwise she would say hello
      // again in the middle of it.
      const earlier = await loadConversation();
      if (cancelled || doneRef.current) return;
      if (earlier.length > 0) {
        historyRef.current = earlier;
        setLines(
          earlier.map((m) => ({ id: uuid(), role: m.role, text: m.content })),
        );
      }

      // A turn can fail on its own — a dropped request, a transcription that
      // times out — without the conversation being over. Only a run of them
      // means something is actually wrong, so one failure just costs a turn.
      let consecutiveFailures = 0;

      while (!cancelled && !doneRef.current) {
        try {
          if (historyRef.current.length === 0) {
            // She speaks first, so the user knows she is listening.
            await runTurn(SESSION_START);
            if (cancelled || doneRef.current) break;
          }

          const uri = await listen();
          if (cancelled || doneRef.current) break;
          if (!uri) continue; // silence — keep the mic open

          setPhase('thinking');
          // Transcribe and pre-build the snapshot in parallel so the data
          // is ready the moment the words come back.
          const [said, prebuilt] = await Promise.all([
            transcribe(uri).then((t) => t.trim()),
            buildSnapshotWithProfile(),
          ]);
          if (cancelled || doneRef.current) break;

          if (!said) {
            await runTurn('');
            consecutiveFailures = 0;
            continue;
          }

          addLine('user', said);
          await runTurn(said, prebuilt);
          consecutiveFailures = 0;
        } catch (e) {
          if (cancelled || doneRef.current) break;

          // Some failures are not bad luck: an exhausted quota or a key the
          // server does not have will fail again next turn, and every retry
          // costs another "sorry, I lost that one" that says nothing true.
          if (e instanceof VoiceUnavailableError) {
            console.warn('[voice] unavailable:', e.reason, e.message);
            setError(e.reason);
            addLine(
              'assistant',
              t(e.reason === 'quota' ? 'voice.noCredits' : 'voice.notConfigured'),
            );
            setPhase('stopped');
            break;
          }

          consecutiveFailures += 1;
          const msg = (e as Error)?.message ?? String(e);
          setError(msg);
          console.warn('[voice] turn failed:', msg);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            setPhase('stopped');
            break;
          }
          addLine('assistant', `${t('voice.hiccup')}\n⚠️ ${msg}`);
          await new Promise((r) => setTimeout(r, 700));
        }
      }
    })();

    return () => {
      cancelled = true;
      doneRef.current = true;
      stopListeningRef.current?.('aborted');
      stopPolling();
      stopSpeaking();
      stopLocationTracking();
      void recorderRef.current?.stop().catch(() => undefined);
      recorderRef.current = null;
      // Hand the audio session back, or the next app to play sound gets the
      // recording-mode volume.
      void getAudio()
        ?.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
        .catch(() => undefined);
    };
    // Keyed on `runId` and nothing else: the loop owns its own lifecycle, and
    // the only thing allowed to restart it is an explicit `restart()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // ── Controls ──────────────────────────────────────────────────────────────

  const toggle = useCallback(() => {
    if (stateRef.current === 'speaking') {
      // Talking over her ends her turn — that is what interrupting means.
      stopSpeaking();
      return;
    }
    if (stateRef.current === 'listening') {
      stopListeningRef.current?.('stopped');
    }
  }, [stopSpeaking]);

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
      onChanged?.();
    })();
  }, [onChanged, undoable]);

  const end = useCallback(() => {
    doneRef.current = true;
    stopListeningRef.current?.('aborted');
    stopPolling();
    stopSpeaking();
    setPhase('stopped');
  }, [setPhase, stopPolling, stopSpeaking]);

  /**
   * A typed turn. It joins the same thread as a spoken one — same history,
   * same tools, same voice coming back — so the two can be mixed freely in
   * one conversation.
   */
  const send = useCallback(
    (text: string) => {
      const said = text.trim();
      if (!said || stateRef.current === 'thinking') return;
      // Typing while she talks means the user is done listening.
      stopSpeaking();
      stopListeningRef.current?.('stopped');
      addLine('user', said);
      void (async () => {
        try {
          await runTurn(said);
        } catch (e) {
          if (e instanceof VoiceUnavailableError) {
            console.warn('[voice] unavailable:', e.reason, e.message);
            setError(e.reason);
            addLine(
              'assistant',
              t(e.reason === 'quota' ? 'voice.noCredits' : 'voice.notConfigured'),
            );
            return;
          }
          setError((e as Error).message);
          addLine('assistant', t('voice.hiccup'));
        }
      })();
    },
    [addLine, runTurn, stopSpeaking],
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
                  items: l.checklist!.items.map((i) =>
                    i.id === itemId ? { ...i, checked: true } : i,
                  ),
                },
              }
            : l,
        ),
      );
      const tool = line.checklist.kind === 'tasks' ? 'complete_task' : 'check_shopping_item';
      void applyActions([{ tool, arguments: { id: itemId, matchTitle: item.label } }]).then(
        (applied) => {
          if (applied.length > 0) {
            setUndoable(applied);
            onChanged?.();
          }
        },
      );
    },
    [onChanged],
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
      void applyActions([{ tool: 'settle_debt', arguments: { id: debtId, matchTitle: debt.person } }]).then(
        (applied) => {
          if (applied.length > 0) {
            setUndoable(applied);
            onChanged?.();
          }
        },
      );
    },
    [onChanged],
  );

  const startOver = useCallback(() => {
    historyRef.current = [];
    setLines([]);
    setUndoable([]);
    void clearConversation();
  }, []);

  /**
   * Picks the conversation back up where it stopped.
   *
   * `doneRef` is lowered here as well as at the top of the loop: the effect's
   * own cleanup raises it, and a `restart` arriving in the same commit would
   * otherwise start a loop that reads it as already finished and exits before
   * the first listen.
   */
  const restart = useCallback(() => {
    doneRef.current = false;
    setError(null);
    setPhase('starting');
    setRunId((n) => n + 1);
  }, [setPhase]);

  useEffect(() => () => stopPolling(), [stopPolling]);

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
