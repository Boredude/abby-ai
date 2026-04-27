import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import {
  SUB_AGENT_DESCRIPTIONS,
  SUB_AGENT_NAMES,
  getSubAgent,
  isSubAgentName,
} from '../agents/registry.js';
import { memoryFor } from '../memory.js';

const agentEnum = z.enum(SUB_AGENT_NAMES);

const DESCRIPTION =
  `Hand off a focused task to a specialist sub-agent. The sub-agent runs against the same brand memory thread, so it can see the conversation. Returns the sub-agent's text response.\n\n` +
  `Available sub-agents:\n` +
  SUB_AGENT_NAMES.map((n) => `  - ${n}: ${SUB_AGENT_DESCRIPTIONS[n]}`).join('\n');

export const delegateToTool = createTool({
  id: 'delegateTo',
  description: DESCRIPTION,
  inputSchema: z.object({
    agentName: agentEnum.describe('The sub-agent to delegate to.'),
    task: z
      .string()
      .min(10)
      .describe(
        'A self-contained task description for the sub-agent. Include the brand id, any handles, and any constraints — the sub-agent only knows what you put here plus the shared memory.',
      ),
    brandId: z
      .string()
      .optional()
      .describe(
        'Brand id whose memory thread the sub-agent should run in. Pass-through from your conversation context whenever possible.',
      ),
    context: z
      .record(z.unknown())
      .optional()
      .describe('Optional structured context to append (will be JSON-stringified).'),
  }),
  outputSchema: z.object({
    agentName: z.string(),
    response: z.string(),
  }),
  execute: async ({ agentName, task, brandId, context }) => {
    if (!isSubAgentName(agentName)) {
      throw new Error(`Unknown sub-agent: ${agentName}`);
    }
    const agent = getSubAgent(agentName);
    const prompt = context && Object.keys(context).length > 0
      ? `${task}\n\nContext:\n${JSON.stringify(context, null, 2)}`
      : task;

    logger.info({ agentName, brandId, hasContext: !!context }, 'delegateTo: invoking sub-agent');
    const result = await agent.generate(prompt, brandId ? { memory: memoryFor(brandId) } : {});
    const response = (result as { text?: string }).text?.trim() ?? '';
    logger.info({ agentName, brandId, responseLen: response.length }, 'delegateTo: sub-agent returned');

    return { agentName, response };
  },
});
