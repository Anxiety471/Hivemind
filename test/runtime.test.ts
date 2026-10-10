import assert from 'node:assert/strict'
import test from 'node:test'
import { createHivemind, type Progress } from '../src/graph.js'
import { CommandHarness, DemoHarness, HarnessRegistry, OpenAICompatibleHarness } from '../src/harnesses.js'
import { ModelRouter, RuleRouter } from '../src/routers.js'
import { fromConfig } from '../src/config.js'
import type { Agent, Harness, HarnessRequest, Router } from '../src/types.js'

const agents: Agent[] = [
  { id: 'writer', role: 'worker', harness: 'worker', description: 'Drafts' },
  { id: 'reviewer', role: 'reviewer', harness: 'review', description: 'Reviews' },
]
function runtime(worker: Harness = new DemoHarness(), review: Harness = new DemoHarness(), router: Router = new RuleRouter(), maxAttempts = 3, timeoutMs = 5000,
  extra: { harnessRetries?: number; retryDelayMs?: (retry: number) => number; signal?: AbortSignal; onProgress?: (progress: Progress) => void } = {}) {
  return createHivemind({ agents, harnesses: new HarnessRegistry().register('worker', worker).register('review', review), router, maxAttempts, timeoutMs,
    retryDelayMs: () => 0, ...extra })
}
const approves: Harness = { async run() { return JSON.stringify({ verdict: 'approved', feedback: 'Meets the task.' }) } }

test('runs the actual LangGraph revision loop and finishes after approval', async () => {
  const result = await runtime().run('Write an introduction')
  assert.equal(result.status, 'completed')
  assert.equal(result.attempts, 2)
  assert.deepEqual(result.events.map(e => e.node), ['decide', 'orchestrate', 'work', 'orchestrate', 'security-review', 'review', 'orchestrate', 'work', 'orchestrate', 'security-review', 'review', 'decide'])
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

for (const entrypoint of ['direct runtime', 'configuration'] as const) {
  for (const timeoutMs of [undefined, 20]) {
    test(`${entrypoint}: ${timeoutMs === undefined ? 'omitted timeout permits coding work beyond 120 seconds' : 'an explicit timeout still aborts coding work'}`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      let calls = 0
      let abortedAfterTwoMinutes = false
      const worker: Harness = {
        run(_request, signal) {
          calls++
          const output = new Promise<string>(resolve => setTimeout(() => resolve('Implemented feature'), 121_000))
          // Advance inside the operation, after bounded() has installed its deadline.
          // Only timers are mocked: LangGraph's asynchronous execution still runs normally.
          t.mock.timers.tick(120_001)
          abortedAfterTwoMinutes = signal.aborted
          t.mock.timers.tick(999)
          return output
        },
      }
      const progress: Progress[] = []
      const controls = { onProgress: (item: Progress) => progress.push(item) }
      const timeout = timeoutMs === undefined ? {} : { timeoutMs }
      const model = { type: 'openai-compatible', baseUrl: 'http://localhost/v1', model: 'test-model', apiKeyEnv: 'UNUSED_TEST_KEY' }
      if (entrypoint === 'configuration') {
        // Mock only the external adapter boundary; config parsing and the graph are real.
        t.mock.method(OpenAICompatibleHarness.prototype, 'run', (request: HarnessRequest, signal: AbortSignal) =>
          request.agent.role === 'orchestrator' ? new DemoHarness().run(request) : ['reviewer', 'security-reviewer'].includes(request.agent.role) ? approves.run(request, signal) : worker.run(request, signal))
      }
      const runner = entrypoint === 'configuration'
        ? fromConfig({ agents, harnesses: { worker: model, review: model }, router: { type: 'rule' },
          maxAttempts: 1, harnessRetries: 0, ...timeout }, controls)
        : createHivemind({ agents, harnesses: new HarnessRegistry().register('worker', worker).register('review', approves),
          router: new RuleRouter(), maxAttempts: 1, harnessRetries: 0, ...controls, ...timeout })
      const result = await runner.run('Implement a feature')
      assert.equal(calls, 1)
      assert.equal(result.attempts, 1)
      assert.equal(progress.some(item => item.retry !== undefined), false)
      if (timeoutMs === undefined) {
        assert.equal(abortedAfterTwoMinutes, false)
        assert.equal(result.status, 'completed')
        assert.equal(result.artifact, 'Implemented feature')
        assert.deepEqual(result.events.map(event => event.node), ['decide', 'orchestrate', 'work', 'orchestrate', 'security-review', 'review', 'decide'])
      } else {
        assert.equal(abortedAfterTwoMinutes, true)
        assert.equal(result.status, 'blocked')
        assert.match(result.feedback, /timed out/)
        assert.deepEqual(result.events.map(event => event.node), ['decide', 'orchestrate', 'work'])
      }
    })
  }
}
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
  assert.equal(result.artifact, '[writer]:\nfirst\n\n[second]:\nsecond')
  assert.equal(result.status, 'completed')
})

