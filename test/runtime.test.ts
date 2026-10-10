import assert from 'node:assert/strict'
import test from 'node:test'
import { createHivemind } from '../src/graph.js'
import { CommandHarness, DemoHarness, HarnessRegistry, OpenAICompatibleHarness } from '../src/harnesses.js'
import { ModelRouter, RuleRouter } from '../src/routers.js'
import { fromConfig } from '../src/config.js'
import type { Agent, Harness, HarnessRequest, Router } from '../src/types.js'

const agents: Agent[] = [
  { id: 'writer', role: 'worker', harness: 'worker', description: 'Drafts' },
  { id: 'reviewer', role: 'reviewer', harness: 'review', description: 'Reviews' },
]
function runtime(worker: Harness = new DemoHarness(), review: Harness = new DemoHarness(), router: Router = new RuleRouter(), maxAttempts = 3, timeoutMs = 5000) {
  return createHivemind({ agents, harnesses: new HarnessRegistry().register('worker', worker).register('review', review), router, maxAttempts, timeoutMs })
}
const approves: Harness = { async run() { return JSON.stringify({ verdict: 'approved', feedback: 'Meets the task.' }) } }

test('runs the actual LangGraph revision loop and finishes after approval', async () => {
  const result = await runtime().run('Write an introduction')
  assert.equal(result.status, 'completed')
  assert.equal(result.attempts, 2)
  assert.deepEqual(result.events.map(e => e.node), ['decide', 'work', 'review', 'decide', 'work', 'review', 'decide'])
  assert.match(result.artifact, /Revised/)
})
test('stops an endless revision loop at the host attempt limit', async () => {
  const review: Harness = { async run() { return JSON.stringify({ verdict: 'revise', feedback: 'Try again.' }) } }
  const result = await runtime(new DemoHarness(), review, new RuleRouter(), 2).run('Draft')
  assert.equal(result.status, 'exhausted')
  assert.equal(result.attempts, 2)
})
test('allows completion when approval occurs on the final attempt', async () => {
  assert.equal((await runtime(new DemoHarness(), approves, new RuleRouter(), 1).run('Draft')).status, 'completed')
})
test('treats an approved artifact at the attempt limit as completed', async () => {
  // A model router can request another work step at the limit; an approved artifact must not be discarded as exhausted.
  const requestsWork: Router = { async decide() { return { action: 'work', agent: 'writer', instructions: 'Keep going', reason: 'Another pass' } } }
  const approved = await runtime(new DemoHarness(), approves, requestsWork, 1).run('Draft')
  assert.equal(approved.status, 'completed')
  assert.equal(approved.attempts, 1)
  assert.equal(approved.approved, true)
  assert.match(approved.artifact, /Draft for: Draft/)
  assert.equal(approved.events.at(-1)?.message, 'Attempt limit reached with an approved artifact.')
  const rejected = await runtime(new DemoHarness(), { async run() { return JSON.stringify({ verdict: 'revise', feedback: 'Try again.' }) } }, requestsWork, 1).run('Draft')
  assert.equal(rejected.status, 'exhausted')
  assert.equal(rejected.approved, false)
  assert.equal(rejected.events.at(-1)?.message, 'Attempt limit reached.')
})
test('rejects premature completion, unknown workers, and malformed decisions', async () => {
  for (const decision of [{ action: 'finish', reason: 'Done' }, { action: 'work', agent: 'missing', instructions: 'Go', reason: 'Go' }, { action: 'anything' }]) {
    const router = { async decide() { return decision } } as Router
    const result = await runtime(undefined, undefined, router).run('Draft')
    assert.equal(result.status, 'blocked')
    assert.equal(result.attempts, 0)
  }
})
test('reports blockers without executing workers', async () => {
  const router: Router = { async decide() { return { action: 'block', reason: 'Need a source file.' } } }
  const result = await runtime(undefined, undefined, router).run('Draft')
  assert.equal(result.feedback, 'Need a source file.')
  assert.equal(result.status, 'blocked')
})
test('worker failures and invalid reviews cannot produce completed runs', async () => {
  const failed: Harness = { async run() { throw new Error('Worker unavailable') } }
  const malformed: Harness = { async run() { return 'not JSON' } }
  assert.equal((await runtime(failed).run('Draft')).status, 'blocked')
  assert.equal((await runtime(undefined, malformed).run('Draft')).approved, false)
  assert.equal((await runtime(undefined, malformed).run('Draft')).status, 'blocked')
})
test('times out even when a custom harness ignores the abort signal', async () => {
  const never: Harness = { run() { return new Promise(() => {}) } }
  const result = await runtime(never, approves, new RuleRouter(), 1, 20).run('Draft')
  assert.equal(result.status, 'blocked')
  assert.match(result.feedback, /timed out/)
})
test('a model router can select different harnesses and approval is reset after each work step', async () => {
  const extra: Agent = { id: 'second', role: 'worker', harness: 'second-harness', description: 'Revises' }
  const routerAgent: Agent = { id: 'router', role: 'router', harness: 'router-harness', description: 'Decides' }
  let calls = 0
  const seen: string[] = []
  const routerHarness: Harness = { async run(request) {
    assert.match(request.instructions, /second/)
    calls++
    return JSON.stringify(calls <= 2
      ? { action: 'work', agent: calls === 1 ? 'writer' : 'second', instructions: 'Write', reason: 'Try worker' }
      : { action: 'finish', reason: 'Approved' })
  } }
  const worker = (name: string): Harness => ({ async run() { seen.push(name); return name } })
  const registry = new HarnessRegistry().register('worker', worker('first')).register('second-harness', worker('second'))
    .register('review', approves).register('router-harness', routerHarness)
  const result = await createHivemind({ agents: [...agents, extra, routerAgent], harnesses: registry, router: new ModelRouter(routerAgent, registry) }).run('Write')
  assert.deepEqual(seen, ['first', 'second'])
  assert.equal(result.events.filter(e => e.node === 'review').length, 2)
  assert.equal(result.artifact, 'second')
  assert.equal(result.status, 'completed')
})
test('rejects invalid runtime configuration before any execution', () => {
  assert.throws(() => runtime(undefined, undefined, undefined, 0))
  assert.throws(() => createHivemind({ agents: [...agents, agents[0]!], harnesses: new HarnessRegistry(), router: new RuleRouter() }), /Duplicate/)
  assert.throws(() => fromConfig({ harnesses: {}, agents, router: { type: 'model', agent: 'writer' } }), /router agent/)
  assert.throws(() => fromConfig({ harnesses: {}, agents, router: { type: 'rule' } }), /Unknown harness/)
})
const request: HarnessRequest = { agent: agents[0]!, task: 'Test', instructions: 'Write', artifact: '', feedback: '', attempt: 1 }
test('command harness sends JSON over stdin without shell interpolation', async () => {
  const harness = new CommandHarness({ command: process.execPath, args: ['-e', "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.parse(s).task))"] })
  assert.equal(await harness.run({ ...request, task: 'literal $(echo nope); `whoami`' }, new AbortController().signal), 'literal $(echo nope); `whoami`')
})
test('command harness detects process failures and excessive output', async () => {
  await assert.rejects(new CommandHarness({ command: process.execPath, args: ['-e', 'process.exit(7)'] }).run(request, new AbortController().signal), /code 7/)
  await assert.rejects(new CommandHarness({ command: process.execPath, args: ['-e', "console.log('a'.repeat(1000))"], maxOutputBytes: 10 }).run(request, new AbortController().signal), /output exceeded/)
})
test('command harness abort terminates the process', async () => {
  const controller = new AbortController()
  const promise = new CommandHarness({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }).run(request, controller.signal)
  controller.abort()
  await assert.rejects(promise)
})
test('OpenAI-compatible adapter sends the configured model and parses text', async () => {
  process.env.HIVEMIND_TEST_KEY = 'test-key'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'http://localhost/v1/chat/completions')
    const headers = init?.headers as Record<string, string>
    assert.equal(headers.Authorization, 'Bearer test-key')
    assert.equal(JSON.parse(String(init?.body)).model, 'test-model')
    return Response.json({ choices: [{ message: { content: 'Test artifact' } }] })
  }
  try {
    const harness = new OpenAICompatibleHarness({ baseUrl: 'http://localhost/v1', model: 'test-model', apiKeyEnv: 'HIVEMIND_TEST_KEY' })
    assert.equal(await harness.run(request, new AbortController().signal), 'Test artifact')
    globalThis.fetch = async () => new Response('', { status: 429 })
    await assert.rejects(harness.run(request, new AbortController().signal), /HTTP 429/)
    globalThis.fetch = async () => Response.json({ choices: [] })
    await assert.rejects(harness.run(request, new AbortController().signal), /no text/)
    delete process.env.HIVEMIND_TEST_KEY
    await assert.rejects(harness.run(request, new AbortController().signal), /Missing API key/)
  } finally { globalThis.fetch = originalFetch; delete process.env.HIVEMIND_TEST_KEY }
})
