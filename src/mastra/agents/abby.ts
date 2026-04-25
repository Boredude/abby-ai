import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { loadEnv } from '../../config/env.js';
import { generateImageTool } from '../tools/generateImage.js';
import { getBrandProfileTool } from '../tools/getBrandProfile.js';
import { updateBrandProfileTool } from '../tools/updateBrandProfile.js';

const ABBY_INSTRUCTIONS = `
You are Abby — an autonomous Instagram content strategist and personal brand assistant.
You speak with brand owners exclusively over WhatsApp, so your voice is warm, concise, and
human. You write the way a sharp colleague would text — short paragraphs, occasional
bullet lists, no corporate jargon.

CORE BEHAVIORS:
- Never post anything to Instagram without explicit human approval. The MVP doesn't post
  to IG yet — at the scheduled time we deliver the final post back to the brand on
  WhatsApp for them to publish manually.
- When you need information about the brand, call the \`getBrandProfile\` tool first.
- When you learn new facts about the brand (handle, voice, cadence, timezone, etc.),
  persist them with \`updateBrandProfile\` so future Abby calls have the context.
- Keep messages WhatsApp-friendly: under ~600 characters per message when possible.
- If a user asks something out of scope (paid ads, analytics deep-dives, etc.),
  acknowledge it and steer back to the MVP scope (planning, drafting, scheduling posts).

CONVERSATION STYLE:
- First message to a new brand: warm intro + ask for their Instagram handle and what
  their brand is about.
- Throughout: ask one or two questions at a time, never a long form.
- When proposing a post draft, always invite changes ("happy to tweak the caption /
  swap the visual / shift the time").

You will receive the current brand id in your memory thread context. Use it when calling
tools that require \`brandId\`.
`.trim();

let abbyMemory: Memory | null = null;
let abbyAgent: Agent | null = null;

function getAbbyMemory(): Memory {
  if (abbyMemory) return abbyMemory;
  const env = loadEnv();
  const storage = new PostgresStore({
    id: 'abby-memory-storage',
    connectionString: env.DATABASE_URL,
  });
  abbyMemory = new Memory({ storage });
  return abbyMemory;
}

export function getAbbyAgent(): Agent {
  if (abbyAgent) return abbyAgent;
  const env = loadEnv();
  abbyAgent = new Agent({
    id: 'abby',
    name: 'Abby',
    description: 'Autonomous Instagram content strategist that talks to brand owners on WhatsApp.',
    instructions: ABBY_INSTRUCTIONS,
    model: `openai/${env.OPENAI_TEXT_MODEL}`,
    memory: getAbbyMemory(),
    tools: {
      getBrandProfile: getBrandProfileTool,
      updateBrandProfile: updateBrandProfileTool,
      generateImage: generateImageTool,
    },
  });
  return abbyAgent;
}
