import React from 'react'
import { Box, Text } from 'ink'
import type { Config } from './config-file.js'
import { safeText, windowStart } from './tui-state.js'
import { formFields, roleFilters, rosterList, rowDetail, sidebarItems, type RoleFilter, type RosterForm, type RosterList, type RosterRow, type RosterSection, type SidebarItem } from './tui-roster.js'

// The `/agents` browser, laid out like omp's model picker: section sidebar | role chips, search, list, detail.
export interface AgentsState { kind: 'agents'; section: string; role: RoleFilter; query: string; index: number; form: RosterForm | null; field: number; confirmClose: boolean }
export interface AgentsView { items: SidebarItem[]; section: RosterSection; list: RosterList; index: number }

// Everything the key handler and the renderer need, derived once from the draft and the panel state.
export function agentsView(config: Config, state: AgentsState): AgentsView {
  const items = sidebarItems(config)
  const section = (items.find(item => item.key === state.section) ?? items[1]!).section
  const list = rosterList(config, section, state.role, state.query)
  return { items, section, list, index: Math.max(0, Math.min(state.index, list.rows.length - 1)) }
}

const SIDEBAR = 28
const roleColor: Record<string, string | undefined> = { all: undefined, worker: 'green', reviewer: 'yellow', router: 'magenta', planner: 'blue', designer: 'cyan', researcher: 'blue' }
const clip = (text: string, width: number) => Array.from(text).length > width ? `${Array.from(text).slice(0, Math.max(0, width - 1)).join('')}…` : text

function Sidebar({ view }: { view: AgentsView }) {
  const selected = view.items.findIndex(item => item.section === view.section)
  const line = (item: SidebarItem, index: number) => {
    const active = index === selected
    const icon = item.group === 'views' ? (item.key === 'harnesses' ? '⚙' : '≡') : item.registered ? '●' : '○'
    return <Box key={item.key} width={SIDEBAR} justifyContent="space-between">
      <Text wrap="truncate" color={active ? 'cyan' : undefined} bold={active}>{active ? '❯ ' : '  '}
        <Text color={item.group === 'types' ? item.registered ? 'green' : 'gray' : active ? 'cyan' : undefined}>{icon}</Text> {item.label}</Text>
      <Text dimColor>{item.count}</Text>
    </Box>
  }
  const views = view.items.filter(item => item.group === 'views')
  return <Box flexDirection="column" width={SIDEBAR} flexShrink={0}>
    <Text bold color="cyan">Agents</Text>
    {views.map(line)}
    <Text> </Text>
    {view.items.slice(views.length).map((item, offset) => line(item, views.length + offset))}
  </Box>
}

function Columns({ row, width }: { row: RosterRow; width: number }) {
  if (row.kind === 'add-agent' || row.kind === 'add-harness') return null
  const model = <Text dimColor>{clip(safeText(row.model), 26).padStart(26)}</Text>
  if (row.kind === 'harness') return <Text>{model}<Text dimColor>  {clip(safeText(row.note), 18).padEnd(18)}</Text></Text>
  return <Text>
    <Text color="magenta">{row.note ? '◆ ' : '  '}</Text>
    <Text color={roleColor[row.role!]}>{row.role!.padEnd(9)}</Text>
    {width >= 72 ? <Text dimColor>{(row.type ?? 'missing').padEnd(18)}</Text> : null}{model}
  </Text>
}

function List({ view, width, height }: { view: AgentsView; width: number; height: number }) {
  const { rows, separator } = view.list
  // Display lines: entries, a rule, then the section's add actions (the rule only when both halves exist).
  const lines: (RosterRow | null)[] = separator > 0 && separator < rows.length ? [...rows.slice(0, separator), null, ...rows.slice(separator)] : rows
  const selected = view.index + (separator > 0 && view.index >= separator ? 1 : 0)
  const start = windowStart(lines.length, selected, height)
  const overflow = lines.length > height
  const thumb = Math.max(1, Math.round(height * height / lines.length))
  const thumbStart = Math.round(start * (height - thumb) / Math.max(1, lines.length - height))
  return <Box flexDirection="column" height={height}>
    {lines.slice(start, start + height).map((row, offset) => {
      const bar = overflow && offset >= thumbStart && offset < thumbStart + thumb ? <Text color="cyan">▐</Text> : <Text> </Text>
      if (!row) return <Box key="separator"><Text dimColor>{'─'.repeat(Math.max(0, width - 2))}</Text><Text> </Text>{bar}</Box>
      const active = start + offset === selected
      const action = row.kind === 'add-agent' || row.kind === 'add-harness'
      return <Box key={`${row.kind}:${row.id}:${row.name}`} width={width}>
        <Box flexGrow={1} flexShrink={1}><Text wrap="truncate">
          <Text dimColor>{safeText(row.prefix)}</Text>
          <Text color={active ? 'cyan' : action ? 'green' : undefined} bold={active}>{safeText(row.name)}</Text>
        </Text></Box>
        <Box flexShrink={0} marginLeft={1}><Columns row={row} width={width} /></Box>
        <Text> </Text>{bar}
      </Box>
    })}
  </Box>
}

