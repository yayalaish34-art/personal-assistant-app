import { config } from '../../config.js';
import { BadGateway, RateLimited, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { ACTION_TOOLS } from './agent.js';

/**
 * Gemini Live: the live half of the voice assistant.
 *
 * The phone holds one WebSocket straight to Google. It streams the microphone
 * up as 16 kHz PCM and plays her voice back as it arrives (24 kHz PCM);
 * hearing, deciding when the user has finished, thinking, speaking and being
 * talked over all happen inside that one connection. What stays here is what
 * cannot move there:
 *
 *  - the API key. Each conversation gets a single-use token instead, and the
 *    whole setup — model, voice, system prompt, tools — is locked inside it.
 *    The phone sends nothing but the model name, so a token read out of the
 *    app opens exactly this assistant, once, and nothing else;
 *  - the tools. Gemini sends each call to the phone, the phone forwards it to
 *    /voice/agent/tool with its own data, and the same `executeToolCall` the
 *    text turn uses runs here. Nothing about what a tool does changed.
 */

const API_HOST = 'generativelanguage.googleapis.com';

/** Where a token-holding client connects. The token goes in `access_token`. */
export const LIVE_SOCKET_URL =
  `wss://${API_HOST}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained`;

/** What the model hears: raw 16-bit little-endian PCM, mono. */
export const LIVE_INPUT_RATE = 16_000;
/** What it speaks: the same encoding, at 24 kHz. */
export const LIVE_OUTPUT_RATE = 24_000;

/** How long the phone has to open the socket once it has a token. */
const OPEN_WITHIN_MS = 2 * 60_000;
/** How long an open conversation may keep using it. */
const SESSION_FOR_MS = 30 * 60_000;

export function isLiveConfigured(): boolean {
  return Boolean(config.GEMINI_API_KEY);
}

/**
 * The part of the prompt that only a live, spoken conversation needs.
 *
 * The mechanics of being interrupted are not the model's: the server's voice
 * detector cuts her off the moment the user starts talking, and the phone
 * drops whatever audio was still queued. These lines are about what she does
 * next — not finish the old sentence, not repeat it, answer what was just said.
 */
export const LIVE_RULES: string[] = [
  'LIVE CONVERSATION — BEING INTERRUPTED:',
  '- This is a live spoken conversation, and the user can talk while you talk.',
  '  The moment they start speaking, you stop — mid-word is fine — and listen.',
  '- After being cut off, do NOT finish the old sentence, do NOT repeat what you',
  '  already said, and do NOT apologise for talking. Answer what they just said.',
  '  The newest thing they said always wins over what you were about to say.',
  '- If what they said was ONLY "wait", "stop", "hold on", "רגע", "שנייה", "די",',
  '  "עצרי", "שקט" or the like, with nothing after it, say no more than a',
  '  two-word "כן?" in their language and wait for them to go on. If they went',
  '  on to ask or say something, skip the "כן?" and answer that straight away.',
  '- If they corrected you while you spoke ("no, Thursday"), act on the',
  '  correction; do not defend or repeat the version they cut off.',
  '- A cough, a noise or a word not meant for you is not a request: if the',
  '  interruption had no words addressed to you, pick up briefly where you stopped.',
  '- Lines that start with "[APP]" come from the app, not from the user: take',
  '  them in silently and never answer them out loud.',
  '- While a tool is running you may say a few words ("רגע, בודקת"), but never',
  '  a result the tool has not returned yet.',
];

/** Every agent tool as a Gemini function declaration. */
export function liveFunctionDeclarations(): Record<string, unknown>[] {
  // Our parameter schemas are plain JSON Schema, which Gemini takes as is.
  // Bounds it ignores are still enforced on every call by `collectAction`.
  return ACTION_TOOLS.map(({ function: fn }) => ({
    name: fn.name,
    description: fn.description,
    parametersJsonSchema: fn.parameters,
  }));
}

/** The setup message for one conversation — what the token locks in. */
export function liveSetup(input: {
  prompt: string;
  /** The app's language, ISO-639-1: what the user's words are written down in. */
  language: string;
  resumeHandle?: string;
}): Record<string, unknown> {
  return {
    model: `models/${config.GEMINI_LIVE_MODEL}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: config.GEMINI_LIVE_VOICE } },
      },
      ...(config.GEMINI_LIVE_THINKING
        ? { thinkingConfig: { thinkingLevel: config.GEMINI_LIVE_THINKING } }
        : {}),
    },
    systemInstruction: { parts: [{ text: input.prompt }] },
    tools: [{ functionDeclarations: liveFunctionDeclarations() }],
    realtimeInputConfig: {
      // Google's own voice detector decides when the user has finished — it
      // copes with a noisy room and with her voice leaking back into the mic
      // far better than anything on the phone could. 800 ms of silence: at
      // 300 the live eval's sentence with a 0.9 s thinking pause in it was cut
      // in two (she answered half a sentence, once with an untitled task).
      // High sensitivity ends the turn as soon as that silence is there.
      automaticActivityDetection: {
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        silenceDurationMs: 800,
      },
      // The default, said out loud: the user talking cuts her off.
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    },
    // Both sides of the conversation as text, for the thread on screen. The
    // user's side is pinned to the app's language: left to guess, a short
    // Hebrew "רגע רגע" came back written as Spanish.
    inputAudioTranscription: { languageCodes: [input.language] },
    outputAudioTranscription: {},
    // Without these an audio session ends at 15 minutes and a connection at
    // about 10. The window slides instead, and the phone reconnects with the
    // last handle when Google says the connection is going away.
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: input.resumeHandle ? { handle: input.resumeHandle } : {},
  };
}

/**
 * Turns a Google refusal into an error the app already knows how to read
 * (`classifyFailure` in voice.ts): "quota" or 429 means out of credit, "api
 * key" means the server is set up wrong, anything else is worth a retry.
 */
function refusal(status: number, body: unknown): Error {
  const error = (body as { error?: { message?: string; status?: string } } | null)?.error;
  const message = error?.message ?? `Gemini returned ${status}`;
  if (status === 429 || /quota|exhausted|billing/i.test(message)) {
    return new RateLimited(`Gemini quota: ${message}`);
  }
  if (status === 401 || status === 403 || /api key/i.test(message)) {
    return new ValidationError(`Gemini API key rejected: ${message}`);
  }
  return new BadGateway(`Gemini: ${message}`);
}

/**
 * A single-use token for one Live conversation, with `setup` locked inside.
 *
 * Uses: 1 — a reconnect after Google retires the connection asks for a new
 * one, carrying the resumption handle in its setup.
 */
export async function mintLiveToken(
  setup: Record<string, unknown>,
): Promise<{ token: string; expiresAt: string }> {
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey) throw new ValidationError('The voice agent is not configured on this server');

  const now = Date.now();
  const expiresAt = new Date(now + SESSION_FOR_MS).toISOString();
  let res: Response;
  try {
    res = await fetch(`https://${API_HOST}/v1beta/auth_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: new Date(now + OPEN_WITHIN_MS).toISOString(),
        bidiGenerateContentSetup: setup,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error).message;
    logger.warn({ cause }, 'Gemini unreachable');
    throw new BadGateway(`Gemini unreachable (${cause})`);
  }

  const body = (await res.json().catch(() => null)) as { name?: string } | null;
  if (!res.ok || !body?.name) {
    logger.warn({ status: res.status, detail: body }, 'Gemini refused a live token');
    throw refusal(res.status, body);
  }
  return { token: body.name, expiresAt };
}
