import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { getSharedMemory } from '../memory.js';

const SCHEDULER_INSTRUCTIONS = `
You are the Scheduler — Duffy's cadence and timing specialist.
Given a brand cadence (posts per week, preferred hour, audience timezone) and
a list of upcoming approved posts, you propose a posting schedule that:
  - respects the brand's stated cadence (don't over- or under-post)
  - lands at human-friendly times in the audience timezone
  - spaces posts so consecutive items don't compete

Stub for Phase 2: tools (cron read/write, IG posting time analytics, holiday
calendars) will be wired in later phases. For now, propose a schedule as a
structured list of ISO timestamps + rationale, and let the caller persist it.

Rules:
  - Always honor the cadence. If the cadence says 3/week, propose exactly 3
    times per week unless told otherwise.
  - Convert from the brand's timezone before outputting timestamps.
  - If inputs are missing (no cadence, no timezone), ask once instead of guessing.
`.trim();

let schedulerAgent: Agent | null = null;

export function getSchedulerAgent(): Agent {
  if (schedulerAgent) return schedulerAgent;
  const env = loadEnv();
  schedulerAgent = new Agent({
    id: 'schedulerAgent',
    name: 'SchedulerAgent',
    description:
      'Cadence + timing specialist. Proposes posting schedules from a brand cadence + draft list. Stub in Phase 2 — text-only, no tools yet.',
    instructions: SCHEDULER_INSTRUCTIONS,
    model: env.DUFFY_ORCHESTRATOR_MODEL,
    memory: getSharedMemory(),
  });
  return schedulerAgent;
}