function Form({ config, state, notice, noticeError }: { config: Config; state: AgentsState; notice: string; noticeError: boolean }) {
  const form = state.form!
  const fields = formFields(config, form)
  const focused = Math.min(state.field, fields.length - 1)
  const labelWidth = Math.max(...fields.map(field => field.label.length)) + 2
  return <Box flexDirection="column">
    <Text bold>{form.original === null ? `Add ${form.target}` : `Edit ${form.target} `}<Text color="cyan">{form.original === null ? '' : safeText(form.original)}</Text></Text>
    <Text> </Text>
    {fields.map((field, index) => {
      const active = index === focused
      const position = field.options ? `  ${field.options.indexOf(field.value) + 1}/${field.options.length}` : ''
      return <Text key={field.key} wrap="truncate">
        <Text color={active ? 'cyan' : undefined}>{active ? '❯ ' : '  '}{field.label.padEnd(labelWidth)}</Text>
        {field.options
          ? <Text><Text dimColor>{active ? '‹ ' : '  '}</Text><Text color={field.value.startsWith('+ new') ? 'green' : roleColor[field.value]} bold={active}>{safeText(field.value) || 'none'}</Text><Text dimColor>{active ? ' ›' : ''}{position}</Text></Text>
          : <Text>{safeText(field.value)}{active ? <Text inverse> </Text> : null}</Text>}
      </Text>
    })}
    <Text> </Text>
    {notice ? <Text color={noticeError ? 'red' : 'green'} wrap="truncate">{notice}</Text> : null}
  </Box>
}

export function AgentsBrowser({ config, state, columns, rows, dirty, notice, noticeError, running }: {
  config: Config; state: AgentsState; columns: number; rows: number; dirty: boolean; notice: string; noticeError: boolean; running: boolean
}) {
  const view = agentsView(config, state)
  const sidebar = columns >= 80
  const width = columns - (sidebar ? SIDEBAR + 2 : 0) - 1
  const height = Math.max(14, rows - 2)
  // Right pane: title, chips, search, blank, list, blank, two detail lines, notice; the hint is the panel's last line.
  const listHeight = Math.max(3, height - 9)
  const [summary, secondary] = rowDetail(config, view.list.rows[view.index])
  const title = view.section.kind === 'agents' ? 'All agents' : view.section.kind === 'harnesses' ? 'Harness registrations' : `Agents on ${view.section.type}`
  const status = state.confirmClose
    ? <Text color="yellow" wrap="truncate">Unsaved changes — Enter save & close · Esc discard · any other key keeps editing</Text>
    : running ? <Text color="yellow" wrap="truncate">A run is active; saving is paused until it ends.</Text>
      : notice && !state.form ? <Text color={noticeError ? 'red' : 'green'} wrap="truncate">{notice}</Text> : <Text> </Text>
  const hint = state.form
    ? '↑/↓ field · type to edit · ←/→ choose · Enter apply · Esc back'
    : `←/→ section · ↑/↓ ${view.section.kind === 'harnesses' ? 'harnesses' : 'agents'} · type to search · Alt+←/Alt+→ role · Enter edit · Del remove · Ctrl+E save · Esc close`
  return <Box flexDirection="column" height={height}>
    <Box flexGrow={1}>
      {sidebar ? <Sidebar view={view} /> : null}
      <Box flexDirection="column" flexGrow={1} marginLeft={sidebar ? 2 : 0} width={width}>
        <Box justifyContent="space-between" width={width}>
          <Text bold wrap="truncate">{title}</Text>
          <Text color={dirty ? 'yellow' : 'green'}>{dirty ? '● unsaved changes' : 'saved'}</Text>
        </Box>
        {state.form ? <Form config={config} state={state} notice={notice} noticeError={noticeError} /> : <>
          <Text wrap="truncate"><Text dimColor>Role: </Text>
            {roleFilters.map(filter => filter === state.role
              ? <Text key={filter} backgroundColor="cyan" color="black" bold> {filter} </Text>
              : <Text key={filter} color={roleColor[filter]}> {filter} </Text>)}
            <Text dimColor>  Alt+←/Alt+→</Text></Text>
          <Text wrap="truncate"><Text color="cyan">⌕ </Text><Text dimColor>&gt; </Text>{safeText(state.query)}<Text inverse> </Text>
            {state.query ? null : <Text dimColor> type to search</Text>}</Text>
          <Text> </Text>
          <List view={view} width={width} height={listHeight} />
          <Text> </Text>
          <Text wrap="truncate">{safeText(summary)}</Text>
          <Text wrap="truncate" dimColor>{safeText(secondary)}</Text>
          {status}
        </>}
      </Box>
    </Box>
    <Text dimColor wrap="truncate">{hint}</Text>
  </Box>
}
