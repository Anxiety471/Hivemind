import { z } from 'zod'
import { CommandHarness, DemoHarness, HarnessRegistry, OpenAICompatibleHarness } from './harnesses.js'
import { createHivemind } from './graph.js'
import { ModelRouter, RuleRouter } from './routers.js'

const harnessSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('demo') }).strict(),
  z.object({ type: z.literal('command'), command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().optional(), maxOutputBytes: z.number().int().positive().default(1_048_576) }).strict(),
  z.object({ type: z.literal('openai-compatible'), baseUrl: z.url(), model: z.string().min(1), apiKeyEnv: z.string().min(1), maxTokens: z.number().int().positive().default(2048) }).strict(),
])
export const configSchema = z.object({
  maxAttempts: z.number().int().min(1).max(100).default(3), timeoutMs: z.number().int().positive().default(120_000),
  harnesses: z.record(z.string(), harnessSchema),
  agents: z.array(z.object({ id: z.string().min(1), role: z.enum(['worker', 'reviewer', 'router']), harness: z.string().min(1), description: z.string().default('') }).strict()).min(2),
  router: z.discriminatedUnion('type', [
    z.object({ type: z.literal('rule') }).strict(),
    z.object({ type: z.literal('model'), agent: z.string().min(1) }).strict(),
  ]),
}).strict()
export function fromConfig(input: unknown) {
  const config = configSchema.parse(input)
  const harnesses = new HarnessRegistry()
  for (const [id, settings] of Object.entries(config.harnesses)) {
    harnesses.register(id, settings.type === 'demo' ? new DemoHarness() : settings.type === 'command'
      ? new CommandHarness(settings) : new OpenAICompatibleHarness(settings))
  }
  const routerConfig = config.router
  const agent = routerConfig.type === 'model' ? config.agents.find(a => a.id === routerConfig.agent) : undefined
  if (config.router.type === 'model' && agent?.role !== 'router') throw new Error('Model router must reference a router agent')
  const router = agent ? new ModelRouter(agent, harnesses) : new RuleRouter()
  return createHivemind({ agents: config.agents, harnesses, router, maxAttempts: config.maxAttempts, timeoutMs: config.timeoutMs })
}
