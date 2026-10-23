import type OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { config } from '../../config.js';
import { getOpenAI } from '../chat/llm.js';
import { logger } from '../../lib/logger.js';

const CLEANUP_MODEL = 'gpt-4.1-nano';
const CLEANUP_TIMEOUT_MS = 8_000;

/** Shared by both transcription routes, so every recording uses the same model. */
export async function transcribeAudio(
  audio: { buffer: Buffer; originalname: string; mimetype: string },
  language?: string,
): Promise<string> {
  try {
    if (audio.buffer.length === 0) return '';
    const file = await toFile(audio.buffer, audio.originalname, { type: audio.mimetype });
    const request: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming = {
      model: config.OPENAI_TRANSCRIBE_MODEL,
      file,
      response_format: 'json',
      temperature: 0,
      ...(language ? { language } : {}),
      ...(language === 'he' ? {
        prompt: 'שיחה בעברית עם עוזרת אישית על יומן, משימות, קניות והוצאות. יש לתמלל רק מילים שנשמעו, בכתיב תקין וברווחים בין המילים. אין להוסיף משפטים לשקט או לרעשי רקע.',
      } : {}),
    };
    const result = await getOpenAI().audio.transcriptions.create(request, {
      timeout: 25_000,
      maxRetries: 0,
    });
    const raw = result.text.trim();
    if (!raw) return '';

    return await cleanupTranscription(raw, language);
  } finally {
    audio.buffer = Buffer.alloc(0);
  }
}

/**
 * Sends the raw transcription through a fast, cheap LLM to fix spelling,
 * spacing and punctuation errors that Whisper commonly introduces — especially
 * in Hebrew where it merges words, drops spaces, and invents spellings.
 *
 * Falls back to the raw text on any failure so a cleanup hiccup never blocks
 * the turn.
 */
async function cleanupTranscription(raw: string, language?: string): Promise<string> {
  if (language !== 'he' || raw.length < 2) return raw;

  try {
    const result = await getOpenAI().chat.completions.create(
      {
        model: CLEANUP_MODEL,
        temperature: 0,
        max_completion_tokens: 400,
        messages: [
          {
            role: 'system',
            content: [
              'You are a speech-transcription post-processor.',
              'Fix ONLY spelling, spacing, and punctuation errors in the text below.',
              'Do NOT change the meaning, add words, remove words, translate, or rephrase.',
              'Return ONLY the corrected text, nothing else.',
              language === 'he'
                ? 'The text is Hebrew. Common errors: merged words that should be separated (e.g. "מיצנבים" → "מיץ ענבים"), missing spaces, wrong letters that sound similar.'
                : `The text is in language code "${language}". Fix obvious transcription errors only.`,
            ].join(' '),
          },
          { role: 'user', content: raw },
        ],
      },
      { timeout: CLEANUP_TIMEOUT_MS, maxRetries: 0 },
    );

    const cleaned = result.choices[0]?.message?.content?.trim();
    if (!cleaned) return raw;

    if (cleaned.length > raw.length * 2 || cleaned.length < raw.length * 0.3) {
      logger.warn({ raw, cleaned }, 'transcription cleanup produced suspicious output — using raw');
      return raw;
    }

    return cleaned;
  } catch (e) {
    logger.warn({ err: e }, 'transcription cleanup failed — using raw text');
    return raw;
  }
}
