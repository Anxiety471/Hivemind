import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse, stringify, type TomlTable } from 'smol-toml'
import type { z } from 'zod'
import { configSchema } from './config.js'
import type { Role } from './types.js'

export type Config = z.infer<typeof configSchema>

export type ConfigFormat = 'json' | 'toml'

const camelToSnake = (key: string) => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
const snakeToCamel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

function mapKeys(value: unknown, transform: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map(item => mapKeys(item, transform))
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[transform(key)] = mapKeys(item, transform)
  return result
}

export function formatFor(path: string): ConfigFormat {
  return path.toLowerCase().endsWith('.toml') ? 'toml' : 'json'
}

export function parseTomlText(text: string): Config {
  const parsed = mapKeys(parse(text), snakeToCamel) as Record<string, unknown>
  if (!Object.hasOwn(parsed, 'personas')) return configSchema.parse(parsed)
  const { personas, ...rest } = parsed
  if (!Object.hasOwn(rest, 'agents')) rest.agents = personas
  return configSchema.parse(rest)
}

export function serializeToml(config: Config): string {
  return stringify(mapKeys(config, camelToSnake) as TomlTable)
}

export function parseConfigText(text: string, format: ConfigFormat): Config {
  if (format === 'toml') return parseTomlText(text)
  let value: unknown
  try { value = JSON.parse(text) } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return configSchema.parse(value)
}

export function serializeConfig(config: Config, format: ConfigFormat): string {
  return format === 'toml' ? serializeToml(config) : `${JSON.stringify(config, null, 2)}\n`
}

export function assertRunnable(config: Config): void {
  const reviewers = config.agents.filter(agent => agent.role === 'reviewer').length
  if (reviewers !== 1) throw new Error(`Config must have exactly one reviewer agent, found ${reviewers}`)
  for (const role of ['orchestrator', 'security-reviewer'] as const) {
    if (config.agents.filter(agent => agent.role === role).length > 1) throw new Error(`Config must have at most one ${role} agent`)
  }
  if (!config.agents.some(agent => agent.role === 'worker')) throw new Error('Config must have at least one worker agent')
  for (const agent of config.agents) {
    if (!Object.hasOwn(config.harnesses, agent.harness)) throw new Error(`Agent "${agent.id}" references unknown harness "${agent.harness}"`)
  }
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 100) {
    throw new Error(`maxAttempts must be an integer between 1 and 100, found ${config.maxAttempts}`)
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) throw new Error(`timeoutMs must be a positive integer, found ${config.timeoutMs}`)
  if (!Number.isInteger(config.harnessRetries) || config.harnessRetries < 0 || config.harnessRetries > 10) {
    throw new Error(`harnessRetries must be an integer between 0 and 10, found ${config.harnessRetries}`)
  }
}

function replace(config: Config, patch: Partial<Config>): Config {
  return configSchema.parse({ ...structuredClone(config), ...patch })
}

export function withRouter(config: Config, router: Config['router']): Config {
  return replace(config, { router })
}

export function withLimits(config: Config, patch: { maxAttempts?: number; timeoutMs?: number; harnessRetries?: number }): Config {
  const limits: Partial<Config> = {}
  if (patch.maxAttempts !== undefined) limits.maxAttempts = patch.maxAttempts
  if (patch.timeoutMs !== undefined) limits.timeoutMs = patch.timeoutMs
  if (patch.harnessRetries !== undefined) limits.harnessRetries = patch.harnessRetries
  return replace(config, limits)
}

export function withAgentHarness(config: Config, agentId: string, harnessId: string): Config {
  const index = config.agents.findIndex(agent => agent.id === agentId)
  if (index === -1) throw new Error(`Unknown agent "${agentId}"`)
  if (!Object.hasOwn(config.harnesses, harnessId)) throw new Error(`Unknown harness "${harnessId}"`)
  const agents = structuredClone(config.agents)
  agents[index] = { ...agents[index]!, harness: harnessId }
  return replace(config, { agents })
}

