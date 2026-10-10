import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { render } from 'ink-testing-library'
import { HivemindTui, type TuiProps } from '../src/tui.js'
import { configSchema, fromConfig } from '../src/config.js'
import { createHivemind, type Progress } from '../src/graph.js'
import { DemoHarness, HarnessRegistry } from '../src/harnesses.js'
import { RuleRouter } from '../src/routers.js'
import { pageLines, safeText, selectWorker } from '../src/tui-state.js'
const config = configSchema.parse({ harnesses: { demo: { type: 'demo' }, alternate: { type: 'demo' } },
  agents: [{ id: 'writer', role: 'worker', harness: 'demo' }, { id: 'second', role: 'worker', harness: 'alternate' }, { id: 'reviewer', role: 'reviewer', harness: 'demo' }], router: { type: 'rule' } })
async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) {
    if (Date.now() > end) throw new Error('UI did not reach expected state')
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}
test('TUI accepts a task, completes a real graph loop, and shows session history', async () => {
  const app = render(<HivemindTui config={config} configPath="demo.json" />)
  try {
    await waitFor(() => !!app.lastFrame()?.includes('Describe the task'))
    app.stdin.write('Write a project introduction')
    await waitFor(() => !!app.lastFrame()?.includes('Write a project introduction'))
    app.stdin.write('\r')
    await waitFor(() => !!app.lastFrame()?.includes('completed'))
    assert.match(app.lastFrame()!, /Revised draft/)
    assert.match(app.lastFrame()!, /review #2/)
    app.stdin.write('\x19') // Ctrl+Y
    await waitFor(() => !!app.lastFrame()?.includes('You: Write a project introduction'))
    assert.match(app.lastFrame()!, /Demo adapter active/)
  } finally { app.unmount(); app.cleanup() }
})
test('TUI changes worker and harness selection before submitting', async () => {
  let selected: unknown
  const runner: TuiProps['runner'] = (input, controls) => { selected = input; return fromConfig(input, controls) }
  const app = render(<HivemindTui config={config} configPath="demo.json" initialTask="Test selection" runner={runner} />)
  try {
    await waitFor(() => !!app.lastFrame()?.includes('Test selection'))
    app.stdin.write('\t') // task -> worker
    await new Promise(resolve => setTimeout(resolve, 20))
    app.stdin.write('\x1b[C')
    await waitFor(() => !!app.lastFrame()?.includes('Worker: second'))
    app.stdin.write('\t') // worker -> harness
    await new Promise(resolve => setTimeout(resolve, 20))
    app.stdin.write('\x1b[C') // alternate -> demo
    await waitFor(() => !!app.lastFrame()?.includes('Harness: demo'))
    app.stdin.write('\t')
    await new Promise(resolve => setTimeout(resolve, 20))
    app.stdin.write('\r')
    await waitFor(() => !!app.lastFrame()?.includes('completed'))
    const parsed = configSchema.parse(selected)
    assert.deepEqual(parsed.agents.filter(a => a.role === 'worker').map(a => [a.id, a.harness]), [['second', 'demo']])
    assert.equal(config.agents[0]!.harness, 'demo')
  } finally { app.unmount(); app.cleanup() }
})
test('TUI Escape aborts an active harness and stays open for another task', async () => {
  let aborted = false
  const runner: TuiProps['runner'] = (input, controls) => {
    const parsed = configSchema.parse(input)
    return createHivemind({ ...controls, agents: parsed.agents, router: new RuleRouter(), timeoutMs: 5000,
      harnesses: new HarnessRegistry().register('demo', { run(request, signal) {
        if (request.agent.role === 'reviewer') return new DemoHarness().run(request)
        signal.addEventListener('abort', () => { aborted = true }, { once: true })
        return new Promise(() => {})
      } }).register('alternate', new DemoHarness()),
    })
  }
  const app = render(<HivemindTui config={config} configPath="demo.json" initialTask="Wait for cancellation" runner={runner} />)
  try {
    await waitFor(() => !!app.lastFrame()?.includes('Ready'))
    app.stdin.write('\r')
    await waitFor(() => !!app.lastFrame()?.includes('Working'))
    app.stdin.write('\x1b')
    await waitFor(() => !!app.lastFrame()?.includes('Cancelled'))
    assert.equal(aborted, true)
    assert.match(app.lastFrame()!, /Esc: quit/)
  } finally { app.unmount(); app.cleanup() }
})
test('progress observers receive ordered live start/end updates without changing graph history', async () => {
  const updates: Progress[] = []
  const result = await fromConfig(config, { onProgress: update => updates.push(update) }).run('Write')
  assert.equal(result.status, 'completed')
  assert.deepEqual(updates.slice(0, 4).map(u => `${u.node}:${u.phase}`), ['decide:start', 'decide:end', 'work:start', 'work:end'])
  assert.equal(updates.filter(u => u.phase === 'end').length, result.events.length)
  assert.ok(updates.some(u => u.artifact?.includes('Revised draft')))
})
test('selection validates IDs and terminal text removes escape sequences', () => {
  assert.throws(() => selectWorker(config, 'missing', 'demo'))
  assert.throws(() => selectWorker(config, 'writer', 'missing'))
  assert.equal(safeText('\x1b[31mhello\x1b[0m\x1b]52;c;payload\x07'), 'hello')
  assert.deepEqual(pageLines('123456\nend', 3), ['123', '456', 'end'])
})
