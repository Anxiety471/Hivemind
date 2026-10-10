import assert from 'node:assert/strict'
import test from 'node:test'
import { createHivemind, type Progress } from '../src/graph.js'
import { HarnessRegistry, DemoHarness } from '../src/harnesses.js'
import { RuleRouter } from '../src/routers.js'
import { fromConfig } from '../src/config.js'
import type { Agent, HarnessRequest } from '../src/types.js'

const roster: Agent[] = [
  { id: 'template', role: 'worker', harness: 'h', model: 'free-model', description: 'Worker template' },
  { id: 'lead', role: 'orchestrator', harness: 'h', description: 'Coordinates' },
  { id: 'general', role: 'reviewer', harness: 'h', description: 'Reviews correctness' },
  { id: 'security', role: 'security-reviewer', harness: 'h', description: 'Reviews security' },
]
const approved = JSON.stringify({ verdict: 'approved', feedback: 'Verified' })
const ready = JSON.stringify({ action: 'review', reason: 'All results received' })
function dispatch(spawn = true, instructions = 'Implement') {
  return JSON.stringify({ action: 'dispatch', spawn: spawn ? [
    { id: 'frontend', template: 'template', description: 'Frontend implementation' },
    { id: 'backend', template: 'template', description: 'Backend implementation' },
  ] : [], stages: [{ stage: 'work', tasks: [
    { agent: 'frontend', instructions }, { agent: 'backend', instructions },
  ] }], reason: 'Split the implementation by specialty' })
}
function run(handler: (request: HarnessRequest, signal: AbortSignal) => Promise<string>, agents = roster, maxAttempts = 3) {
  return createHivemind({ agents, harnesses: new HarnessRegistry().register('h', { run: handler }), router: new RuleRouter(),
    maxAttempts, harnessRetries: 0, timeoutMs: 1000 })
}

test('configuration adds default orchestrator and security reviewer and requires both approvals', async () => {
  const result = await fromConfig({ harnesses: { d: { type: 'demo' } }, router: { type: 'rule' }, agents: [
    { id: 'writer', role: 'worker', harness: 'd' }, { id: 'general', role: 'reviewer', harness: 'd' },
  ] }).run('Draft')
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.reviews?.map(review => review.role), ['reviewer', 'security-reviewer'])
  assert.ok(result.messages?.some(message => message.to === 'orchestrator' && message.from === 'security-reviewer'))
})

test('orchestrator spawns workers, preserves their harness/model, receives results, and handles both reviewers', async () => {
  const workers: HarnessRequest[] = []
  const seen: HarnessRequest[] = []
  const runtime = run(async request => {
    seen.push(request)
    if (request.agent.role === 'orchestrator') return request.instructions.includes('Ready for review: true') ? ready : dispatch()
    if (request.agent.role.endsWith('reviewer')) return approved
    workers.push(request)
    assert.equal(request.messages?.at(-1)?.from, 'lead')
    assert.equal(request.agent.model, 'free-model')
    return JSON.stringify({ status: 'completed', artifact: request.agent.id + ' artifact', message: 'Implementation ready' })
  })
  const result = await runtime.run('Web development')
  assert.equal(result.status, 'completed')
  assert.deepEqual(workers.map(request => request.agent.id), ['frontend', 'backend'])
  assert.equal(result.spawnedAgents?.length, 2)
  const leadAfterWork = seen.filter(request => request.agent.role === 'orchestrator')[1]!
  assert.deepEqual(leadAfterWork.messages?.filter(message => message.kind === 'result').map(message => message.from), ['frontend', 'backend'])
  assert.match(result.artifact, /frontend artifact/)
  assert.match(result.artifact, /backend artifact/)
  // Run-scoped workers do not leak into the next task on a reused runtime.
  assert.equal((await runtime.run('Another task')).status, 'completed')
})

