import { useCallback, useEffect, useRef, useState } from 'react';

import { uuid } from './api';
import {
  applyActions,
  speechUrl,
  transcribe,
  voiceTurn,
  type AppliedChange,
  type TurnMessage,
} from './voice';

// The conversation itself: listen, understand, act, answer, listen again.
//
// The loop runs on refs rather than state because each step decides what the
// next one does, and a step that read its instructions from a stale render
// would keep listening after the user had already closed the screen.

/**
 * expo-audio calls `requireNativeModule('ExpoAudio')` in its own module body,
 * so it only resolves where the native module is bundled. It is required
 * lazily and guarded, so a build without it shows "voice unavailable" instead
 * of failing to render the screen at all.
 */
type AudioApi = typeof import('expo-audio');

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
    const load = require as (id: string) => AudioApi;
    cachedAudio = load('expo-audio');
  } catch {
    cachedAudio = null;
  }
  return cachedAudio;
}

// ── Tuning ──────────────────────────────────────────────────────────────────

/** Above this (dBFS) counts as someone talking rather than room noise. */
const SPEECH_DB = -38;
/** How long a pause has to last before her turn starts. */
const SILENCE_MS = 1400;
/** Don't cut anyone off mid-thought, even if they started quietly. */
const MIN_LISTEN_MS = 900;
/** A recording this long is someone who forgot to stop, or a noisy room. */
const MAX_LISTEN_MS = 25_000;
const POLL_MS = 150;
/** Metering is optional; if none arrives by now, fall back to tap-to-stop. */
const METERING_GRACE_MS = 1200;

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

export type Line = { id: string; role: 'user' | 'assistant'; text: string };

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
  undoLast: () => void;
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

    const Ctor = (audio as unknown as { AudioRecorder?: new (options: unknown) => Recorder })
      .AudioRecorder;
    if (typeof Ctor !== 'function') throw new Error('The audio module loaded without a recorder.');

    const recorder = new Ctor({
      ...audio.RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
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
      historyRef.current = [...historyRef.current, ...turn].slice(-12);

      if (result.actions.length > 0) {
        const applied = await applyActions(result.actions);
        if (applied.length > 0) {
          setUndoable(applied);
          onChanged?.();
        }
      }

      if (result.reply) {
        addLine('assistant', result.reply);
        if (result.canSpeak) await speak(result.reply);
      }
    },
    [addLine, onChanged, setPhase, speak, userName],
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
      try {
        const { granted } = await audio.AudioModule.requestRecordingPermissionsAsync();
        if (cancelled || doneRef.current) return;
        if (!granted) {
          setPhase('unavailable');
          setError('microphone');
          return;
        }

        // She speaks first, so the user knows she is listening.
        await runTurn(SESSION_START);

        while (!cancelled && !doneRef.current) {
          const uri = await listen();
          if (cancelled || doneRef.current) break;
          if (!uri) continue; // silence — keep the mic open

          setPhase('thinking');
          const said = (await transcribe(uri)).trim();
          if (cancelled || doneRef.current) break;
          if (!said) continue;

          addLine('user', said);
          await runTurn(said);
        }
      } catch (e) {
        if (cancelled || doneRef.current) return;
        setError((e as Error).message);
        setPhase('stopped');
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

  useEffect(() => () => stopPolling(), [stopPolling]);

  return { state, lines, level, error, undoable, toggle, undoLast, end };
}
