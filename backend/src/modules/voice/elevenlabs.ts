import { config } from '../../config.js';
import { BadGateway, RateLimited, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { ACTION_TOOLS } from './agent.js';

/**
 * The ElevenLabs agent: the live half of the voice assistant.
 *
 * ElevenLabs runs the whole spoken loop — transcription, deciding when the user
 * has finished, the model, and the voice — over one WebRTC connection from the
 * phone. What stays here is what cannot move there:
 *
 *  - the API key, which is exchanged for a short-lived conversation token per
 *    session, so the phone never holds it;
 *  - the tools. Every one of them is a *client* tool on the agent: the phone
 *    receives the call, forwards it here with its own data, and this server
 *    runs the same `executeToolCall` the text turn uses. Nothing about what a
 *    tool does changed in the move.
 */

export const CONVAI_API = 'https://api.elevenlabs.io/v1/convai';

export function isAgentConfigured(): boolean {
  return Boolean(config.ELEVENLABS_API_KEY && config.ELEVENLABS_AGENT_ID);
}

/** The names the phone has to register handlers for. */
export const AGENT_TOOL_NAMES: string[] = ACTION_TOOLS.map((t) => t.function.name);

// ── Calling ElevenLabs ──────────────────────────────────────────────────────

/**
 * Turns an ElevenLabs refusal into an error the app already knows how to read.
 *
 * The device sorts failures by their message and status (`classifyFailure` in
 * voice.ts): "quota" or a 429 means the account is out of credits and retrying
 * is pointless; "api key" means the server is set up wrong. Anything else is a
 * provider hiccup worth one more try.
 */
function refusal(status: number, body: unknown): Error {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const message =
    typeof detail === 'string'
      ? detail
      : ((detail as { message?: string } | undefined)?.message ?? `ElevenLabs returned ${status}`);
  const code = (detail as { code?: string; status?: string } | undefined)?.code
    ?? (detail as { status?: string } | undefined)?.status;

  if (status === 429 || /quota|credit/i.test(message) || /quota/i.test(code ?? '')) {
    return new RateLimited(`ElevenLabs quota: ${message}`);
  }
  if (status === 401 || status === 403) {
    return new ValidationError(`ElevenLabs API key rejected: ${message}`);
  }
  return new BadGateway(`ElevenLabs: ${message}`);
}

export async function convai<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const apiKey = config.ELEVENLABS_API_KEY;
  if (!apiKey) throw new ValidationError('The voice agent is not configured on this server');

  let res: Response;
  try {
    res = await fetch(`${CONVAI_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'xi-api-key': apiKey,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // "fetch failed" hides the real cause (DNS, reset, timeout) in `cause`.
    const cause = (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error).message;
    logger.warn({ path: path.split('?')[0], cause }, 'ElevenLabs unreachable');
    throw new BadGateway(`ElevenLabs unreachable (${cause})`);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    logger.warn(
      { path: path.split('?')[0], status: res.status, detail: (body as { detail?: unknown })?.detail ?? body },
      'ElevenLabs refused',
    );
    throw refusal(res.status, body);
  }
  return body as T;
}

/**
 * A one-conversation WebRTC token for the agent.
 *
 * The agent has auth switched on, so its id alone opens nothing: a stranger
 * who reads it out of the app cannot start conversations on this account.
 */
export async function conversationToken(): Promise<string> {
  if (!isAgentConfigured()) {
    throw new ValidationError('The voice agent is not configured on this server');
  }
  const { token } = await convai<{ token: string }>(
    `/conversation/token?agent_id=${encodeURIComponent(config.ELEVENLABS_AGENT_ID!)}`,
  );
  return token;
}

// ── The tools, in ElevenLabs' terms ─────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

/**
 * Rewrites one of our OpenAI-style parameter schemas into the subset
 * ElevenLabs accepts.
 *
 * Their schema is stricter than JSON Schema: each property is a literal, an
 * object or an array with a fixed set of keys, and every one needs a
 * description (the model reads it; an empty one is rejected). Bounds like
 * `maxItems` have no place to go and are dropped — the server-side gate in
 * `collectAction` still enforces them on every call.
 */
export function toElevenLabsSchema(schema: JsonSchema, name = 'value'): JsonSchema {
  const description =
    typeof schema.description === 'string' && schema.description.trim()
      ? schema.description
      : `The ${name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}.`;

  if (schema.type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    return {
      type: 'object',
      description,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, toElevenLabsSchema(value, key)]),
      ),
      required: Array.isArray(schema.required) ? schema.required : [],
    };
  }

  if (schema.type === 'array') {
    const items = (schema.items ?? { type: 'string' }) as JsonSchema;
    return {
      type: 'array',
      description,
      items: toElevenLabsSchema(items, `${name} item`),
    };
  }

  return {
    type: schema.type ?? 'string',
    description,
    ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
  };
}

/** Every agent tool as an ElevenLabs client-tool config, ready to POST. */
export function clientToolConfigs(): Record<string, unknown>[] {
  return ACTION_TOOLS.map(({ function: fn }) => ({
    type: 'client',
    name: fn.name,
    description: fn.description,
    parameters: toElevenLabsSchema(fn.parameters as JsonSchema, fn.name),
    // She waits for the answer: every tool either changes something she has to
    // confirm or computes something she has to say.
    expects_response: true,
    // Phone → this server → back. Nearby and travel lookups reach a geocoder.
    response_timeout_secs: 20,
  }));
}
