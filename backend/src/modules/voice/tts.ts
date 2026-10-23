import { PassThrough, Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

import { config } from '../../config.js';
import { ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

// Text-to-speech for the voice assistant.
//
// The ElevenLabs key stays here: the device asks this server for audio and
// never sees the credential. Nothing is stored — the mp3 is produced, sent,
// and dropped.

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

/** mp3 at 22 kHz / 32 kbps: small enough to stream fast, good enough for speech. */
const OUTPUT_FORMAT = 'mp3_22050_32';

/** A spoken answer is a sentence or three; anything longer is a bug upstream. */
export const MAX_SPEECH_CHARS = 900;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Scripts the low-latency flash model cannot speak. Hebrew is the one that
 * matters — it is only in eleven_v3 — while flash covers the Latin, Cyrillic
 * and Arabic scripts the app's other languages use.
 *
 * Decided from the text itself rather than a language parameter: the assistant
 * answers in whatever language the user spoke, so the device does not know
 * which language a reply is in when it asks for the audio — but the reply
 * carries its own evidence. A single Hebrew word is enough to need v3, or that
 * word comes out mispronounced.
 */
const NEEDS_FULL_MODEL = new RegExp('[\\u0590-\\u05FF]');

export function modelFor(text: string): string {
  return NEEDS_FULL_MODEL.test(text)
    ? config.ELEVENLABS_MODEL_ID
    : config.ELEVENLABS_FAST_MODEL_ID;
}

export function speechRequest(text: string) {
  return {
    text,
    model_id: modelFor(text),
    ...(NEEDS_FULL_MODEL.test(text) ? { language_code: 'he' } : {}),
  };
}

export function isSpeechConfigured(): boolean {
  return Boolean(config.ELEVENLABS_API_KEY);
}

function ttsUrl(): string {
  return `${ENDPOINT}/${encodeURIComponent(config.ELEVENLABS_VOICE_ID)}/stream?output_format=${OUTPUT_FORMAT}`;
}

/**
 * Streams speech directly to the Express response.
 *
 * Uses the ElevenLabs `/stream` endpoint so the first audio chunk arrives
 * before the full sentence is rendered. The client's media player handles
 * chunked transfer and starts playback as bytes arrive, cutting perceived
 * latency roughly in half for Hebrew (eleven_v3).
 */
// ── Pre-warming ────────────────────────────────────────────────────────────
//
// The turn handler starts TTS the moment the LLM reply is ready, before the
// JSON response even reaches the client. By the time the client's audio
// player opens /voice/speak, ElevenLabs is already mid-stream — saving the
// full round trip plus the TTS cold-start (~800ms total).

interface PrewarmedEntry {
  pass: PassThrough;
  timer: ReturnType<typeof setTimeout>;
  failed: boolean;
}

const prewarmed = new Map<string, PrewarmedEntry>();

const PREWARM_TTL_MS = 30_000;

export function prewarmSpeech(text: string): string | null {
  if (!config.ELEVENLABS_API_KEY) return null;
  const trimmed = text.trim().slice(0, MAX_SPEECH_CHARS);
  if (!trimmed) return null;

  const token = randomUUID();
  const pass = new PassThrough();
  const entry: PrewarmedEntry = {
    pass,
    timer: setTimeout(() => {
      prewarmed.delete(token);
      pass.destroy();
    }, PREWARM_TTL_MS),
    failed: false,
  };
  prewarmed.set(token, entry);

  void (async () => {
    try {
      const upstream = await fetch(ttsUrl(), {
        method: 'POST',
        headers: {
          'xi-api-key': config.ELEVENLABS_API_KEY!,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify(speechRequest(trimmed)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!upstream.ok || !upstream.body) {
        entry.failed = true;
        pass.end();
        return;
      }
      const nodeStream = Readable.fromWeb(upstream.body as import('stream/web').ReadableStream);
      nodeStream.pipe(pass);
      nodeStream.on('error', () => {
        entry.failed = true;
        pass.end();
      });
    } catch {
      entry.failed = true;
      pass.end();
    }
  })();

  return token;
}

export function servePrewarmed(token: string, res: Response): boolean {
  const entry = prewarmed.get(token);
  if (!entry || entry.failed) {
    if (entry) {
      prewarmed.delete(token);
      clearTimeout(entry.timer);
      entry.pass.destroy();
    }
    return false;
  }
  prewarmed.delete(token);
  clearTimeout(entry.timer);

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  entry.pass.pipe(res);
  res.on('close', () => entry.pass.destroy());
  return true;
}

export async function synthesizeStream(text: string, res: Response): Promise<void> {
  const apiKey = config.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new ValidationError('Speech is not configured on this server');
  }

  const trimmed = text.trim().slice(0, MAX_SPEECH_CHARS);
  if (!trimmed) {
    throw new ValidationError('Nothing to say');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(ttsUrl(), {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(speechRequest(trimmed)),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      logger.warn({ status: upstream.status, detail: detail.slice(0, 500) }, 'text-to-speech failed');
      throw new ValidationError('Speech generation failed');
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');

    const body = upstream.body;
    if (!body) throw new ValidationError('Speech generation returned no body');

    const nodeStream = Readable.fromWeb(body as import('stream/web').ReadableStream);
    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(res);
      nodeStream.on('end', resolve);
      nodeStream.on('error', reject);
      res.on('close', () => {
        nodeStream.destroy();
        resolve();
      });
    });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    if (controller.signal.aborted) {
      logger.warn('text-to-speech timed out');
      throw new ValidationError('Speech generation timed out');
    }
    logger.warn({ err }, 'text-to-speech request failed');
    throw new ValidationError('Speech generation failed');
  } finally {
    clearTimeout(timer);
  }
}