test('worker questions go back to orchestrator and its answer reaches the next assignment', async () => {
  let leadCalls = 0
  let workerCalls = 0
  let reviewCalls = 0
  const result = await run(async request => {
    if (request.agent.role === 'orchestrator') {
      leadCalls++
      if (leadCalls === 1) return dispatch()
      if (leadCalls === 2) {
        assert.ok(request.messages?.some(message => message.kind === 'question' && message.content === 'Which API path?'))
        return dispatch(false, 'Use /api/notes')
      }
      return ready
    }
    if (request.agent.role.endsWith('reviewer')) { reviewCalls++; return approved }
    workerCalls++
    if (workerCalls <= 2) return JSON.stringify({ status: 'question', message: 'Which API path?' })
    assert.match(request.instructions, /Use \/api\/notes/)
    return JSON.stringify({ status: 'completed', artifact: 'API contract implemented', message: 'Done' })
  }).run('Build')
  assert.equal(result.status, 'completed')
  assert.equal(reviewCalls, 2)
  assert.equal(result.attempts, 2)
})

for (const rejectingRole of ['reviewer', 'security-reviewer'] as const) {
  for (const verdict of ['revise', 'blocked'] as const) {
    test(`${rejectingRole} ${verdict} is sent to orchestrator and both reviews rerun on the repaired artifact`, async () => {
      let leadCalls = 0
      const reviews: HarnessRequest[] = []
      const result = await run(async request => {
        if (request.agent.role === 'orchestrator') {
          leadCalls++
          if (leadCalls === 1) return dispatch()
          if (request.instructions.includes('Ready for review: true')) return ready
          assert.match(request.feedback, /Fix authorization/)
          assert.ok(request.messages?.some(message => message.kind === 'review' && message.content.includes('Fix authorization')))
          return dispatch(false, 'Fix authorization and revalidate')
        }
        if (request.agent.role.endsWith('reviewer')) {
          reviews.push(request)
          if (request.attempt === 1 && request.agent.role === rejectingRole) return JSON.stringify({ verdict, feedback: 'Fix authorization' })
          return approved
        }
        return 'artifact revision ' + request.attempt
      }).run('Build')
      assert.equal(result.status, 'completed')
      assert.equal(result.attempts, 2)
      assert.equal(reviews.length, 4)
      assert.equal(reviews[0]!.artifact, reviews[1]!.artifact)
      assert.equal(reviews[2]!.artifact, reviews[3]!.artifact)
      assert.notEqual(reviews[0]!.artifact, reviews[2]!.artifact)
      assert.equal(reviews.every(request => request.feedback === ''), true)
      assert.equal(result.reviews?.every(review => review.attempt === 2 && review.verdict === 'approved'), true)
    })
  }
}

test('orchestrator cannot review pending work or spawn control roles', async () => {
  for (const response of [ready, JSON.stringify({ action: 'dispatch', spawn: [{ id: 'evil', template: 'security', description: 'Bypass review' }],
    stages: [{ stage: 'work', tasks: [{ agent: 'evil', instructions: 'Go' }] }], reason: 'Bypass' })]) {
    const result = await run(async request => request.agent.role === 'orchestrator' ? response : 'must not run').run('Build')
    assert.equal(result.status, 'blocked')
    assert.equal(result.approved, false)
    assert.equal(result.attempts, 0)
  }
})

