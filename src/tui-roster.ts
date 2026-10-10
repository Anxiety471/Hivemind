import { z } from 'zod'
import { addAgent, addHarness, removeAgent, removeHarness, updateAgent, updateHarness, type Config } from './config-file.js'

// Pure state for the `/agents` panel: a roster of agents and harness registrations, and the add/edit forms.
type HarnessSettings = Config['harnesses'][string]
type AgentEntry = Config['agents'][number]
export type HarnessType = HarnessSettings['type']
export const harnessTypes: readonly HarnessType[] = ['pi', 'opencode', 'command', 'openai-compatible', 'demo']
const roles = ['worker', 'reviewer', 'router', 'planner', 'designer', 'researcher'] as const
const thinkingLevels = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
// Harness types the agent form can create inline: they need no settings beyond an optional model.
const quickTypes: readonly HarnessType[] = ['pi', 'opencode', 'demo']
const NEW = '+ new '

function modelOf(settings: HarnessSettings | undefined): string {
  if (!settings) return ''
  return settings.type === 'command' ? settings.command : 'model' in settings && settings.model ? settings.model : ''
}

// The `/agents` browser, modelled on omp's model picker: a sidebar of sections, a role filter, search, a list, and a detail footer.
export type RosterSection = { kind: 'agents' } | { kind: 'harnesses' } | { kind: 'type'; type: HarnessType }
export const roleFilters = ['all', ...roles] as const
export type RoleFilter = typeof roleFilters[number]
export interface SidebarItem { key: string; section: RosterSection; label: string; count: string; group: 'views' | 'types'; registered: boolean }

export function sidebarItems(config: Config): SidebarItem[] {
  const harnesses = Object.entries(config.harnesses)
  const used = harnesses.filter(([id]) => config.agents.some(agent => agent.harness === id)).length
  const types = harnessTypes.map(type => {
    const agents = config.agents.filter(agent => config.harnesses[agent.harness]?.type === type).length
    const registered = harnesses.some(([, settings]) => settings.type === type)
    return { key: `type:${type}`, section: { kind: 'type' as const, type }, label: type, count: agents ? String(agents) : '', group: 'types' as const, registered }
  })
  // Fixed order so sections never move under the cursor while editing; the dot shows which types are registered.
  return [
    { key: 'harnesses', section: { kind: 'harnesses' }, label: 'Harnesses', count: `${used}/${harnesses.length}`, group: 'views', registered: true },
    { key: 'agents', section: { kind: 'agents' }, label: 'All agents', count: String(config.agents.length), group: 'views', registered: true },
    ...types,
  ]
}

export interface RosterRow {
  kind: 'agent' | 'harness' | 'add-agent' | 'add-harness'; id: string
  prefix: string; name: string; role?: AgentEntry['role']; type?: HarnessType; model: string; note: string; preset?: HarnessType
}
export interface RosterList { rows: RosterRow[]; separator: number }

// Matching entries above the separator, the section's add actions below it.
export function rosterList(config: Config, section: RosterSection, role: RoleFilter, query: string): RosterList {
  const needle = query.trim().toLowerCase()
  const matches = (...texts: string[]) => !needle || texts.some(text => text.toLowerCase().includes(needle))
  if (section.kind === 'harnesses') {
    const rows = Object.entries(config.harnesses).map(([id, settings]): RosterRow => {
      const users = config.agents.filter(agent => agent.harness === id)
      return { kind: 'harness', id, prefix: `${settings.type}/`, name: id, type: settings.type, model: modelOf(settings),
        note: users.length ? users.map(agent => agent.id).join(', ') : 'unused' }
    }).filter(row => (role === 'all' || config.agents.some(agent => agent.harness === row.id && agent.role === role)) && matches(row.prefix + row.name, row.model, row.note))
    return { rows: [...rows, { kind: 'add-harness', id: '', prefix: '', name: '+ Add harness', model: '', note: '' }], separator: rows.length }
  }
  const type = section.kind === 'type' ? section.type : undefined
  const rows = config.agents.flatMap((agent): RosterRow[] => {
    const settings = config.harnesses[agent.harness]
    if (type && settings?.type !== type) return []
    const note = config.router.type === 'model' && config.router.agent === agent.id ? 'routes' : ''
    return [{ kind: 'agent', id: agent.id, prefix: `${agent.harness}/`, name: agent.id, role: agent.role, type: settings?.type, model: modelOf(settings), note }]
  }).filter(row => (role === 'all' || row.role === role) && matches(row.prefix + row.name, row.role!, row.type ?? '', row.model, config.agents.find(agent => agent.id === row.id)!.description))
  const actions: RosterRow[] = !type ? [{ kind: 'add-agent', id: '', prefix: '', name: '+ Add agent', model: '', note: '' }] : [
    ...quickTypes.includes(type) || Object.values(config.harnesses).some(settings => settings.type === type)
      ? [{ kind: 'add-agent' as const, id: '', prefix: '', name: `+ Add ${type} agent`, model: '', note: '', preset: type }] : [],
    { kind: 'add-harness', id: '', prefix: '', name: `+ Add ${type} harness`, model: '', note: '', preset: type },
  ]
  return { rows: [...rows, ...actions], separator: rows.length }
}

