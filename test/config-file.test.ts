import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { z } from 'zod'
import { configSchema } from '../src/config.js'
import {
  addAgent, assertRunnable, formatFor, loadConfig, parseConfigText, parseTomlText, removeAgent, removeHarness,
  saveConfig, serializeConfig, serializeToml, withAgentHarness, withHarnessPatch, withLimits, withRouter,
} from '../src/config-file.js'

type Config = z.infer<typeof configSchema>

const full: Config = configSchema.parse({
  maxAttempts: 5,
  timeoutMs: 30_000,
  harnesses: {
    demo: { type: 'demo' },
    native: { type: 'opencode', executable: 'opencode', executableArgs: ['--flag', 'value'], cwd: '/tmp/work', model: 'gpt-x', agent: 'build' },
    pi: { type: 'pi', executable: 'pi', executableArgs: [], model: 'sonnet', provider: 'anthropic', thinking: 'high', tools: ['Read', 'Write'], maxOutputBytes: 1024 },
    cli: { type: 'command', command: 'node', args: ['worker.ts'], cwd: '/tmp/cli' },
    remote: { type: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY', maxTokens: 4096 },
  },
  agents: [
    { id: 'writer', role: 'worker', harness: 'native', description: 'Drafts' },
    { id: 'checker', role: 'reviewer', harness: 'remote', description: 'Reviews' },
    { id: 'router-agent', role: 'router', harness: 'pi', description: 'Routes' },
  ],
  router: { type: 'model', agent: 'router-agent' },
})

const minimal: Config = configSchema.parse({
  harnesses: { demo: { type: 'demo' }, cli: { type: 'command', command: 'node' } },
  agents: [
    { id: 'writer', role: 'worker', harness: 'demo' },
    { id: 'checker', role: 'reviewer', harness: 'demo' },
  ],
  router: { type: 'rule' },
})

const draft = (agents: Config['agents']): Config => ({ ...structuredClone(minimal), agents })

test('formatFor selects toml only for the .toml extension', () => {
  assert.equal(formatFor('hivemind.toml'), 'toml')
  assert.equal(formatFor('config.TOML'), 'toml')
  assert.equal(formatFor('hivemind.json'), 'json')
  assert.equal(formatFor('hivemind'), 'json')
})

test('TOML round-trip preserves a config with every harness variant', () => {
  const text = serializeConfig(full, 'toml')
  assert.match(text, /max_attempts = 5/)
  assert.match(text, /timeout_ms = 30000/)
  assert.match(text, /\[\[agents\]\]/)
  assert.match(text, /\[harnesses\.remote\]/)
  for (const key of ['max_attempts', 'timeout_ms', 'base_url', 'api_key_env', 'max_tokens', 'executable_args', 'max_output_bytes']) {
    assert.ok(text.includes(key), `expected emitted TOML to contain ${key}`)
  }
  assert.deepEqual(parseConfigText(text, 'toml'), full)
  assert.deepEqual(parseConfigText(serializeConfig(full, 'toml'), 'toml'), full)
})

test('TOML key transform is exactly reversible for every current key', () => {
  const pairs: [string, string][] = [
    ['maxAttempts', 'max_attempts'], ['timeoutMs', 'timeout_ms'], ['baseUrl', 'base_url'],
    ['apiKeyEnv', 'api_key_env'], ['maxTokens', 'max_tokens'], ['executableArgs', 'executable_args'],
    ['maxOutputBytes', 'max_output_bytes'],
  ]
  const text = serializeToml(full)
  for (const [camel, snake] of pairs) {
    assert.ok(text.includes(snake), `expected ${snake} in TOML`)
    assert.ok(!text.includes(camel), `expected no camelCase ${camel} in TOML`)
  }
  assert.deepEqual(parseTomlText(text), full)
  assert.deepEqual(parseConfigText(serializeConfig(minimal, 'toml'), 'toml'), minimal)
})

test('JSON round-trip keeps camelCase keys', () => {
  const text = serializeConfig(full, 'json')
  assert.ok(text.includes('"maxAttempts"') && text.includes('"executableArgs"'))
  assert.deepEqual(parseConfigText(text, 'json'), full)
})

test('personas is accepted as an alias for agents', () => {
  const text = [
    'max_attempts = 2',
    '[[personas]]', 'id = "writer"', 'role = "worker"', 'harness = "demo"', 'description = "Drafts"',
    '[[personas]]', 'id = "checker"', 'role = "reviewer"', 'harness = "demo"', 'description = "Checks"',
    '[harnesses.demo]', 'type = "demo"',
    '[router]', 'type = "rule"',
  ].join('\n')
  const parsed = parseTomlText(text)
  assert.deepEqual(parsed.agents.map(agent => agent.id), ['writer', 'checker'])
  assert.deepEqual(parsed.agents.map(agent => agent.role), ['worker', 'reviewer'])
  assert.equal(parsed.maxAttempts, 2)
})

test('serialized TOML always uses the agents key, never personas', () => {
  assert.ok(!serializeToml(minimal).includes('personas'))
})

test('parseConfigText reports invalid JSON and invalid TOML as Errors', () => {
  assert.throws(() => parseConfigText('{ not json', 'json'), (error: unknown) => error instanceof Error && /JSON/i.test(error.message))
  assert.throws(() => parseConfigText('max_attempts = ', 'toml'), (error: unknown) => error instanceof Error && /TOML/i.test(error.message))
  assert.throws(() => parseConfigText('{"agents": []}', 'json'))
})

test('withRouter and withLimits return new validated configs', () => {
  const original = structuredClone(minimal)
  const rerouted = withRouter(minimal, { type: 'model', agent: 'checker' })
  assert.notEqual(rerouted, minimal)
  assert.deepEqual(minimal.router, { type: 'rule' })
  assert.deepEqual(rerouted.router, { type: 'model', agent: 'checker' })
  const limited = withLimits(minimal, { maxAttempts: 7, timeoutMs: 250 })
  assert.notEqual(limited, minimal)
  assert.deepEqual([limited.maxAttempts, limited.timeoutMs], [7, 250])
  assert.deepEqual(minimal, original)
  assert.throws(() => withLimits(minimal, { maxAttempts: 101 }))
  assert.throws(() => withLimits(minimal, { maxAttempts: 0 }))
  assert.throws(() => withLimits(minimal, { timeoutMs: 0 }))
  assert.deepEqual(withLimits(minimal, {}), minimal)
})

test('withAgentHarness rewires without mutating and rejects unknown ids', () => {
  const rewired = withAgentHarness(minimal, 'writer', 'cli')
  assert.notEqual(rewired, minimal)
  assert.equal(rewired.agents[0]!.harness, 'cli')
  assert.equal(minimal.agents[0]!.harness, 'demo')
  assert.throws(() => withAgentHarness(minimal, 'ghost', 'cli'), /Unknown agent "ghost"/)
  assert.throws(() => withAgentHarness(minimal, 'writer', 'ghost'), /Unknown harness "ghost"/)
})

test('withHarnessPatch merges a patch and rejects unknown harness ids', () => {
  const patched = withHarnessPatch(minimal, 'cli', { args: ['run.ts'], maxOutputBytes: 2048 })
  assert.notEqual(patched, minimal)
  assert.deepEqual(patched.harnesses.cli, { type: 'command', command: 'node', args: ['run.ts'], maxOutputBytes: 2048 })
  assert.deepEqual(minimal.harnesses.cli, { type: 'command', command: 'node', args: [], maxOutputBytes: 1_048_576 })
  assert.throws(() => withHarnessPatch(minimal, 'ghost', {}), /Unknown harness "ghost"/)
  assert.throws(() => withHarnessPatch(minimal, 'cli', { command: '' }))
})

test('removeHarness rejects referenced harnesses and removes unreferenced ones', () => {
  assert.throws(() => removeHarness(full, 'pi'), /still referenced by agent\(s\) router-agent/)
  const pruned = removeHarness(full, 'demo')
  assert.notEqual(pruned, full)
  assert.ok(!Object.hasOwn(pruned.harnesses, 'demo'))
  assert.ok(Object.hasOwn(full.harnesses, 'demo'))
  assert.throws(() => removeHarness(full, 'ghost'), /Unknown harness "ghost"/)
})

test('addAgent rejects duplicate ids and removeAgent protects the last worker', () => {
  const added = addAgent(minimal, { id: 'router', role: 'router', harness: 'demo' })
  assert.equal(added.agents.at(-1)!.description, '')
  assert.equal(added.agents.length, 3)
  assert.equal(minimal.agents.length, 2)
  assert.throws(() => addAgent(minimal, { id: 'writer', role: 'worker', harness: 'demo' }), /already exists/)
  assert.throws(() => removeAgent(minimal, 'writer'), /at least one worker/)
  assert.throws(() => removeAgent(minimal, 'ghost'), /Unknown agent "ghost"/)
  assert.deepEqual(removeAgent(full, 'router-agent').agents.map(agent => agent.id), ['writer', 'checker'])
})

test('assertRunnable accepts runnable configs and rejects every broken shape', () => {
  assert.doesNotThrow(() => assertRunnable(full))
  assert.doesNotThrow(() => assertRunnable(minimal))
  const worker = minimal.agents[0]!
  const reviewer = minimal.agents[1]!
  assert.throws(() => assertRunnable(draft([worker, { ...worker, id: 'worker-2' }])), /exactly one reviewer/)
  assert.throws(() => assertRunnable(draft([worker, reviewer, { ...reviewer, id: 'checker-2' }])), /exactly one reviewer/)
  assert.throws(() => assertRunnable(draft([reviewer, { id: 'router', role: 'router', harness: 'demo', description: '' }])), /at least one worker/)
  assert.throws(() => assertRunnable(draft([worker, { ...reviewer, harness: 'ghost' }])), /unknown harness "ghost"/)
  assert.throws(() => assertRunnable({ ...structuredClone(minimal), maxAttempts: 0 }), /maxAttempts/)
  assert.throws(() => assertRunnable({ ...structuredClone(minimal), maxAttempts: 101 }), /maxAttempts/)
  assert.throws(() => assertRunnable({ ...structuredClone(minimal), timeoutMs: 0 }), /timeoutMs/)
})

test('saveConfig/loadConfig round-trip atomically in both formats', async (t) => {
  for (const [file, config] of [['hivemind.toml', full], ['hivemind.json', minimal]] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'hivemind-config-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, file)
    await saveConfig(path, config)
    assert.deepEqual(await readdir(dir), [file])
    assert.deepEqual(await loadConfig(path), config)
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes(file.endsWith('.toml') ? 'max_attempts' : '"maxAttempts"'))
  }
})

