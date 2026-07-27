import OpenAI from 'openai';
import { config } from '../../config.js';

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured — chat is disabled');
  }
  if (!client) {
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return client;
}

export const CHAT_MODEL = 'gpt-4o-mini';