// The detail footer for the highlighted row: a summary line and a secondary line.
export function rowDetail(config: Config, row: RosterRow | undefined): [string, string] {
  if (!row) return ['No matches', 'Backspace or Esc clears the search']
  if (row.kind === 'agent') {
    const agent = config.agents.find(candidate => candidate.id === row.id)!
    const settings = config.harnesses[agent.harness]
    const cwd = settings && 'cwd' in settings && settings.cwd ? ` · cwd ${settings.cwd}` : ''
    return [[agent.id, agent.role, agent.harness, row.type ?? 'missing harness', row.model].filter(Boolean).join(' · ') + cwd,
      `${row.note ? 'model router · ' : ''}${agent.description || 'No description — the model router reads it when choosing a worker'}`]
  }
  if (row.kind === 'harness') {
    const settings = config.harnesses[row.id]!
    const cwd = 'cwd' in settings && settings.cwd ? ` · cwd ${settings.cwd}` : ''
    return [[row.id, settings.type, row.model].filter(Boolean).join(' · ') + cwd, row.note === 'unused' ? 'Not used by any agent' : `Used by ${row.note}`]
  }
  if (row.kind === 'add-agent') {
    return [row.preset ? `New agent on ${row.preset}` : 'New agent', row.preset && quickTypes.includes(row.preset)
      ? `Registers a new ${row.preset} harness for it, or pick an existing one` : 'Runs on an existing harness or a new pi, opencode, or demo harness']
  }
  return [row.preset ? `New ${row.preset} harness` : 'New harness registration', 'Agents can share it; each harness keeps its own model and settings']
}

export interface FormField { key: string; label: string; value: string; options?: readonly string[] }
export interface RosterForm { target: 'agent' | 'harness'; original: string | null; values: Record<string, string> }

// Text form of each editable harness setting; arrays are comma-separated (tools) or space-separated (argv).
const harnessFieldSpecs: Record<HarnessType, readonly { key: string; label: string; options?: readonly string[] }[]> = {
  demo: [],
  opencode: [{ key: 'model', label: 'Model (provider/model)' }, { key: 'agent', label: 'OpenCode agent' }, { key: 'variant', label: 'Variant' },
    { key: 'cwd', label: 'Working dir (relative to project)' }, { key: 'executable', label: 'Executable' }],
  pi: [{ key: 'model', label: 'Model' }, { key: 'provider', label: 'Provider' }, { key: 'thinking', label: 'Thinking', options: thinkingLevels },
    { key: 'tools', label: 'Tools (comma-separated)' }, { key: 'cwd', label: 'Working dir (relative to project)' }, { key: 'executable', label: 'Executable' }],
  command: [{ key: 'command', label: 'Command' }, { key: 'args', label: 'Arguments (space-separated)' }, { key: 'cwd', label: 'Working dir (relative to project)' }],
  'openai-compatible': [{ key: 'baseUrl', label: 'Base URL' }, { key: 'model', label: 'Model' }, { key: 'apiKeyEnv', label: 'API key env var' }, { key: 'maxTokens', label: 'Max tokens' }],
}
const listKeys: Record<string, string> = { tools: ',', args: ' ' }
function fieldText(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.join(listKeys[key] === ',' ? ', ' : ' ')
  return value === undefined ? '' : String(value)
}
function quickType(form: RosterForm): HarnessType | null {
  return form.values.harness?.startsWith(NEW) ? form.values.harness.slice(NEW.length) as HarnessType : null
}

// `preset` opens the form on that harness type: a new harness of it when it can be created inline, else its first registration.
export function newAgentForm(config: Config, preset?: HarnessType): RosterForm {
  const existing = Object.keys(config.harnesses)
  const harness = preset
    ? quickTypes.includes(preset) ? `${NEW}${preset}` : existing.find(id => config.harnesses[id]!.type === preset) ?? `${NEW}pi`
    : existing[0] ?? `${NEW}pi`
  return { target: 'agent', original: null, values: { id: '', role: 'worker', harness, model: '', description: '' } }
}
export function editAgentForm(config: Config, agentId: string): RosterForm {
  const agent = config.agents.find(candidate => candidate.id === agentId)
  if (!agent) throw new Error(`Unknown agent "${agentId}"`)
  return { target: 'agent', original: agentId, values: { id: agent.id, role: agent.role, harness: agent.harness, model: '', description: agent.description } }
}
export function newHarnessForm(type: HarnessType = 'pi'): RosterForm {
  return { target: 'harness', original: null, values: { id: '', type } }
}
export function editHarnessForm(config: Config, harnessId: string): RosterForm {
  const settings = config.harnesses[harnessId]
  if (!settings) throw new Error(`Unknown harness "${harnessId}"`)
  const values: Record<string, string> = { id: harnessId, type: settings.type }
  for (const spec of harnessFieldSpecs[settings.type]) values[spec.key] = fieldText(spec.key, (settings as Record<string, unknown>)[spec.key])
  return { target: 'harness', original: harnessId, values }
}

