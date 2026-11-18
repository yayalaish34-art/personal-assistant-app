import {
  AudioContext,
  AudioManager,
  AudioRecorder,
  type AudioBufferQueueSourceNode,
  type GainNode,
} from 'react-native-audio-api';

import { DeleteGuard } from './deleteGuard';
import type { LiveTicket } from './voice';

// One live conversation with Gemini, over one WebSocket.
//
// The microphone streams up all the time as 16 kHz PCM — Google's own voice
// detector decides when the user has started and finished, which copes with a
// noisy room far better than anything on the phone could. Her voice comes
// back as 24 kHz PCM and is queued for playback as it arrives.
//
// Being talked over is the part that has to be instant. Google cuts her reply
// off on its side and says `interrupted`; the phone drops everything still
// queued, the same moment. And because she is generated faster than she is
// spoken, a long answer can be finished on Google's side while the phone is
// still playing it — there is nothing left there to interrupt, so the phone
// also stops on its own the moment Google reports the user has started to
// speak (`voiceActivity: ACTIVITY_START`).
//
// The capture runs through Apple's voice-processing I/O (echo cancellation,
// noise suppression, gain control) and Android's voice-communication chain:
// without it, her own voice coming out of the speaker would sound to the
// detector like the user talking over her, and she would keep cutting herself
// off.

export type LivePhase = 'listening' | 'thinking' | 'speaking';

export interface LiveCallbacks {
  /** What the user has said so far in utterance `n`, as it is transcribed. */
  onUserText(n: number, text: string): void;
  /**
   * What she has said so far in reply `n`. `done` once the reply is over;
   * `cut` when she was talked over, with `text` trimmed to about what had
   * actually been played.
   */
  onAgentText(n: number, text: string, state: 'open' | 'done' | 'cut'): void;
  onPhase(phase: LivePhase): void;
  /** Runs one tool she called; the string is what she is told back. */
  onToolCall(name: string, args: Record<string, unknown>): Promise<string>;
  /**
   * The conversation is over and a reconnect would not bring it back: it was
   * closed on purpose, the quota is gone, or the server refused the setup.
   */
  onEnded(error?: Error): void;
}

/** Opens a ticket for one connection; `resumeHandle` carries a session on. */
export type TicketSource = (resumeHandle?: string) => Promise<LiveTicket>;

const SETUP_TIMEOUT_MS = 15_000;
/** Mic chunk length. Google suggests 20–100 ms; 100 keeps the bridge quiet. */
const CHUNK_MS = 100;
/** Reconnects allowed in a row before giving up on the conversation. */
const MAX_RECONNECTS = 3;
/**
 * How long "thinking" may last with nothing happening. A cough Google took
 * for a turn can end with no reply at all, and the orb would think forever.
 */
const THINKING_LIMIT_MS = 12_000;

type ServerMessage = {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string }; text?: string }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
  toolCallCancellation?: { ids?: string[] };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
  voiceActivity?: { type?: string };
};

// ── Bytes ───────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! + '=' : '==';
  }
  return out;
}

/** Float samples in −1…1 to 16-bit little-endian PCM. */
function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Google sends its JSON as binary frames; Hebrew in them needs real UTF-8. */
function utf8(bytes: Uint8Array): string {
  const Decoder = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } }).TextDecoder;
  if (Decoder) return new Decoder().decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]!;
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** The orb's 0–1 from a signal's RMS, which sits low for speech. */
const toLevel = (value: number) => Math.min(1, value * 6);

/** Keeps the first `fraction` of a sentence, cut at a word. */
function trimTo(text: string, fraction: number): string {
  if (fraction >= 0.98) return text;
  const cut = text.slice(0, Math.max(0, Math.round(text.length * fraction)));
  const atWord = cut.replace(/\s+\S*$/, '');
  return (atWord || cut).trim() + '…';
}

// ── The session ─────────────────────────────────────────────────────────────

