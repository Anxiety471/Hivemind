import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { OpenCodeHarness, PiHarness, parseOpenCodeOutput, parsePiOutput } from '../src/native-harnesses.js'
import { fromConfig, configSchema } from '../src/config.js'
import type { HarnessRequest } from '../src/types.js'
const fixture = resolve('test/fixtures/native-cli.ts')
const request: HarnessRequest = { agent: { id: 'native', role: 'worker', harness: 'native', description: '' }, task: 'literal $(whoami) and `pwd`', instructions: 'Complete the task', artifact: 'old draft', feedback: 'Revise this', attempt: 1 }
async function fixtureOptions(kind: string, scenario = 'work') {
  const directory = await mkdtemp(join(tmpdir(), 'hivemind-native-'))
  const capture = join(directory, 'capture.json')
  return { directory, capture, options: { executable: process.execPath, executableArgs: ['--import', 'tsx', fixture, kind, capture, scenario], cwd: process.cwd() } }
}
test('OpenCode native invocation sends context on stdin, sets flags, and returns final text only', async () => {
  const f = await fixtureOptions('opencode')
  try {
    const text = await new OpenCodeHarness({ ...f.options, model: 'provider/model', agent: 'build', variant: 'high' }).run(request, new AbortController().signal)
    assert.equal(text, 'Final native artifact')
    const captured = JSON.parse(await readFile(f.capture, 'utf8'))
    assert.deepEqual(captured.args, ['run', '--format', 'json', '--model', 'provider/model', '--agent', 'build', '--variant', 'high'])
    assert.ok(captured.stdin.includes(request.task))
    assert.ok(captured.stdin.includes(request.artifact))
    assert.ok(captured.stdin.includes(request.feedback))
    assert.equal(captured.cwd, process.cwd())
  } finally { await rm(f.directory, { recursive: true }) }
})
test('Pi native invocation selects provider/model/tools and uses an ephemeral JSON session', async () => {
  const f = await fixtureOptions('pi')
  try {
    assert.equal(await new PiHarness({ ...f.options, provider: 'anthropic', model: 'configured-model', thinking: 'high', tools: ['read', 'grep'] }).run(request, new AbortController().signal), 'Final native artifact')
    const captured = JSON.parse(await readFile(f.capture, 'utf8'))
    assert.deepEqual(captured.args, ['--print', '--mode', 'json', '--no-session', '--provider', 'anthropic', '--model', 'configured-model', '--thinking', 'high', '--tools', 'read,grep'])
    assert.ok(captured.stdin.includes(request.instructions))
    assert.ok(captured.stdin.includes(request.task))
  } finally { await rm(f.directory, { recursive: true }) }
})
test('native adapters detect terminal errors, truncation, and failed subprocesses', async () => {
  for (const kind of ['opencode', 'pi']) for (const scenario of ['error', 'truncated', 'exit']) {
    const f = await fixtureOptions(kind, scenario)
    try {
      const adapter = kind === 'opencode' ? new OpenCodeHarness(f.options) : new PiHarness(f.options)
      await assert.rejects(adapter.run(request, new AbortController().signal))
    } finally { await rm(f.directory, { recursive: true }) }
  }
})
test('native parsers reject malformed and incomplete output, preserving reviewer JSON', () => {
  assert.throws(() => parseOpenCodeOutput('not JSON'))
  assert.throws(() => parsePiOutput('{"type":"agent_start"}'))
  assert.throws(() => parseOpenCodeOutput('{"type":"step_finish","part":{"messageID":"one","reason":"stop"}}'))
  const t = (id: string, m: string, text: string) => JSON.stringify({ type: 'text', part: { type: 'text', id, messageID: m, text } })
  const f = (m: string, reason: string) => JSON.stringify({ type: 'step_finish', part: { messageID: m, reason } })
  assert.equal(parseOpenCodeOutput(['{"type":"step_start","part":{}}', t('a', 'm1', 'hi')].join('\n')), 'hi')
  assert.equal(parseOpenCodeOutput([t('a', 'm1', 'run'), f('m1', 'tool-calls'), t('b', 'm2', 'done')].join('\n')), 'done')
  assert.throws(() => parseOpenCodeOutput([t('a', 'm1', 'run'), f('m1', 'tool-calls')].join('\n')), /tool-calls/)
  const review = JSON.stringify({ verdict: 'approved', feedback: 'Ready' })
  const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: review }] }
  assert.equal(parsePiOutput(JSON.stringify({ type: 'agent_end', messages: [message] })), review)
})
test('configuration runs an OpenCode worker and Pi reviewer through a complete revision loop', async () => {
  const w = await fixtureOptions('opencode')
  const r = await fixtureOptions('pi', 'review')
  try {
    const runtime = fromConfig({ maxAttempts: 2, harnesses: { worker: { type: 'opencode', ...w.options }, reviewer: { type: 'pi', ...r.options, tools: [] } },
      agents: [{ id: 'worker', role: 'worker', harness: 'worker' }, { id: 'reviewer', role: 'reviewer', harness: 'reviewer' }], router: { type: 'rule' } })
    const result = await runtime.run('Write something')
    assert.equal(result.status, 'completed')
    assert.equal(result.attempts, 2)
    assert.equal(result.artifact, 'Final native artifact')
    const captured = JSON.parse(await readFile(r.capture, 'utf8'))
    assert.ok(captured.args.includes('--no-tools'))
  } finally { await rm(w.directory, { recursive: true }); await rm(r.directory, { recursive: true }) }
})
test('native configuration accepts defaults and rejects unsupported settings', () => {
  const input = { harnesses: { worker: { type: 'opencode' }, reviewer: { type: 'pi' } }, agents: [{ id: 'worker', role: 'worker', harness: 'worker' }, { id: 'reviewer', role: 'reviewer', harness: 'reviewer' }], router: { type: 'rule' } }
  assert.doesNotThrow(() => fromConfig(input))
  assert.throws(() => configSchema.parse({ ...input, harnesses: { reviewer: { type: 'pi', thinking: 'wrong' } } }))
})
test('current Pi waits for settled completion and allows successful retry recovery', () => {
  const message = (stopReason: string, text = 'Recovered artifact') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }] })
  const end = { type: 'agent_end', messages: [message('stop')], willRetry: false }
  assert.throws(() => parsePiOutput(JSON.stringify(end)), /did not finish/)
  assert.throws(() => parsePiOutput([end, { type: 'agent_settled', aborted: true }].map(e => JSON.stringify(e)).join('\n')), /aborted/)
  const records = [
    { type: 'agent_end', messages: [message('error')], willRetry: true },
    { type: 'agent_start' }, end, { type: 'agent_settled', aborted: false },
  ]
  assert.equal(parsePiOutput(records.map(e => JSON.stringify(e)).join('\n')), 'Recovered artifact')
})
