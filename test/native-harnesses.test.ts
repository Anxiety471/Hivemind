import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { OpenCodeHarness, PiHarness, parseOpenCodeOutput, parsePiOutput } from '../src/native-harnesses.js'
import { runProcess } from '../src/harnesses.js'
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
    assert.deepEqual(captured.args, ['run', '--standalone', '--format', 'json', '--model', 'provider/model', '--agent', 'build', '--variant', 'high'])
    assert.ok(captured.stdin.includes(request.task))
    assert.ok(captured.stdin.includes(request.artifact))
    assert.ok(captured.stdin.includes(request.feedback))
    assert.equal(captured.cwd, process.cwd())
  } finally { await rm(f.directory, { recursive: true }) }
})
test('OpenCode standalone initialization prevents provider forms in fresh and already managed projects', async () => {
  const savedContent = process.env.OPENCODE_CONFIG_CONTENT
  const savedFile = process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_CONTENT
  delete process.env.OPENCODE_CONFIG
  try {
    for (const managed of [false, true]) {
      const f = await fixtureOptions('opencode', 'websearch')
      try {
        if (managed) await writeFile(`${f.capture}.managed`, '{}')
        // Negative control reproduces the actual cancellation/exit-1 behavior:
        // final text is emitted, but an unconfigured server asks a provider form.
        await assert.rejects(runProcess({ command: f.options.executable,
          args: [...f.options.executableArgs, 'run', '--format', 'json'], cwd: f.options.cwd },
        'Context\n{"attempt":1}', new AbortController().signal), (error: Error) => {
          assert.match(error.message, /Harness process exited with code 1/)
          assert.match(error.message, /Web search cancelled/)
          assert.doesNotMatch(error.message, /Final native artifact/)
          return true
        })
        assert.equal(await new OpenCodeHarness(f.options).run(request, new AbortController().signal), 'Final native artifact')
        const initialized = JSON.parse(await readFile(`${f.capture}.initialized`, 'utf8'))
        assert.deepEqual(initialized.websearch, { provider: 'random' })
        assert.equal(process.env.OPENCODE_CONFIG_CONTENT, undefined)
        assert.equal(process.env.OPENCODE_CONFIG, undefined)
        if (managed) assert.equal(await readFile(`${f.capture}.managed`, 'utf8'), '{}')
      } finally { await rm(f.directory, { recursive: true }) }
    }
  } finally {
    if (savedContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = savedContent
    if (savedFile === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = savedFile
  }
})

test('OpenCode retains inherited settings and explicit inline, file, and discovered websearch choices', async () => {
  const savedContent = process.env.OPENCODE_CONFIG_CONTENT
  const savedFile = process.env.OPENCODE_CONFIG
  try {
    for (const choice of ['default', 'inline-off', 'inline-provider', 'source-off', 'source-provider', 'explicit-file']) {
      const f = await fixtureOptions('opencode', 'websearch')
      const unrelated = { permissions: [{ action: 'edit', resource: '*', effect: 'deny' }], model: 'provider/model' }
      const inline = choice === 'inline-off' ? { websearch: false } : choice === 'inline-provider' ? { websearch: { provider: 'exa' } } : {}
      const content = JSON.stringify({ ...unrelated, ...inline })
      process.env.OPENCODE_CONFIG_CONTENT = content
      delete process.env.OPENCODE_CONFIG
      try {
        const fileChoice = choice === 'source-off' ? false : { provider: 'tavily' }
        if (choice.startsWith('source-')) {
          await writeFile(`${f.capture}.sources`, JSON.stringify([{ type: 'document', path: '/fixture/opencode.jsonc', info: { websearch: fileChoice } }]))
        }
        if (choice === 'explicit-file') {
          process.env.OPENCODE_CONFIG = join(f.directory, 'opencode.jsonc')
          await writeFile(process.env.OPENCODE_CONFIG, '{"websearch":false}')
        }
        assert.equal(await new OpenCodeHarness(f.options).run(request, new AbortController().signal), 'Final native artifact')
        const initialized = JSON.parse(await readFile(`${f.capture}.initialized`, 'utf8'))
        assert.deepEqual(initialized.permissions, unrelated.permissions)
        assert.equal(initialized.model, unrelated.model)
        const expected = choice === 'default' ? { provider: 'random' } : choice === 'inline-provider' ? inline.websearch : choice === 'source-provider' ? fileChoice : false
        assert.deepEqual(initialized.websearch, expected)
        assert.equal(process.env.OPENCODE_CONFIG_CONTENT, content)
        if (choice === 'explicit-file') {
          assert.equal(await readFile(process.env.OPENCODE_CONFIG!, 'utf8'), '{"websearch":false}')
        }
      } finally { await rm(f.directory, { recursive: true }) }
    }
  } finally {
    if (savedContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = savedContent
    if (savedFile === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = savedFile
  }
})

test('OpenCode malformed inherited inline configuration is a visible failure, never replaced by defaults', async () => {
  const saved = process.env.OPENCODE_CONFIG_CONTENT
  const f = await fixtureOptions('opencode', 'websearch')
  const content = '{"permission":'
  process.env.OPENCODE_CONFIG_CONTENT = content
  try {
    await assert.rejects(new OpenCodeHarness(f.options).run(request, new AbortController().signal),
      /OpenCode rejected inherited OPENCODE_CONFIG_CONTENT/)
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, content)
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = saved
    await rm(f.directory, { recursive: true })
  }
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
test('native subprocess failures preserve stderr first and stdout error events otherwise', async () => {
  for (const kind of ['opencode', 'pi']) for (const scenario of ['stderr-exit', 'stdout-exit', 'error']) {
    const f = await fixtureOptions(kind, scenario)
    try {
      const adapter = kind === 'opencode' ? new OpenCodeHarness(f.options) : new PiHarness(f.options)
      await assert.rejects(adapter.run(request, new AbortController().signal), (error: Error) => {
        if (scenario === 'error') {
          assert.match(error.message, /reported .*error/)
        } else {
          assert.match(error.message, /Harness process exited with code 7/)
        }
        assert.match(error.message, scenario === 'stderr-exit' ? /Credentials rejected by provider/ : /Provider quota exhausted/)
        if (scenario === 'stderr-exit') assert.doesNotMatch(error.message, /Provider quota exhausted/)
        if (scenario === 'stdout-exit') assert.doesNotMatch(error.message, /Final native artifact/)
        return true
      })
    } finally { await rm(f.directory, { recursive: true }) }
  }
})
test('native failure detail is bounded and retains the end of stderr', async () => {
  const f = await fixtureOptions('opencode', 'bounded-exit')
  try {
    await assert.rejects(new OpenCodeHarness({ ...f.options, maxOutputBytes: 8192 }).run(request, new AbortController().signal), (error: Error) => {
      assert.match(error.message, /Harness process exited with code 7: …/)
      assert.match(error.message, /Credentials rejected by provider$/)
      assert.ok(error.message.length < 4200)
      assert.doesNotMatch(error.message, /Provider quota exhausted/)
      return true
    })
  } finally { await rm(f.directory, { recursive: true }) }
})
test('combined stdout and stderr output limit takes precedence over exit details', async () => {
  const f = await fixtureOptions('opencode', 'output-limit')
  try {
    await assert.rejects(new OpenCodeHarness({ ...f.options, maxOutputBytes: 1024 }).run(request, new AbortController().signal), {
      message: 'Harness output exceeded limit',
    })
  } finally { await rm(f.directory, { recursive: true }) }
})
test('native final text never makes a nonzero subprocess exit successful', async () => {
  for (const kind of ['opencode', 'pi']) {
    const f = await fixtureOptions(kind, 'success-exit')
    try {
      const adapter = kind === 'opencode' ? new OpenCodeHarness(f.options) : new PiHarness(f.options)
      await assert.rejects(adapter.run(request, new AbortController().signal), /Harness process exited with code 7/)
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
test('agent model overrides the harness model and falls back to it when absent', async () => {
  for (const kind of ['opencode', 'pi']) {
    const expected = async (agentModel: string | undefined, harnessModel: string | undefined) => {
      const f = await fixtureOptions(kind)
      try {
        const options = { ...f.options, model: harnessModel }
        const adapter = kind === 'opencode' ? new OpenCodeHarness(options) : new PiHarness(options)
        await adapter.run({ ...request, agent: { ...request.agent, model: agentModel } }, new AbortController().signal)
        const args: string[] = JSON.parse(await readFile(f.capture, 'utf8')).args
        const at = args.indexOf('--model')
        return at < 0 ? undefined : args[at + 1]
      } finally { await rm(f.directory, { recursive: true }) }
    }
    assert.equal(await expected('agent/model', 'harness/model'), 'agent/model')
    assert.equal(await expected(undefined, 'harness/model'), 'harness/model')
    assert.equal(await expected('agent/model', undefined), 'agent/model')
    assert.equal(await expected(undefined, undefined), undefined)
  }
})
test('config accepts an optional agent model and rejects an empty one', () => {
  const base = { harnesses: { h: { type: 'demo' } }, router: { type: 'rule' } }
  const agents = (model?: string) => [{ id: 'w', role: 'worker', harness: 'h', ...(model === undefined ? {} : { model }) }, { id: 'r', role: 'reviewer', harness: 'h' }]
  assert.equal(configSchema.parse({ ...base, agents: agents('p/m') }).agents[0]?.model, 'p/m')
  assert.equal(configSchema.parse({ ...base, agents: agents() }).agents[0]?.model, undefined)
  assert.throws(() => configSchema.parse({ ...base, agents: agents('') }))
})
