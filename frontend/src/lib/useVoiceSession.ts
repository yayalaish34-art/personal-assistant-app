import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

import { uuid } from './api';
import { t, locale } from './i18n';
import {
  applyActions,
  generateImage,
  parseOffer,
  clearConversation,
  loadConversation,
  saveConversation,
  speechUrl,
  transcribe,
  voiceTurn,
  VoiceUnavailableError,
  type AppliedChange,
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
const SPEECH_DB = -38;
/**
 * How long a pause has to last before her turn starts.
 *
 * Long enough to think in. At 1.4s she answered the gap between "tomorrow
 * at..." and the hour, which is what made talking to her feel like dictating
 * one sentence at a time rather than holding a conversation.
 */
const SILENCE_MS = 2600;
/** Don't cut anyone off mid-thought, even if they started quietly. */
const MIN_LISTEN_MS = 900;
/** A recording this long is someone who forgot to stop, or a noisy room. */
const MAX_LISTEN_MS = 25_000;
const POLL_MS = 150;
/** Metering is optional; if none arrives by now, fall back to tap-to-stop. */
const METERING_GRACE_MS = 1200;
/** Failures in a row before the conversation is treated as genuinely broken. */
const MAX_CONSECUTIVE_FAILURES = 3;

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
  undoLast: () => void;
  /** Forget the thread and start over from a greeting. */
  startOver: () => void;
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

  const setPhase = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const addLine = useCallback((role: Line['role'], text: string) => {
    setLines((prev) => [...prev, { id: uuid(), role, text }]);
  }, []);

  // ── Speaking ──────────────────────────────────────────────────────────────

  const stopSpeaking = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (!player) return;
    try {
      player.pause();
      player.remove();
    } catch {
      /* already gone */
    }
  }, []);

  const speak = useCallback(
    async (text: string) => {
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
          stopSpeaking();
          resolve();
        };

        // Playing while the session is still in recording mode comes out of the
        // earpiece on iOS, at a whisper.
        void audio
          .setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
          .catch(() => undefined);

        let subscription: { remove: () => void } | undefined;
        const guard = setTimeout(finish, 60_000);

        try {
          const player = (
            audio as unknown as { createAudioPlayer: (source: { uri: string }) => Player }
          ).createAudioPlayer({ uri: speechUrl(text) });
          playerRef.current = player;
          subscription = player.addListener('playbackStatusUpdate', (status) => {
            if (status.didJustFinish) finish();
          });
          player.play();
        } catch {
          // No voice is survivable — the line is on screen either way.
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

    await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

    // The recorder class hangs off the native module, not off the package
    // root: `expo-audio` exports hooks, `createAudioPlayer` and the presets
    // from its index, and nothing called AudioRecorder. Read from the root it
    // came back undefined, so every attempt to listen threw here — before the
    // microphone was ever opened. The greeting still played, because speaking
    // only needs `createAudioPlayer`, which made it look like a transcription
    // problem rather than a recorder that never existed.
    const Ctor = (
      audio as unknown as { AudioModule?: { AudioRecorder?: new (options: unknown) => Recorder } }
    ).AudioModule?.AudioRecorder;
    if (typeof Ctor !== 'function') throw new Error('The audio module loaded without a recorder.');

    const recorder = new Ctor(recordingOptions(audio));
    recorderRef.current = recorder;
    await recorder.prepareToRecordAsync();
    recorder.record();
    setPhase('listening');

    const startedAt = Date.now();
    let heardSpeech = false;
    let quietSince: number | null = null;
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

        if (db > SPEECH_DB) {
          heardSpeech = true;
          quietSince = null;
          return;
        }
        if (!heardSpeech || elapsed < MIN_LISTEN_MS) return;

        if (quietSince === null) quietSince = Date.now();
        else if (Date.now() - quietSince > SILENCE_MS) resolve('stopped');
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
    async (said: string): Promise<void> => {
      setPhase('thinking');
      const result = await voiceTurn(said, historyRef.current, userName);
      if (doneRef.current) return;

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
      // An offer is not a change to apply; it is a question to put on screen.
      // The server raises it in place of the create it refused, so there is
      // nothing to undo and nothing has happened yet.
      const offer = result.actions
        .filter((a) => a.tool === 'offer_times')
        .map((a) => parseOffer(a.arguments ?? {}))
        .find((o): o is TimeOffer => o !== null);
      const rest = result.actions.filter(
        (a) => a.tool !== 'create_image' && a.tool !== 'offer_times',
      );

      for (const draw of drawings) {
        const prompt = typeof draw.arguments?.prompt === 'string' ? draw.arguments.prompt : '';
        if (!prompt) continue;
        const shape =
          typeof draw.arguments?.shape === 'string' ? draw.arguments.shape : undefined;
        const id = uuid();
        setLines((prev) => [...prev, { id, role: 'assistant', text: '', drawing: true }]);

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

      if (result.reply || offer) {
        // One line carries both: what she said, and what there is to tap. They
        // are the same turn, so splitting them would read as two answers.
        setLines((prev) => [
          ...prev,
          { id: uuid(), role: 'assistant', text: result.reply, ...(offer ? { offer } : {}) },
        ]);
        if (result.reply && result.canSpeak) await speak(result.reply);
      }
    },
    [onChanged, setPhase, speak, userName],
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
          const said = (await transcribe(uri)).trim();
          if (cancelled || doneRef.current) break;
          if (!said) continue;

          addLine('user', said);
          await runTurn(said);
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
          setError((e as Error).message);
          // The line the user sees says only that the turn was lost, and the
          // screen shows `error` for nothing but a refused microphone — so
          // without this the actual reason reached no one, and a recorder that
          // never loaded looked exactly like a bad connection.
          console.warn('[voice] turn failed:', (e as Error)?.message ?? e);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            setPhase('stopped');
            break;
          }
          // Say so and carry on listening, rather than dropping the user into
          // a dead screen because one request failed.
          addLine('assistant', t('voice.hiccup'));
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
      void recorderRef.current?.stop().catch(() => undefined);
      recorderRef.current = null;
      // Hand the audio session back, or the next app to play sound gets the
      // recording-mode volume.
      void getAudio()
        ?.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
        .catch(() => undefined);
    };
    // Set up once per screen: the loop owns its own lifecycle from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const startOver = useCallback(() => {
    historyRef.current = [];
    setLines([]);
    setUndoable([]);
    void clearConversation();
  }, []);

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
    undoLast,
    startOver,
    end,
  };
}