test('model router task and stage rationales reach real stage execution without a schema retry', async () => {
  const routerAgent: Agent = { id: 'router', role: 'router', harness: 'router-harness', description: 'Decides' }
  const stageReason = 'This coding task can go directly to implementation.'
  const taskReason = 'The coding worker can implement and verify the requested change.'
  const instructions = 'Implement the requested change and return the finished artifact.'
  let routerCalls = 0
  const workerRequests: HarnessRequest[] = []
  const routerHarness: Harness = {
    async run(request) {
      routerCalls++
      if (routerCalls === 1) {
        return JSON.stringify({
          action: 'dispatch',
          stages: [{ stage: 'work', reason: stageReason,
            tasks: [{ agent: 'writer', role: 'worker', instructions, reason: taskReason }] }],
          reason: 'Delegate implementation to the coding worker.',
        })
      }
      assert.match(request.instructions, /Approved: true/)
      assert.equal(request.artifact, 'Implemented change')
      return JSON.stringify({ action: 'finish', reason: 'The reviewer approved the implementation.' })
    },
  }
  const harnesses = new HarnessRegistry()
    .register('worker', { async run(request) { workerRequests.push(request); return 'Implemented change' } })
    .register('review', approves)
    .register('router-harness', routerHarness)
  const progress: Progress[] = []
  const result = await createHivemind({ agents: [...agents, routerAgent], harnesses,
    router: new ModelRouter(routerAgent, harnesses), onProgress: item => progress.push(item) }).run('Fix the coding task')

  assert.equal(result.status, 'completed')
  assert.equal(result.artifact, 'Implemented change')
  assert.equal(result.attempts, 1)
  assert.equal(routerCalls, 2)
  assert.equal(workerRequests.length, 1)
  assert.equal(workerRequests[0]!.agent.id, 'writer')
  assert.equal(workerRequests[0]!.task, 'Fix the coding task')
  assert.ok(workerRequests[0]!.instructions.startsWith(instructions))
  assert.deepEqual(result.events.map(event => event.node), ['decide', 'orchestrate', 'work', 'orchestrate', 'security-review', 'review', 'decide'])
  assert.equal(progress.some(item => item.retry !== undefined), false)
  const decision = progress.find(item => item.node === 'decide' && item.phase === 'end')?.decision
  assert.equal(decision?.action, 'dispatch')
  if (decision?.action === 'dispatch') {
    assert.equal(decision.stages[0]!.reason, stageReason)
    assert.equal(decision.stages[0]!.tasks[0]!.reason, taskReason)
  }
})
test('rejects invalid runtime configuration before any execution', () => {
  assert.throws(() => runtime(undefined, undefined, undefined, 0))
  assert.throws(() => createHivemind({ agents: [...agents, agents[0]!], harnesses: new HarnessRegistry(), router: new RuleRouter() }), /Duplicate/)
  assert.throws(() => fromConfig({ harnesses: {}, agents, router: { type: 'model', agent: 'writer' } }), /router agent/)
  assert.throws(() => fromConfig({ harnesses: {}, agents, router: { type: 'rule' } }), /Unknown harness/)
})
test('a transient worker, review, and router failure is retried and the run completes', async () => {
  const failures = { worker: 1, review: 2, router: 1 }
  const calls = { worker: 0, review: 0, router: 0 }
  const worker: Harness = { async run() { calls.worker++; if (failures.worker-- > 0) throw new Error('Worker unavailable'); return 'draft' } }
  const review: Harness = { async run() {
    calls.review++
    if (failures.review-- === 2) return 'not JSON'
    if (failures.review === 0) throw new Error('Reviewer exited 1')
    return JSON.stringify({ verdict: 'approved', feedback: 'ok' })
  } }
  const rule = new RuleRouter()
  const router: Router = { async decide(context) { calls.router++; if (failures.router-- > 0) throw new Error('Router down'); return rule.decide(context) } }
  const progress: Progress[] = []
  const result = await runtime(worker, review, router, 3, 5000, { onProgress: item => progress.push(item) }).run('Draft')
  assert.equal(result.status, 'completed')
  assert.deepEqual(calls, { worker: 2, review: 4, router: 3 })
  assert.equal(result.attempts, 1)
  const retries = progress.filter(item => item.retry !== undefined)
  assert.deepEqual(retries.map(item => [item.node, item.phase, item.retry, item.attempt]),
    [['decide', 'start', 1, 0], ['work', 'start', 1, 1], ['review', 'start', 1, 1], ['review', 'start', 1, 1]])
  assert.equal(retries[1]!.message, 'Retry 1/2 after: Worker unavailable')
  assert.match(retries[0]!.message, /^Retry 1\/2 after: Router down/)
  assert.equal(result.events.filter(event => /^Retry \d\/2 after:/.test(event.message)).length, 4)
})
test('a worker that always fails blocks after exactly harnessRetries + 1 calls', async () => {
  let calls = 0
  const failed: Harness = { async run() { calls++; throw new Error('Worker unavailable') } }
  const result = await runtime(failed, approves, new RuleRouter(), 3, 5000, { harnessRetries: 3 }).run('Draft')
  assert.equal(calls, 4)
  assert.equal(result.status, 'blocked')
  assert.equal(result.attempts, 1)
  assert.equal(result.feedback, 'Worker unavailable (after 3 retries)')
})
test('default harnessRetries is 2 and an empty artifact or timeout counts as a failure', async () => {
  let empty = 0
  const blank: Harness = { async run() { empty++; return '  ' } }
  assert.match((await runtime(blank).run('Draft')).feedback, /empty artifact \(after 2 retries\)/)
  assert.equal(empty, 3)
  let hung = 0
  const never: Harness = { run() { hung++; return new Promise(() => {}) } }
  const result = await runtime(never, approves, new RuleRouter(), 1, 20).run('Draft')
  assert.equal(hung, 3)
  assert.match(result.feedback, /timed out \(after 2 retries\)/)
})
test('retries do not increase the work attempts counter across revisions', async () => {
  let worker = 0
  let reviews = 0
  const flaky: Harness = { async run() { worker++; if (worker % 2 === 1) throw new Error('Flaky'); return `draft ${worker}` } }
  const review: Harness = { async run() { return JSON.stringify(++reviews === 1 ? { verdict: 'revise', feedback: 'More' } : { verdict: 'approved', feedback: 'ok' }) } }
  const seen: number[] = []
  const result = await runtime(flaky, review, new RuleRouter(), 3, 5000, { onProgress: item => { if (item.node === 'work' && item.phase === 'start') seen.push(item.attempt) } }).run('Draft')
  assert.equal(result.status, 'completed')
  assert.equal(result.attempts, 2)
  assert.equal(worker, 4)
  assert.deepEqual(seen, [1, 1, 2, 2])
})
test('harnessRetries 0 blocks on the first failure like before', async () => {
  let calls = 0
  const failed: Harness = { async run() { calls++; throw new Error('Worker unavailable') } }
  const progress: Progress[] = []
  const result = await runtime(failed, approves, new RuleRouter(), 3, 5000, { harnessRetries: 0, onProgress: item => progress.push(item) }).run('Draft')
  assert.equal(calls, 1)
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback, 'Worker unavailable')
  assert.equal(progress.some(item => item.retry !== undefined), false)
})
test('cancellation is not retried, including during the backoff wait', async () => {
  const controller = new AbortController()
  let calls = 0
  const failing: Harness = { async run() { calls++; controller.abort(new Error('Run cancelled')); throw new Error('Worker unavailable') } }
  await runtime(failing, approves, new RuleRouter(), 3, 5000, { signal: controller.signal }).run('Draft')
  assert.equal(calls, 1)
  const waiting = new AbortController()
  let waits = 0
  const progress: Progress[] = []
  const failed: Harness = { async run() { waits++; throw new Error('Worker unavailable') } }
  const started = Date.now()
  // The microtask runs after the backoff wait has started, so the abort lands mid-wait rather than before it.
  const result = await runtime(failed, approves, new RuleRouter(), 3, 5000, { signal: waiting.signal, retryDelayMs: () => 60_000,
    onProgress: item => { progress.push(item); if (item.retry === 1) queueMicrotask(() => waiting.abort(new Error('Run cancelled'))) } }).run('Draft')
  assert.ok(Date.now() - started < 5000)
  assert.equal(waits, 1)
  assert.equal(result.status, 'blocked')
  assert.equal(result.feedback, 'Run cancelled')
})
test('rejects an out-of-range harnessRetries', () => {
  assert.throws(() => runtime(undefined, undefined, undefined, 3, 5000, { harnessRetries: 11 }), /harnessRetries/)
  assert.throws(() => runtime(undefined, undefined, undefined, 3, 5000, { harnessRetries: -1 }), /harnessRetries/)
  assert.throws(() => fromConfig({ harnesses: {}, agents, router: { type: 'rule' }, harnessRetries: 11 }))
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

test('router can dispatch a multi-stage plan: research -> plan -> work -> review', async () => {
  const customAgents: Agent[] = [
    { id: 'scout', role: 'researcher', harness: 'h-scout', description: 'Researches' },
    { id: 'architect', role: 'planner', harness: 'h-architect', description: 'Plans' },
    { id: 'writer', role: 'worker', harness: 'h-writer', description: 'Drafts' },
    { id: 'reviewer', role: 'reviewer', harness: 'h-review', description: 'Reviews' },
  ]
  const stagesExecuted: string[] = []
  const harnesses = new HarnessRegistry()
    .register('h-scout', {
      async run(req) {
        stagesExecuted.push('research')
        return `Research findings for ${req.task}`
      },
    })
    .register('h-architect', {
      async run(req) {
        stagesExecuted.push('plan')
        assert.match(req.artifact, /Research findings/)
        return `Architecture plan based on: ${req.artifact}`
      },
    })
    .register('h-writer', {
      async run(req) {
        stagesExecuted.push('work')
        assert.match(req.artifact, /Architecture plan/)
        return `Final draft based on: ${req.artifact}`
      },
    })
    .register('h-review', approves)

  const router: Router = {
    async decide(context) {
      if (context.approved) return { action: 'finish', reason: 'Artifact approved' }
      return {
        action: 'dispatch',
        stages: [
          { stage: 'research', tasks: [{ agent: 'scout', role: 'researcher', instructions: 'Find info' }] },
          { stage: 'plan', tasks: [{ agent: 'architect', role: 'planner', instructions: 'Draft plan' }] },
          { stage: 'work', tasks: [{ agent: 'writer', role: 'worker', instructions: 'Write draft' }] },
        ],
        reason: 'Execute research, plan, and work pipeline',
      }
    },
  }

  const progressUpdates: Progress[] = []
  const runner = createHivemind({
    agents: customAgents,
    harnesses,
    router,
    onProgress: p => progressUpdates.push(p),
  })

  const result = await runner.run('Build feature X')
  assert.equal(result.status, 'completed')
  assert.deepEqual(stagesExecuted, ['research', 'plan', 'work'])
  assert.deepEqual(result.events.map(e => e.node), ['decide', 'orchestrate', 'research', 'plan', 'work', 'orchestrate', 'security-review', 'review', 'decide'])
  assert.match(result.artifact, /Final draft based on: Architecture plan/)

  const startUpdates = progressUpdates.filter(p => p.phase === 'start')
  assert.equal(startUpdates.find(p => p.node === 'research')?.message, 'scout via h-scout')
  assert.equal(startUpdates.find(p => p.node === 'plan')?.message, 'architect via h-architect')
  assert.equal(startUpdates.find(p => p.node === 'work')?.message, 'writer via h-writer')
})

test('multiple researchers spawned concurrently (fan-out) and outputs aggregated', async () => {
  const customAgents: Agent[] = [
    { id: 'scout1', role: 'researcher', harness: 'h-scout', description: 'Researcher 1' },
    { id: 'scout2', role: 'researcher', harness: 'h-scout', description: 'Researcher 2' },
    { id: 'writer', role: 'worker', harness: 'h-writer', description: 'Worker' },
    { id: 'reviewer', role: 'reviewer', harness: 'h-review', description: 'Reviewer' },
  ]
  let activeResearchers = 0
  let maxConcurrentResearchers = 0
  let writerReceivedArtifact = ''

  const { promise: bothStarted, resolve: releaseBoth } = Promise.withResolvers<void>()
  const harnesses = new HarnessRegistry()
    .register('h-scout', {
      async run(req) {
        activeResearchers++
        maxConcurrentResearchers = Math.max(maxConcurrentResearchers, activeResearchers)
        if (activeResearchers === 2) releaseBoth()
        await bothStarted
        activeResearchers--
        return `Notes from ${req.agent.id}`
      },
    })
    .register('h-writer', {
      async run(req) {
        writerReceivedArtifact = req.artifact
        return `Combined report using: ${req.artifact}`
      },
    })
    .register('h-review', approves)

  const router: Router = {
    async decide(context) {
      if (context.approved) return { action: 'finish', reason: 'Done' }
      return {
        action: 'dispatch',
        stages: [
          {
            stage: 'research',
            tasks: [
              { agent: 'scout1', role: 'researcher', instructions: 'Research topic A' },
              { agent: 'scout2', role: 'researcher', instructions: 'Research topic B' },
            ],
          },
          { stage: 'work', tasks: [{ agent: 'writer', role: 'worker', instructions: 'Synthesize findings' }] },
        ],
        reason: 'Fan-out research then work',
      }
    },
  }

  const progressUpdates: Progress[] = []
  const runner = createHivemind({
    agents: customAgents,
    harnesses,
    router,
    onProgress: p => progressUpdates.push(p),
  })

  const result = await runner.run('Analyze markets')
  assert.equal(result.status, 'completed')
  assert.ok(maxConcurrentResearchers >= 2, `Expected concurrent execution, max concurrent was ${maxConcurrentResearchers}`)
  assert.match(writerReceivedArtifact, /\[scout1\]:\nNotes from scout1/)
  assert.match(writerReceivedArtifact, /\[scout2\]:\nNotes from scout2/)
  const researchStart = progressUpdates.find(p => p.node === 'research' && p.phase === 'start')
  assert.equal(researchStart?.message, 'scout1, scout2 via h-scout')
})

test('skipping optional stages: dispatches only work, or research and work without design', async () => {
  const customAgents: Agent[] = [
    { id: 'scout', role: 'researcher', harness: 'h-scout', description: 'Researcher' },
    { id: 'designer', role: 'designer', harness: 'h-designer', description: 'Designer' },
    { id: 'writer', role: 'worker', harness: 'h-writer', description: 'Worker' },
    { id: 'reviewer', role: 'reviewer', harness: 'h-review', description: 'Reviewer' },
  ]
  const harnesses = new HarnessRegistry()
    .register('h-scout', { async run() { return 'Scout output' } })
    .register('h-designer', { async run() { return 'Design output' } })
    .register('h-writer', { async run() { return 'Work output' } })
    .register('h-review', approves)

  const workOnlyRouter: Router = {
    async decide(context) {
      if (context.approved) return { action: 'finish', reason: 'Approved' }
      return {
        action: 'dispatch',
        stages: [{ stage: 'work', tasks: [{ agent: 'writer', instructions: 'Just write' }] }],
        reason: 'Work directly',
      }
    },
  }
  const workOnlyResult = await createHivemind({ agents: customAgents, harnesses, router: workOnlyRouter }).run('Task 1')
  assert.equal(workOnlyResult.status, 'completed')
  assert.deepEqual(workOnlyResult.events.map(e => e.node), ['decide', 'orchestrate', 'work', 'orchestrate', 'security-review', 'review', 'decide'])

  const researchAndWorkRouter: Router = {
    async decide(context) {
      if (context.approved) return { action: 'finish', reason: 'Approved' }
      return {
        action: 'dispatch',
        stages: [
          { stage: 'research', tasks: [{ agent: 'scout', instructions: 'Investigate' }] },
          { stage: 'work', tasks: [{ agent: 'writer', instructions: 'Implement' }] },
        ],
        reason: 'Research and write directly without plan or design',
      }
    },
  }
  const researchAndWorkResult = await createHivemind({ agents: customAgents, harnesses, router: researchAndWorkRouter }).run('Task 2')
  assert.equal(researchAndWorkResult.status, 'completed')
  assert.deepEqual(researchAndWorkResult.events.map(e => e.node), ['decide', 'orchestrate', 'research', 'work', 'orchestrate', 'security-review', 'review', 'decide'])
})

test('RuleRouter automatically dispatches configured pipeline stages on first attempt', async () => {
  const customAgents: Agent[] = [
    { id: 'scout', role: 'researcher', harness: 'h-scout', description: 'Researcher' },
    { id: 'architect', role: 'planner', harness: 'h-plan', description: 'Planner' },
    { id: 'artist', role: 'designer', harness: 'h-design', description: 'Designer' },
    { id: 'writer', role: 'worker', harness: 'h-worker', description: 'Worker' },
    { id: 'reviewer', role: 'reviewer', harness: 'h-review', description: 'Reviewer' },
  ]
  const harnesses = new HarnessRegistry()
    .register('h-scout', { async run() { return 'Research done' } })
    .register('h-plan', { async run() { return 'Plan done' } })
    .register('h-design', { async run() { return 'Design done' } })
    .register('h-worker', { async run() { return 'Work done' } })
    .register('h-review', approves)

  const result = await createHivemind({ agents: customAgents, harnesses, router: new RuleRouter() }).run('Create full project')
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.events.map(e => e.node), ['decide', 'orchestrate', 'research', 'design', 'plan', 'work', 'orchestrate', 'security-review', 'review', 'decide'])
})
