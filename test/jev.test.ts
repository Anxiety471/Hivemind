import assert from 'node:assert/strict'
import test from 'node:test'
import { JevRouter } from '../src/jev.js'
import { configSchema } from '../src/config.js'
import type { RouterContext } from '../src/types.js'
const context: RouterContext = { task: 'Build a web app', artifact: '', feedback: '', attempts: 0, status: 'running', approved: false, decision: null, events: [], agents: [
  { id: 'worker', role: 'worker', harness: 'h', description: 'Builds' },
  { id: 'research', role: 'researcher', harness: 'h', description: 'Researches' },
  { id: 'design', role: 'designer', harness: 'h', description: 'Designs' },
  { id: 'plan', role: 'planner', harness: 'h', description: 'Synthesizes' },
] }
const signal = () => new AbortController().signal
const answer = (choice = 'orchestrate', confidence = 0.95) => ({ answers: {
  route: { type: 'choice', choice, confidence }, execution: { type: 'choice', choice: 'parallel', confidence: 0.9 },
} })

test('Jev uses native typed questions and can route parallel preparation without generating text', async t => {
  process.env.HIVEMIND_TEST_JEV = 'test-key'
  t.after(() => { delete process.env.HIVEMIND_TEST_JEV })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls++
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    const body = JSON.parse(String(options.body))
    assert.equal(body.model, 'jev-latest')
    assert.equal(body.questions.route.type, 'choice')
    assert.equal(body.questions.execution.type, 'choice')
    assert.deepEqual(Object.keys(body.questions.route.criteria), ['orchestrate', 'block'])
    return Response.json(answer())
  })
  const router = new JevRouter({ apiKeyEnv: 'HIVEMIND_TEST_JEV' })
  const decision = await router.decide(context, signal())
  assert.equal(decision.action, 'dispatch')
  if (decision.action === 'dispatch') assert.equal(decision.parallelPreparation, true)
  assert.match(decision.reason, /confidence 0.95/)
  assert.equal((await router.decide({ ...context, approved: true }, signal())).action, 'finish')
  assert.equal(calls, 1)
})

test('Jev high-confidence blocked route stops before orchestration', async t => {
  process.env.HIVEMIND_TEST_JEV = 'test-key'; t.after(() => { delete process.env.HIVEMIND_TEST_JEV })
  t.mock.method(globalThis, 'fetch', async () => Response.json(answer('block')))
  assert.equal((await new JevRouter({ apiKeyEnv: 'HIVEMIND_TEST_JEV' }).decide(context, signal())).action, 'block')
})

test('missing key, low confidence, malformed answer and HTTP/network failure fall back to deterministic routing', async t => {
  const router = new JevRouter({ apiKeyEnv: 'HIVEMIND_TEST_JEV' })
  delete process.env.HIVEMIND_TEST_JEV
  assert.equal((await router.decide(context, signal())).action, 'dispatch')
  process.env.HIVEMIND_TEST_JEV = 'test-key'; t.after(() => { delete process.env.HIVEMIND_TEST_JEV })
  for (const response of [Response.json(answer('block', 0.4)), Response.json({ answers: {} }), Response.json(answer('finish')), new Response('', { status: 503 })]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response)
    assert.equal((await router.decide(context, signal())).action, 'dispatch')
    mock.mock.restore()
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down') })
  assert.equal((await router.decide(context, signal())).action, 'dispatch')
})

test('Jev propagates cancellation rather than hiding it with a fallback', async t => {
  process.env.HIVEMIND_TEST_JEV = 'test-key'; t.after(() => { delete process.env.HIVEMIND_TEST_JEV })
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(new Error('Cancelled')); throw controller.signal.reason })
  await assert.rejects(new JevRouter({ apiKeyEnv: 'HIVEMIND_TEST_JEV' }).decide(context, controller.signal), /Cancelled/)
})

test('Jev config defaults are parsed and invalid confidence thresholds are rejected', () => {
  const config = { agents: context.agents, harnesses: { h: { type: 'demo' } }, router: { type: 'jev' } }
  const parsed = configSchema.parse(config).router
  assert.equal(parsed.type, 'jev')
  if (parsed.type === 'jev') assert.equal(parsed.minConfidence, 0.7)
  assert.throws(() => configSchema.parse({ ...config, router: { type: 'jev', minConfidence: 2 } }))
})
