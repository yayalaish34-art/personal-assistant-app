import { z } from 'zod';

export const configSchema = z.object({
  // Defaults to production, not development. A deploy that forgets to set this
  // used to get the development behaviour — the dev sign-in shortcut mounted
  // and internal error messages returned to the caller — which is exactly
  // backwards: the environment nobody configured is the one that must be shut.
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('production'),
  // The dev sign-in shortcut needs saying out loud. It used to ride on
  // `NODE_ENV !== 'production'`, so it appeared wherever the environment was
  // merely unset; now it takes a development environment AND this flag.
  ENABLE_DEV_AUTH: z.enum(['true', 'false']).default('false'),
  PORT: z.coerce.number().default(5000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Optional: the AI endpoints are stateless. Set it only to re-enable the
  // database-backed routes and the pg-boss job queue.
  DATABASE_URL: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Approx. $0.003/minute; full gpt-4o-transcribe is $0.006/minute.
  OPENAI_TRANSCRIBE_MODEL: z.string().trim().min(1).default('gpt-4o-mini-transcribe'),
  // The voice assistant runs on its own model: it has to pick the right tool
  // first time (a spoken "I deleted it" that called nothing is a lie the user
  // only discovers later), and it has to answer fast enough to feel like a
  // conversation. gpt-4o-mini (the text chat model) is not reliable enough
  // at tool selection; gpt-4.1-mini — the previous default — looked right
  // on the chat samples but QA found it systematically dropping tool calls
  // on recurring plans and summary requests, narrating "I'll do X" with
  // zero actions. gpt-4o follows the system prompt's "call the tool, do
  // not propose and wait" rule much more reliably at a few cents more per
  // turn, and 9.1 (the stakeholder's workout scenario) is the moment this
  // app has to not fail.
  OPENAI_VOICE_MODEL: z.string().default('gpt-4o'),
  // When the server already decided which function to call (see
  // detectForcedTool in modules/voice/agent.ts), the model's only remaining
  // job is to fill in the arguments. gpt-4o-mini does that cheaply and
  // reliably — roughly a sixth of the price of gpt-4o per turn. Free rounds
  // keep the stronger model.
  OPENAI_FORCED_TOOL_MODEL: z.string().default('gpt-4o-mini'),
  // The agent's drawings. gpt-image-1 was retired; its successor takes the
  // same request.
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-1.5'),
  // Text-to-speech for the voice assistant. Without a key the app still works;
  // the assistant answers in text and simply does not speak.
  ELEVENLABS_API_KEY: z.string().optional(),
  // "Jessica — Playful, Bright, Warm". Override to change who she sounds like.
  ELEVENLABS_VOICE_ID: z.string().default('cgSgspJ2msm6clMCkdW9'),
  // Hebrew is only supported by eleven_v3; the flash/turbo models cover Latin
  // and Cyrillic scripts at lower latency. See voice/tts.ts for the choice.
  ELEVENLABS_MODEL_ID: z.string().default('eleven_v3'),
  ELEVENLABS_FAST_MODEL_ID: z.string().default('eleven_flash_v2_5'),
  // The ElevenLabs agent the app talks to live (voice in, voice out, and the
  // model in between). Created and kept in sync by scripts/elevenlabs-agent.ts,
  // which also prints the id to put here. Without it /voice/agent/* answers
  // "not configured" and the app cannot open a conversation.
  ELEVENLABS_AGENT_ID: z.string().optional(),
  // The model the agent thinks with, on ElevenLabs' side. Read by the sync
  // script only; changing it takes a re-run of the script, not a deploy.
  ELEVENLABS_AGENT_LLM: z.string().default('gemini-3.5-flash'),
  // Google Maps Platform (Geocoding, Routes, Places). Optional: without a key
  // every lookup stays on the free path (OSM snapshot, Open-Meteo/Nominatim,
  // straight-line estimate) exactly as before. Restrict the key in Cloud
  // Console to those three APIs and set daily quotas there as well — this
  // server's budget is the first fence, Google's quotas the second.
  // An empty value (as copied from .env.example) means "not set", never a
  // startup failure.
  GOOGLE_MAPS_API_KEY: z
    .string()
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined)),
  // Kill switch. 'false' sends nothing to Google even with a key set.
  GOOGLE_MAPS_ENABLED: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['true', 'false']).default('true'),
  ),
  // Daily ceiling at list price (free monthly allowance not subtracted, so
  // this is an upper bound). Past it, lookups fall back to the free path.
  // Empty means the default, not zero — zero would silently switch Google off.
  GOOGLE_MAPS_DAILY_BUDGET_USD: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().nonnegative().default(5),
  ),
  // The live voice agent: Gemini Live, over one WebSocket from the phone. The
  // key never leaves this server — each conversation gets a single-use token
  // with the whole setup (prompt, tools, voice) locked inside it. Without the
  // key /voice/live/session answers "not configured".
  GEMINI_API_KEY: z.string().optional(),
  // gemini-3.8-live is the newer model; it also runs tools without pausing
  // the conversation. Switching is this variable alone, no deploy of the app.
  GEMINI_LIVE_MODEL: z.string().trim().min(1).default('gemini-3.1-flash-live-preview'),
  // One of the prebuilt voices (the same set as Gemini TTS). Kore is a calm
  // female voice; she speaks of herself in the feminine.
  GEMINI_LIVE_VOICE: z.string().trim().min(1).default('Kore'),
  // minimal | low | medium | high, for the 3.1 model (it defaults to minimal,
  // the fastest). Unset sends nothing: 3.8 refuses the setting outright.
  GEMINI_LIVE_THINKING: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  // How many proxies stand between the user and this server, so `req.ip` is the
  // user's address rather than the last proxy's. On Railway that is two: its
  // edge, which appends the caller to X-Forwarded-For, and the internal proxy
  // that opens the connection (a 100.64.x.x address). Without it every user
  // reaching the same proxy shared one rate-limit bucket. Addresses a client
  // writes into the header itself sit further left and are never reached.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(2),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s.split(',').map((o) => o.trim()).filter(Boolean)
        : [],
    ),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    console.error(
      `[config] Environment validation failed — startup aborted.\n` +
        `Missing or invalid variables:\n${issues}`,
    );
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