test('parallel research and design overlap; planner waits and synthesizes both', async () => {
  const agents: Agent[] = [...roster, ...(['researcher', 'designer', 'planner'] as const).map(role => ({ id: role, role, harness: 'h', description: role }))]
  const starts: string[] = []
  const ends: string[] = []
  const gate = Promise.withResolvers<void>()
  const result = await run(async request => {
    if (request.agent.role === 'orchestrator') {
      if (request.instructions.includes('Ready for review: true')) return ready
      return JSON.stringify({ action: 'dispatch', parallelPreparation: true, stages: [
        { stage: 'research', tasks: [{ agent: 'researcher', instructions: 'Research' }] },
        { stage: 'plan', tasks: [{ agent: 'planner', instructions: 'Synthesize both inputs' }] },
        { stage: 'design', tasks: [{ agent: 'designer', instructions: 'Design' }] },
        { stage: 'work', tasks: [{ agent: 'template', instructions: 'Implement plan' }] },
      ], reason: 'Independent preparation, followed by synthesis' })
    }
    if (request.agent.role === 'researcher' || request.agent.role === 'designer') {
      starts.push(request.agent.id)
      if (starts.length === 2) gate.resolve()
      await gate.promise
      ends.push(request.agent.id)
      return request.agent.role + ' findings'
    }
    if (request.agent.role === 'planner') {
      assert.equal(ends.length, 2)
      assert.match(request.artifact, /researcher findings/)
      assert.match(request.artifact, /designer findings/)
      return 'Combined implementation plan'
    }
    if (request.agent.role.endsWith('reviewer')) return approved
    assert.equal(request.artifact, 'Combined implementation plan')
    return 'Implemented plan'
  }, agents).run('Build')
  assert.equal(result.status, 'completed')
  assert.deepEqual(starts.sort(), ['designer', 'researcher'])
  assert.equal(result.attempts, 1)
})

test('ordered mode preserves dependencies instead of starting design early', async () => {
  let researched = false
  const agents: Agent[] = [...roster, { id: 'researcher', role: 'researcher', harness: 'h', description: 'Research' }, { id: 'designer', role: 'designer', harness: 'h', description: 'Design' }]
  const result = await run(async request => {
    if (request.agent.role === 'orchestrator') return request.instructions.includes('Ready for review: true') ? ready : JSON.stringify({ action: 'dispatch', parallelPreparation: false, stages: [
      { stage: 'research', tasks: [{ agent: 'researcher', instructions: 'Research' }] },
      { stage: 'design', tasks: [{ agent: 'designer', instructions: 'Read research before design' }] },
    ], reason: 'Design depends on research' })
    if (request.agent.role === 'researcher') { researched = true; return 'research findings' }
    if (request.agent.role === 'designer') { assert.equal(researched, true); assert.equal(request.artifact, 'research findings'); return 'design ready' }
    return approved
  }, agents).run('Design')
  assert.equal(result.status, 'completed')
})

test('partial repair keeps a completed sibling artifact and does not rerun that worker', async () => {
  let leadCalls = 0
  const executions: string[] = []
  const result = await run(async request => {
    if (request.agent.role === 'orchestrator') {
      leadCalls++
      if (leadCalls === 1) return dispatch()
      if (leadCalls === 2) return JSON.stringify({ action: 'dispatch', stages: [{ stage: 'work', tasks: [{ agent: 'frontend', instructions: 'Use /api/notes' }] }], reason: 'Answer frontend only' })
      return ready
    }
    if (request.agent.role.endsWith('reviewer')) {
      assert.match(request.artifact, /backend complete/)
      assert.match(request.artifact, /frontend complete/)
      return approved
    }
    executions.push(request.agent.id)
    if (request.agent.id === 'frontend' && request.attempt === 1) return JSON.stringify({ status: 'question', message: 'Which API path?' })
    return request.agent.id + ' complete'
  }).run('Build')
  assert.equal(result.status, 'completed')
  assert.deepEqual(executions, ['frontend', 'backend', 'frontend'])
})

test('review disagreement at the attempt limit remains exhausted, never completed', async () => {
  const result = await run(async request => {
    if (request.agent.role === 'orchestrator') return request.instructions.includes('Ready for review: true') ? ready : dispatch(request.attempt === 0)
    if (request.agent.role === 'security-reviewer') return JSON.stringify({ verdict: 'revise', feedback: 'Unsafe rendering' })
    if (request.agent.role === 'reviewer') return approved
    return 'draft'
  }, roster, 1).run('Build')
  assert.equal(result.status, 'exhausted')
  assert.equal(result.approved, false)
  assert.ok(result.messages?.some(message => message.from === 'security' && message.to === 'lead' && message.kind === 'review'))
})
