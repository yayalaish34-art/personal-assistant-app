// Creates the ElevenLabs agent and its tools, or brings them up to date.
//
//   npx tsx --env-file=.env scripts/elevenlabs-agent.ts
//
// Safe to re-run: the agent keeps its id, and each tool already attached to it
// is updated in place rather than created again. The first run writes the new
// agent id into .env; put the same value in ELEVENLABS_AGENT_ID on the server.
//
// What she says and knows is not set here. The app builds the system prompt
// per conversation from the phone's own data (POST /voice/agent/session) and
// hands it to the agent as an override, so the prompt below is a placeholder
// that only shows up in the ElevenLabs dashboard.

import { readFileSync, writeFileSync } from 'node:fs';

import { config } from '../src/config.js';
import { clientToolConfigs, convai } from '../src/modules/voice/elevenlabs.js';

const existingId = config.ELEVENLABS_AGENT_ID?.trim();

type ToolRow = { id: string; tool_config: { name: string } };

/** Tools already attached to this agent, by name — the only ones we may touch. */
async function attachedTools(agentId: string): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await convai<{ tools: ToolRow[]; next_cursor?: string | null; has_more?: boolean }>(
      `/tools?used_by_agent_id=${encodeURIComponent(agentId)}&page_size=100` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    );
    for (const t of page.tools) byName.set(t.tool_config.name, t.id);
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return byName;
}

const attached = existingId ? await attachedTools(existingId) : new Map<string, string>();

const toolIds: string[] = [];
for (const tool of clientToolConfigs()) {
  const name = tool.name as string;
  const id = attached.get(name);
  if (id) {
    await convai(`/tools/${id}`, { method: 'PATCH', body: { tool_config: tool } });
    toolIds.push(id);
  } else {
    const created = await convai<{ id: string }>('/tools', { method: 'POST', body: { tool_config: tool } });
    toolIds.push(created.id);
  }
  process.stdout.write(`${id ? 'updated' : 'created'} tool ${name}\n`);
}

// ===== The agent: edit here and re-run =====
const agent = {
  name: 'Personal Assistant',
  tags: ['personal-assistant'],
  platform_settings: {
    // Only a server holding the API key can open a conversation; the agent id
    // alone is not enough.
    auth: { enable_auth: true },
    // The app replaces these per conversation: the prompt carries the user's
    // agenda, and the language follows the one they chose.
    overrides: {
      conversation_config_override: {
        agent: { prompt: { prompt: true }, first_message: true, language: true },
      },
    },
  },
  conversation_config: {
    agent: {
      language: 'he',
      // Empty: she waits, and the app opens a fresh conversation with
      // "[SESSION START]", which the prompt turns into a briefing on the day.
      first_message: '',
      prompt: {
        prompt: 'Placeholder. The app sends the real system prompt with every conversation.',
        llm: config.ELEVENLABS_AGENT_LLM,
        temperature: 0.3,
        tool_ids: toolIds,
      },
    },
    tts: {
      // Hebrew needs the v4 family: multilingual_v2, flash_v2_5 and
      // turbo_v2_5 do not speak it and come out unintelligible.
      model_id: 'eleven_v4_turbo',
      voice_id: config.ELEVENLABS_VOICE_ID,
      // On, it slips tags like "[מיוחדת]" into Hebrew replies.
      expressive_mode: false,
    },
    turn: {
      // "eager" cut people off at the first pause ("אני רוצה-").
      turn_eagerness: 'normal',
      // Starts the reply before the turn is confirmed, which is most of the
      // speed people notice.
      speculative_turn: true,
      turn_timeout: 7,
    },
  },
};
// ===========================================

const result = await convai<{ agent_id?: string }>(
  existingId ? `/agents/${encodeURIComponent(existingId)}` : '/agents/create',
  { method: existingId ? 'PATCH' : 'POST', body: agent },
);
const agentId = existingId || result.agent_id!;

if (!existingId) {
  const env = readFileSync('.env', 'utf8');
  const updated = /^ELEVENLABS_AGENT_ID=.*$/m.test(env)
    ? env.replace(/^ELEVENLABS_AGENT_ID=.*$/m, `ELEVENLABS_AGENT_ID=${agentId}`)
    : `${env.trimEnd()}\nELEVENLABS_AGENT_ID=${agentId}\n`;
  writeFileSync('.env', updated);
}

console.log(`${existingId ? 'Agent updated' : 'Agent created'}: ${agentId} (${toolIds.length} tools)`);
console.log(`In ElevenLabs: https://elevenlabs.io/app/agents/agents/${agentId}`);
