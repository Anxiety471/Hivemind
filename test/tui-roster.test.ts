import assert from 'node:assert/strict'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { applyForm, cycleField, editAgentForm, editHarnessForm, formFields, newAgentForm, newHarnessForm, removeRow, rosterList, sidebarItems, typeIntoField, type RosterList } from '../src/tui-roster.js'

const config = configSchema.parse({
  harnesses: {
    cli: { type: 'command', command: 'node', args: ['my script.ts', '--flag'], maxOutputBytes: 1024 },
    brain: { type: 'pi', model: 'sonnet' },
  },
  agents: [
    { id: 'writer', role: 'worker', harness: 'cli' },
    { id: 'checker', role: 'reviewer', harness: 'cli' },
    { id: 'jev', role: 'router', harness: 'brain' },
  ],
  router: { type: 'model', agent: 'jev' },
})

test('renaming a harness carries every agent that used it to the new id', () => {
  const form = typeIntoField(editHarnessForm(config, 'cli'), 'id', () => 'runner')
  const next = applyForm(config, form)
  assert.deepEqual(Object.keys(next.harnesses), ['runner', 'brain'])
  assert.deepEqual(next.agents.map(agent => agent.harness), ['runner', 'runner', 'brain'])
})

test('editing a harness keeps hidden settings and unedited list items that contain the separator', () => {
  const next = applyForm(config, typeIntoField(editHarnessForm(config, 'cli'), 'cwd', () => 'packages/web'))
  assert.deepEqual(next.harnesses.cli, { type: 'command', command: 'node', args: ['my script.ts', '--flag'], maxOutputBytes: 1024, cwd: 'packages/web' })
  const retyped = applyForm(config, typeIntoField(editHarnessForm(config, 'cli'), 'args', () => 'a.ts  b'))
  assert.deepEqual(retyped.harnesses.cli, { type: 'command', command: 'node', args: ['a.ts', 'b'], maxOutputBytes: 1024 })
})

test('changing harness type swaps the visible fields and drops the old type settings', () => {
  const form = cycleField(config, editHarnessForm(config, 'cli'), 'type', 1) // command → openai-compatible
  assert.deepEqual(formFields(config, form).map(field => field.key), ['id', 'type', 'baseUrl', 'model', 'apiKeyEnv', 'maxTokens'])
  let filled = form
  for (const [key, value] of [['baseUrl', 'https://x.test/v1'], ['model', 'm'], ['apiKeyEnv', 'KEY'], ['maxTokens', '99']]) filled = typeIntoField(filled, key!, () => value!)
  assert.deepEqual(applyForm(config, filled).harnesses.cli, { type: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'm', apiKeyEnv: 'KEY', maxTokens: 99 })
})

test('invalid harness forms report readable field errors', () => {
  const pi = typeIntoField(typeIntoField(newHarnessForm(), 'id', () => 'p'), 'provider', () => 'anthropic')
  assert.throws(() => applyForm(config, pi), /Pi provider requires a model/)
  assert.throws(() => applyForm(config, newHarnessForm()), /Harness id is required/)
  assert.throws(() => applyForm(config, typeIntoField(newHarnessForm(), 'id', () => 'brain')), /Harness "brain" already exists/)
})

test('the model router agent follows renames and cannot be demoted or removed', () => {
  const renamed = applyForm(config, typeIntoField(editAgentForm(config, 'jev'), 'id', () => 'planner'))
  assert.deepEqual(renamed.router, { type: 'model', agent: 'planner' })
  assert.throws(() => applyForm(config, cycleField(config, editAgentForm(config, 'jev'), 'role', 1)), /is the model router/)
  const jevRow = rosterList(config, { kind: 'agents' }, 'all', '').rows.find(row => row.id === 'jev')!
  assert.throws(() => removeRow(config, jevRow), /is the model router/)
})

test('inline harness creation picks a free id instead of overwriting', () => {
  const crowded = applyForm(config, typeIntoField(typeIntoField(newHarnessForm(), 'id', () => 'extra-pi'), 'model', () => 'm'))
  let form = typeIntoField(editAgentForm(crowded, 'writer'), 'id', () => 'extra')
  while (form.values.harness !== '+ new pi') form = cycleField(crowded, form, 'harness', 1)
  const next = applyForm(crowded, form)
  assert.equal(next.agents[0]!.harness, 'extra-pi-2')
  assert.deepEqual(next.harnesses['extra-pi'], crowded.harnesses['extra-pi'])
})

test('sidebar lists views, then every harness type in a fixed order with registration and agent counts', () => {
  assert.deepEqual(sidebarItems(config).map(item => [item.label, item.count, item.registered]), [
    ['Harnesses', '2/2', true], ['All agents', '3', true],
    ['pi', '1', true], ['opencode', '', false], ['command', '2', true], ['openai-compatible', '', false], ['demo', '', false],
  ])
})

test('the list filters by section, role, and search, with add actions below the separator', () => {
  const names = (list: RosterList) => list.rows.map(row => `${row.prefix}${row.name}`)
  assert.deepEqual(names(rosterList(config, { kind: 'agents' }, 'worker', '')), ['cli/writer', '+ Add agent'])
  assert.deepEqual(names(rosterList(config, { kind: 'agents' }, 'all', 'SONNET')), ['brain/jev', '+ Add agent'])
  const command = rosterList(config, { kind: 'type', type: 'command' }, 'all', '')
  assert.deepEqual(names(command), ['cli/writer', 'cli/checker', '+ Add command agent', '+ Add command harness'])
  assert.equal(command.separator, 2)
  const pi = rosterList(config, { kind: 'type', type: 'pi' }, 'all', 'nothing')
  assert.deepEqual(pi.rows.map(row => [row.kind, row.preset]), [['add-agent', 'pi'], ['add-harness', 'pi']])
  assert.equal(newAgentForm(config, 'pi').values.harness, '+ new pi')
  assert.equal(newAgentForm(config, 'command').values.harness, 'cli')
  assert.deepEqual(names(rosterList(config, { kind: 'harnesses' }, 'router', '')), ['pi/brain', '+ Add harness'])
})
