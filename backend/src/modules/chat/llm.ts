import OpenAI from 'openai';
import { config } from '../../config.js';

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured — chat is disabled');
  }
  if (!client) {
    client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      // The SDK defaults to a ten-minute timeout and two retries, which is
      // sane for a batch job and wrong for anything a person is waiting on: a
      // stalled connection could hold a request open for half an hour before
      // failing, and every route here is in front of somebody. A minute is
      // already far longer than a slow completion takes, so hitting it means
      // something is wrong rather than slow — and one retry covers the blip
      // this is actually likely to be.
      timeout: 60_000,
      maxRetries: 1,
    });
  }
  return client;
}

export const CHAT_MODEL = 'gpt-4o-mini';
