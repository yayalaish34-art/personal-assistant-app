import { config } from '../../config.js';
import { ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

// Text-to-speech for the voice assistant.
//
// The ElevenLabs key stays here: the device asks this server for audio and
// never sees the credential. Nothing is stored — the mp3 is produced, sent,
// and dropped.

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

/** mp3 at 44.1 kHz / 128 kbps: what every mobile player handles without fuss. */
const OUTPUT_FORMAT = 'mp3_44100_128';

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

export function isSpeechConfigured(): boolean {
  return Boolean(config.ELEVENLABS_API_KEY);
}

/**
 * Renders `text` as speech and returns the mp3 bytes.
 *
 * Throws ValidationError when speech is not configured, so the caller can fall
 * back to a silent (text-only) reply instead of failing the whole turn.
 */
export async function synthesize(text: string): Promise<Buffer> {
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
    const res = await fetch(
      `${ENDPOINT}/${encodeURIComponent(config.ELEVENLABS_VOICE_ID)}?output_format=${OUTPUT_FORMAT}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text: trimmed, model_id: modelFor(trimmed) }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      // The body carries the provider's reason (quota, bad voice id, …). Log
      // it for us; the caller only learns that speech failed.
      const detail = await res.text().catch(() => '');
      logger.warn({ status: res.status, detail: detail.slice(0, 500) }, 'text-to-speech failed');
      throw new ValidationError('Speech generation failed');
    }

    return Buffer.from(await res.arrayBuffer());
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