export class LiveSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private handle: string | undefined;
  private reconnects = 0;

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private queue: AudioBufferQueueSourceNode | null = null;
  private recorder: AudioRecorder | null = null;
  private outputRate = 24_000;

  /** Bumped by every flush, so audio still being decoded for a cut reply is dropped. */
  private generation = 0;
  private decoding: Promise<void> = Promise.resolve();
  /** When everything queued so far will have finished playing (ms, wall clock). */
  private playUntil = 0;
  /** Her loudness per stretch of queued audio, for the orb. */
  private levels: { from: number; to: number; level: number }[] = [];
  private inputLevel = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private utterance = 0;
  private userText = '';
  private reply = 0;
  private agentText = '';
  /** Seconds of her voice received for the current reply, and when it began playing. */
  private replyAudioSec = 0;
  private replyStartedAt = 0;
  private replyOpen = false;
  /** Google is still sending the current reply (until `turnComplete` or `interrupted`). */
  private serverTurn = false;
  /**
   * The rest of the reply Google is still sending is not to be played: she
   * was talked over, tapped quiet, or typed over. Without this, audio already
   * on its way when the phone cut her off would open a new reply and play a
   * scrap of the old one after the cut.
   */
  private discard = false;
  /** Google said this connection is going away; move once she is quiet. */
  private retiring: ReturnType<typeof setTimeout> | null = null;
  private phase: LivePhase = 'listening';
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private toolsRunning = 0;
  /** More than two deletions in one request wait for a yes (see deleteGuard.ts). */
  private guard = new DeleteGuard();
  /** What the user last said or typed, for the guard to read a yes in. */
  private lastWords = '';
  private cancelled = new Set<string>();

  private constructor(
    private readonly tickets: TicketSource,
    private readonly cb: LiveCallbacks,
  ) {}

  /** Opens the conversation: audio first, then the socket. Rejects if either fails. */
  static async start(tickets: TicketSource, cb: LiveCallbacks): Promise<LiveSession> {
    const session = new LiveSession(tickets, cb);
    try {
      const ticket = await tickets();
      await session.startAudio(ticket);
      await session.connect(ticket);
      return session;
    } catch (e) {
      session.closed = true;
      await session.stopAudio();
      throw e;
    }
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  private async startAudio(ticket: LiveTicket): Promise<void> {
    this.outputRate = ticket.outputRate;
    AudioManager.setSystemOptions({
      ios: {
        category: 'playAndRecord',
        mode: 'voiceChat',
        options: ['defaultToSpeaker', 'allowBluetoothHFP'],
      },
      android: { mode: 'inCommunication', communicationDevice: 'speaker' },
    });
    await AudioManager.setAudioSessionActivity(true);

    const ctx = new AudioContext({ sampleRate: ticket.outputRate, androidOutputProfile: 'voiceCommunication' });
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const queue = ctx.createBufferQueueSource();
    queue.connect(gain);
    queue.start();
    this.ctx = ctx;
    this.gain = gain;
    this.queue = queue;

    const recorder = new AudioRecorder({
      iosVoiceProcessing: true,
      androidInputPreset: 'voiceCommunication',
    });
    const listening = recorder.onAudioReady(
      { sampleRate: ticket.inputRate, bufferLength: (ticket.inputRate * CHUNK_MS) / 1000, channelCount: 1 },
      ({ buffer, numFrames }) => {
        const samples = buffer.getChannelData(0).subarray(0, numFrames);
        this.inputLevel = toLevel(rms(samples));
        if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
        this.send({
          realtimeInput: {
            audio: { data: toBase64(toPcm16(samples)), mimeType: `audio/pcm;rate=${buffer.sampleRate}` },
          },
        });
      },
    );
    if (listening.status === 'error') throw new Error(`microphone: ${listening.message}`);
    const started = await recorder.start();
    if (started.status === 'error') throw new Error(`microphone: ${started.message}`);
    this.recorder = recorder;
  }

  private async stopAudio(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const recorder = this.recorder;
    this.recorder = null;
    try {
      recorder?.clearOnAudioReady();
      if (recorder?.isRecording()) await recorder.stop();
    } catch { /* already stopped */ }
    try {
      this.queue?.clearBuffers();
      this.queue?.stop();
    } catch { /* already stopped */ }
    this.queue = null;
    this.gain = null;
    try {
      await this.ctx?.close();
    } catch { /* already closed */ }
    this.ctx = null;
    try {
      await AudioManager.setAudioSessionActivity(false);
    } catch { /* another session owns it */ }
  }

  /** Queues one chunk of her voice. Decoded in arrival order. */
  private play(base64: string): void {
    const generation = this.generation;
    this.decoding = this.decoding.then(async () => {
      const ctx = this.ctx;
      const queue = this.queue;
      if (!ctx || !queue || generation !== this.generation) return;
      try {
        const buffer = await ctx.decodePCMInBase64(base64, this.outputRate, 1);
        if (generation !== this.generation) return;
        const level = toLevel(rms(buffer.getChannelData(0)));
        queue.enqueueBuffer(buffer);
        const now = Date.now();
        const from = Math.max(now, this.playUntil);
        this.playUntil = from + buffer.duration * 1000;
        this.levels.push({ from, to: this.playUntil, level });
        if (this.levels.length > 200) this.levels.splice(0, this.levels.length - 200);
      } catch (e) {
        console.warn('[live] could not play a chunk:', (e as Error)?.message ?? e);
      }
    });
  }

  /** Drops everything still queued to be said. */
  private flush(): void {
    this.generation += 1;
    try {
      this.queue?.clearBuffers();
    } catch { /* nothing queued */ }
    this.playUntil = 0;
    this.levels = [];
  }

  private isPlaying(): boolean {
    return Date.now() < this.playUntil;
  }

  /** 0–1 for the orb: her voice while she speaks, the mic otherwise. */
  level(speaking: boolean): number {
    if (!speaking) return this.inputLevel;
    const now = Date.now();
    return this.levels.find((l) => l.from <= now && now < l.to)?.level ?? 0;
  }

  // ── The socket ────────────────────────────────────────────────────────────

  private send(message: unknown): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /** Opens one connection and waits for Google to accept the setup. */
  private connect(ticket: LiveTicket): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${ticket.url}?access_token=${encodeURIComponent(ticket.token)}`);
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error('Gemini did not answer in time'));
      }, SETUP_TIMEOUT_MS);

      ws.onopen = () => ws.send(JSON.stringify({ setup: { model: ticket.model } }));
      ws.onmessage = (event) => {
        let message: ServerMessage;
        try {
          const data = event.data as unknown;
          message = JSON.parse(typeof data === 'string' ? data : utf8(new Uint8Array(data as ArrayBuffer)));
        } catch {
          return;
        }
        if (message.setupComplete !== undefined && !settled) {
          settled = true;
          clearTimeout(timer);
          const previous = this.ws;
          this.ws = ws;
          this.ready = true;
          this.reconnects = 0;
          // A connection being retired is closed only once its successor is up.
          if (previous && previous !== ws) {
            previous.onclose = null;
            previous.close(1000);
          }
          resolve();
          return;
        }
        if (this.ws === ws) this.receive(message);
      };
      ws.onerror = () => { /* onclose follows with the reason */ };
      ws.onclose = (event) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(closeError(event.code, event.reason) ?? new Error(`Gemini closed the connection (${event.code})`));
          return;
        }
        if (this.ws === ws) this.lost(event.code, event.reason);
      };
    });
  }

  /** The connection dropped under us: carry on over a new one, or end. */
  private lost(code: number, reason: string): void {
    this.ready = false;
    if (this.closed) return;
    const fatal = closeError(code, reason);
    if (fatal && !/handle|resum/i.test(reason)) {
      void this.finish(fatal);
      return;
    }
    void this.reconnect();
  }

  private retire(): void {
    if (!this.retiring) return;
    clearTimeout(this.retiring);
    this.retiring = null;
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      void this.finish(new Error('The connection to the assistant keeps dropping'));
      return;
    }
    this.reconnects += 1;
    this.endReply('cut');
    this.flush();
    // Whatever the old connection was still sending belongs to it.
    this.serverTurn = false;
    this.discard = false;
    try {
      await this.connect(await this.tickets(this.handle));
    } catch (e) {
      // A handle Google no longer accepts: start fresh. The thread so far
      // rides along in the new prompt, so she still knows what was said.
      if (this.handle) {
        this.handle = undefined;
        void this.reconnect();
        return;
      }
      if (this.reconnects < MAX_RECONNECTS) {
        await new Promise((r) => setTimeout(r, 1000 * this.reconnects));
        void this.reconnect();
        return;
      }
      void this.finish(e as Error);
    }
  }

  private setPhase(next: LivePhase): void {
    if (this.phase === next) return;
    this.phase = next;
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = next === 'thinking' ? setTimeout(() => this.unstick(), THINKING_LIMIT_MS) : null;
    this.cb.onPhase(next);
  }

  /** Back to listening when "thinking" led nowhere — unless a tool is still at work. */
  private unstick(): void {
    this.thinkingTimer = null;
    if (this.closed || this.phase !== 'thinking') return;
    if (this.toolsRunning > 0 || this.replyOpen) {
      this.thinkingTimer = setTimeout(() => this.unstick(), THINKING_LIMIT_MS);
      return;
    }
    this.setPhase('listening');
  }

  /** Listening again once the last of her reply has actually been heard. */
  private listenWhenQuiet(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const wait = this.playUntil - Date.now();
    if (wait <= 0) {
      if (!this.replyOpen) {
        this.setPhase('listening');
        if (this.retiring) this.retire();
      }
      return;
    }
    this.idleTimer = setTimeout(() => this.listenWhenQuiet(), wait + 50);
  }

  private endReply(state: 'done' | 'cut'): void {
    if (!this.replyOpen) return;
    this.replyOpen = false;
    let text = this.agentText.trim();
    if (state === 'cut' && this.replyAudioSec > 0) {
      const played = (Date.now() - this.replyStartedAt) / 1000;
      text = trimTo(text, Math.max(0, played / this.replyAudioSec));
    }
    if (text) this.cb.onAgentText(this.reply, text, state);
    this.agentText = '';
    this.replyAudioSec = 0;
  }

  /** Stops her now, on this side: the queue, the line, and the rest of the reply on its way. */
  private cutOff(): void {
    if (!this.replyOpen && !this.isPlaying()) return;
    this.discard = this.serverTurn;
    this.endReply('cut');
    this.flush();
    this.setPhase('listening');
  }

  private receive(message: ServerMessage): void {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.handle = message.sessionResumptionUpdate.newHandle;
    }
    if (message.goAway) {
      // Google is about to retire this connection. Move to a new one while
      // this one still works — at the next quiet moment, so she is not cut
      // off mid-sentence, and in any case a little before the deadline.
      const left = parseFloat(message.goAway.timeLeft ?? '') * 1000;
      if (!this.retiring) {
        this.retiring = setTimeout(() => this.retire(), Math.max(0, (Number.isFinite(left) ? left : 10_000) - 2_000));
        if (this.phase === 'listening' && !this.replyOpen && !this.isPlaying()) this.retire();
      }
      return;
    }

    const activity = message.voiceActivity?.type;
    if (activity === 'ACTIVITY_START') {
      this.utterance += 1;
      this.userText = '';
      this.lastWords = '';
      this.guard.userTurn();
      this.cutOff();
    } else if (activity === 'ACTIVITY_END' && this.phase !== 'speaking') {
      this.setPhase('thinking');
    }

    if (message.toolCall) {
      void this.runTools(message.toolCall.functionCalls ?? []);
      return;
    }
    for (const id of message.toolCallCancellation?.ids ?? []) this.cancelled.add(id);

    const content = message.serverContent;
    if (!content) return;

    const heard = content.inputTranscription?.text;
    if (heard) {
      this.userText += heard;
      this.lastWords = this.userText;
      this.cb.onUserText(this.utterance, this.userText.trim());
    }

    if (content.interrupted) {
      this.cutOff();
      this.serverTurn = false;
      this.discard = false;
      return;
    }

    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (!data || !part.inlineData?.mimeType?.startsWith('audio/')) continue;
      this.serverTurn = true;
      if (this.discard) continue;
      this.openReply();
      if (this.replyAudioSec === 0) this.replyStartedAt = Math.max(Date.now(), this.playUntil);
      // 16-bit mono: two bytes a sample, four base64 characters per three bytes.
      this.replyAudioSec += (data.length * 3) / 4 / 2 / this.outputRate;
      this.play(data);
      this.setPhase('speaking');
    }

    const said = content.outputTranscription?.text;
    if (said && !this.discard) {
      this.serverTurn = true;
      this.openReply();
      this.agentText += said;
      this.cb.onAgentText(this.reply, this.agentText.trim(), 'open');
    }

    if (content.turnComplete) {
      this.endReply('done');
      this.serverTurn = false;
      this.discard = false;
      this.listenWhenQuiet();
    }
  }

  private openReply(): void {
    if (this.replyOpen) return;
    this.replyOpen = true;
    this.reply += 1;
    this.agentText = '';
    this.replyAudioSec = 0;
  }

  /** Runs her calls in order — a later one may depend on an earlier one — and answers them together. */
  private async runTools(calls: { id: string; name: string; args?: Record<string, unknown> }[]): Promise<void> {
    if (this.phase !== 'speaking') this.setPhase('thinking');
    const responses: { id: string; name: string; response: { result: string } }[] = [];
    const screened = this.guard.screen(calls, this.lastWords);
    if (!screened.allowed) {
      for (const call of calls) {
        if (!this.cancelled.has(call.id)) {
          responses.push({ id: call.id, name: call.name, response: { result: screened.refusal(call) } });
        }
      }
      this.send({ toolResponse: { functionResponses: responses } });
      return;
    }
    for (const call of calls) {
      if (this.cancelled.has(call.id)) continue;
      let result: string;
      this.toolsRunning += 1;
      try {
        result = await this.cb.onToolCall(call.name, call.args ?? {});
      } catch (e) {
        result = JSON.stringify({ ok: false, error: (e as Error)?.message ?? String(e) });
      } finally {
        this.toolsRunning -= 1;
      }
      if (this.cancelled.has(call.id)) continue;
      responses.push({ id: call.id, name: call.name, response: { result } });
    }
    if (responses.length > 0) this.send({ toolResponse: { functionResponses: responses } });
  }

  // ── What the screen can do ────────────────────────────────────────────────

  /** A typed line, in the same conversation. Typing means she should stop talking. */
  sendText(text: string): void {
    this.hush();
    this.guard.userTurn();
    this.lastWords = text;
    this.send({ realtimeInput: { text } });
    this.setPhase('thinking');
  }

  /** Tells her something the app knows, without it counting as the user talking. */
  sendContext(text: string): void {
    this.send({
      clientContent: { turns: [{ role: 'user', parts: [{ text: `[APP] ${text}` }] }], turnComplete: false },
    });
  }

  /** Silences the rest of her current reply. */
  hush(): void {
    this.cutOff();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.retiring) clearTimeout(this.retiring);
    this.retiring = null;
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(1000);
      } catch { /* already closed */ }
    }
    await this.stopAudio();
  }

  private async finish(error?: Error): Promise<void> {
    if (this.closed) return;
    await this.close();
    this.cb.onEnded(error);
  }
}

/**
 * Reads a close that a reconnect would not fix.
 *
 * The words "quota" and "api key" are what `useVoiceSession` sorts failures
 * by, the same as for a refused request to our own server.
 */
function closeError(code: number, reason: string): Error | null {
  if (/quota|exhausted|billing|rate limit/i.test(reason)) return new Error(`quota: ${reason}`);
  if (/api key|permission|unauthori[sz]ed/i.test(reason)) return new Error(`api key: ${reason}`);
  // 1007: the setup was refused. 1008: policy. Neither changes on a retry.
  if (code === 1007 || code === 1008) return new Error(reason || `Gemini refused the session (${code})`);
  return null;
}