export function withHarnessPatch(config: Config, harnessId: string, patch: Record<string, unknown>): Config {
  if (!Object.hasOwn(config.harnesses, harnessId)) throw new Error(`Unknown harness "${harnessId}"`)
  const harnesses = structuredClone(config.harnesses)
  harnesses[harnessId] = { ...harnesses[harnessId], ...patch } as Config['harnesses'][string]
  return replace(config, { harnesses })
}

export function addAgent(config: Config, agent: { id: string; role: Role; harness: string; description?: string; model?: string }): Config {
  if (config.agents.some(existing => existing.id === agent.id)) throw new Error(`Agent "${agent.id}" already exists`)
  return replace(config, { agents: [...structuredClone(config.agents), { description: '', ...agent }] })
}

export function addHarness(config: Config, harnessId: string, settings: Config['harnesses'][string]): Config {
  if (Object.hasOwn(config.harnesses, harnessId)) throw new Error(`Harness "${harnessId}" already exists`)
  return replace(config, { harnesses: { ...structuredClone(config.harnesses), [harnessId]: settings } })
}

// Replace an agent in place; a changed id also moves a model router that pointed at the old id.
export function updateAgent(config: Config, agentId: string, agent: Config['agents'][number]): Config {
  const index = config.agents.findIndex(existing => existing.id === agentId)
  if (index === -1) throw new Error(`Unknown agent "${agentId}"`)
  if (agent.id !== agentId && config.agents.some(existing => existing.id === agent.id)) throw new Error(`Agent "${agent.id}" already exists`)
  if (!Object.hasOwn(config.harnesses, agent.harness)) throw new Error(`Unknown harness "${agent.harness}"`)
  const agents = structuredClone(config.agents)
  agents[index] = agent
  const router = config.router.type === 'model' && config.router.agent === agentId ? { type: 'model' as const, agent: agent.id } : config.router
  return replace(config, { agents, router })
}

// Replace a harness registration; a changed id is carried over to every agent that used the old id.
export function updateHarness(config: Config, harnessId: string, nextId: string, settings: Config['harnesses'][string]): Config {
  if (!Object.hasOwn(config.harnesses, harnessId)) throw new Error(`Unknown harness "${harnessId}"`)
  if (nextId !== harnessId && Object.hasOwn(config.harnesses, nextId)) throw new Error(`Harness "${nextId}" already exists`)
  const harnesses = Object.fromEntries(Object.entries(config.harnesses)
    .map(([id, existing]) => id === harnessId ? [nextId, settings] : [id, existing]))
  const agents = config.agents.map(agent => agent.harness === harnessId ? { ...agent, harness: nextId } : agent)
  return replace(config, { harnesses, agents })
}

export function removeAgent(config: Config, agentId: string): Config {
  const agents = config.agents.filter(agent => agent.id !== agentId)
  if (agents.length === config.agents.length) throw new Error(`Unknown agent "${agentId}"`)
  if (!agents.some(agent => agent.role === 'worker')) throw new Error(`Cannot remove "${agentId}": config must keep at least one worker agent`)
  return replace(config, { agents })
}

export function removeHarness(config: Config, harnessId: string): Config {
  if (!Object.hasOwn(config.harnesses, harnessId)) throw new Error(`Unknown harness "${harnessId}"`)
  const users = config.agents.filter(agent => agent.harness === harnessId).map(agent => agent.id)
  if (users.length) throw new Error(`Cannot remove harness "${harnessId}": still referenced by agent(s) ${users.join(', ')}`)
  const harnesses = structuredClone(config.harnesses)
  delete harnesses[harnessId]
  return replace(config, { harnesses })
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    throw new Error(`Unable to read config file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try { return parseConfigText(text, formatFor(path)) } catch (error) {
    throw new Error(`Unable to parse config file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  const text = serializeConfig(config, formatFor(path))
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