// The visible fields of a form. Their set depends on the current choices (harness type, inline harness creation).
export function formFields(config: Config, form: RosterForm): FormField[] {
  const value = (key: string) => form.values[key] ?? ''
  if (form.target === 'agent') {
    const harnessOptions = [...Object.keys(config.harnesses), ...quickTypes.map(type => `${NEW}${type}`)]
    const quick = quickType(form)
    return [
      { key: 'id', label: 'Agent id', value: value('id') },
      { key: 'role', label: 'Role', value: value('role'), options: roles },
      { key: 'harness', label: 'Harness', value: value('harness'), options: harnessOptions },
      ...quick && quick !== 'demo' ? [{ key: 'model', label: `New ${quick} model (optional)`, value: value('model') }] : [],
      { key: 'description', label: 'Description (the router reads it)', value: value('description') },
    ]
  }
  return [
    { key: 'id', label: 'Harness id', value: value('id') },
    { key: 'type', label: 'Type', value: value('type'), options: harnessTypes },
    ...harnessFieldSpecs[form.values.type as HarnessType].map(spec => ({ ...spec, value: value(spec.key) })),
  ]
}

export function cycleField(config: Config, form: RosterForm, key: string, delta: number): RosterForm {
  const field = formFields(config, form).find(candidate => candidate.key === key)
  if (!field?.options?.length) return form
  const index = field.options.indexOf(field.value)
  const next = field.options[((index < 0 ? 0 : index + delta) % field.options.length + field.options.length) % field.options.length]!
  return { ...form, values: { ...form.values, [key]: next } }
}
export function typeIntoField(form: RosterForm, key: string, edit: (value: string) => string): RosterForm {
  return { ...form, values: { ...form.values, [key]: edit(form.values[key] ?? '') } }
}

function requireId(value: string | undefined, what: string): string {
  const id = (value ?? '').trim()
  if (!id) throw new Error(`${what} id is required`)
  if (/\s/.test(id)) throw new Error(`${what} id cannot contain spaces`)
  return id
}
function uniqueHarnessId(config: Config, base: string): string {
  if (!Object.hasOwn(config.harnesses, base)) return base
  let suffix = 2
  while (Object.hasOwn(config.harnesses, `${base}-${suffix}`)) suffix++
  return `${base}-${suffix}`
}
function harnessSettings(config: Config, form: RosterForm): HarnessSettings {
  const type = form.values.type as HarnessType
  const previous = form.original ? config.harnesses[form.original] : undefined
  // Keep settings the form does not show (maxOutputBytes, executableArgs, …) when the type is unchanged.
  const settings: Record<string, unknown> = previous?.type === type ? structuredClone(previous) : { type }
  for (const spec of harnessFieldSpecs[type]) {
    const text = (form.values[spec.key] ?? '').trim()
    // An unedited list keeps its exact original items, even ones containing the separator.
    if (previous?.type === type && text === fieldText(spec.key, (previous as Record<string, unknown>)[spec.key]).trim()) continue
    if (!text) { delete settings[spec.key]; continue }
    const separator = listKeys[spec.key]
    settings[spec.key] = separator ? text.split(separator === ',' ? /\s*,\s*/ : /\s+/).filter(Boolean)
      : spec.key === 'maxTokens' ? Number(text) : text
  }
  return settings as HarnessSettings
}

// Apply a submitted form to the draft config; throws a readable message when the result is invalid.
export function applyForm(config: Config, form: RosterForm): Config {
  try {
    if (form.target === 'harness') {
      const id = requireId(form.values.id, 'Harness')
      const settings = harnessSettings(config, form)
      return form.original === null ? addHarness(config, id, settings) : updateHarness(config, form.original, id, settings)
    }
    const id = requireId(form.values.id, 'Agent')
    let next = config
    let harness = form.values.harness ?? ''
    const quick = quickType(form)
    if (quick) {
      harness = uniqueHarnessId(config, `${id}-${quick}`)
      const model = (form.values.model ?? '').trim()
      next = addHarness(next, harness, (quick !== 'demo' && model ? { type: quick, model } : { type: quick }) as HarnessSettings)
    }
    const agent: AgentEntry = { id, role: form.values.role as AgentEntry['role'], harness, description: (form.values.description ?? '').trim() }
    if (form.original !== null && config.router.type === 'model' && config.router.agent === form.original && agent.role !== 'router')
      throw new Error(`"${form.original}" is the model router; switch the router before changing its role`)
    return form.original === null ? addAgent(next, agent) : updateAgent(next, form.original, agent)
  } catch (caught) { throw readable(caught) }
}

export function removeRow(config: Config, row: RosterRow): Config {
  try {
    if (row.kind === 'harness') return removeHarness(config, row.id)
    if (row.kind !== 'agent') return config
    if (config.router.type === 'model' && config.router.agent === row.id) throw new Error(`Cannot remove "${row.id}": it is the model router; switch the router first`)
    return removeAgent(config, row.id)
  } catch (caught) { throw readable(caught) }
}

function readable(caught: unknown): Error {
  if (caught instanceof z.ZodError) return new Error(caught.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; '))
  return caught instanceof Error ? caught : new Error(String(caught))
}