test('saveConfig creates missing nested directories and leaves no temp files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hivemind-atomic-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const nested = join(dir, 'deep', 'nested', 'hivemind.toml')
  await saveConfig(nested, minimal)
  assert.deepEqual(await loadConfig(nested), minimal)
  assert.deepEqual(await readdir(join(dir, 'deep', 'nested')), ['hivemind.toml'])
  await saveConfig(nested, full)
  assert.deepEqual(await loadConfig(nested), full)
  assert.deepEqual(await readdir(join(dir, 'deep', 'nested')), ['hivemind.toml'])
})

test('failed saves leave the directory clean and loadConfig reports missing files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hivemind-failure-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'blocker.txt'), 'not a directory')
  await assert.rejects(() => saveConfig(join(dir, 'blocker.txt', 'nested.json'), minimal))
  assert.deepEqual(await readdir(dir), ['blocker.txt'])
  await assert.rejects(() => loadConfig(join(dir, 'missing.toml')), (error: unknown) => error instanceof Error && error.message.includes('missing.toml'))
})

test('loadConfig surfaces invalid file contents with the file path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hivemind-parse-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const toml = join(dir, 'broken.toml')
  await writeFile(toml, 'max_attempts = \n')
  await assert.rejects(() => loadConfig(toml), (error: unknown) => error instanceof Error && error.message.includes(toml) && /TOML/i.test(error.message))
  const json = join(dir, 'broken.json')
  await writeFile(json, '{ oops')
  await assert.rejects(() => loadConfig(json), (error: unknown) => error instanceof Error && error.message.includes(json) && /JSON/i.test(error.message))
})
