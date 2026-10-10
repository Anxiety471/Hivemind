// A subprocess protocol fixture, not an AI model. Captures argv/stdin and emits native JSONL.
import { readFile, writeFile } from 'node:fs/promises'
const [kind, capture, scenario, ...args] = process.argv.slice(2)
if (!kind || !capture || !scenario) throw new Error('Missing fixture arguments')
const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const stdin = Buffer.concat(chunks).toString('utf8')
await writeFile(capture, JSON.stringify({ args, stdin, cwd: process.cwd() }))
const sources = JSON.parse(await readFile(`${capture}.sources`, 'utf8').catch(() => '[]'))
const explicitFile = process.env.OPENCODE_CONFIG
if (explicitFile) sources.push({ type: 'document', path: explicitFile, info: JSON.parse(await readFile(explicitFile, 'utf8')) })
let inline = {}
try {
  inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  if (process.env.OPENCODE_CONFIG_CONTENT !== undefined) sources.push({ type: 'document', info: inline })
} catch { /* OpenCode drops malformed inline documents from its source list. */ }
if (kind === 'opencode' && args[0] === 'api') {
  if (!args.includes('--standalone')) throw new Error('Config lookup must own its server')
  if (!args.includes(`location[directory]=${process.cwd()}`)) throw new Error('Config lookup must use the run location')
  process.stdout.write(JSON.stringify([{ type: 'directory', path: '/fixture/global' }, ...sources]))
  process.exit(0)
}
if (scenario === 'exit') process.exit(7)
if (scenario === 'hang') await new Promise(() => {})
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n')
const terminalError = { type: 'error', error: { name: 'APIError', data: { message: 'Provider quota exhausted' } } }
if (kind === 'opencode' && scenario === 'websearch') {
  // Model OpenCode 2's initialization boundary: a managed server keeps its old
  // configuration, whereas an owned standalone server reads the child's env.
  const fileConfig = Object.assign({}, ...sources.filter((source: { type: string }) => source.type === 'document').map((source: { info: object }) => source.info))
  const config = args.includes('--standalone')
    ? { ...fileConfig, ...inline }
    : JSON.parse(await readFile(`${capture}.managed`, 'utf8').catch(() => '{}'))
  await writeFile(`${capture}.initialized`, JSON.stringify(config))
  if (config.websearch === false) {
    emit({ type: 'tool_use', part: { tool: 'websearch', state: { status: 'disabled' } } })
  } else if (config.websearch?.provider) {
    emit({ type: 'tool_use', part: { tool: 'websearch', state: { status: 'completed', output: `Selected ${config.websearch.provider}` } } })
  } else {
    // A provider form is cancelled by the noninteractive runner, even though
    // it subsequently emits a successful final assistant message.
    emit({ type: 'form.created', metadata: { kind: 'websearch.provider' } })
    emit({ type: 'tool_use', part: { tool: 'websearch', state: { status: 'error', error: { message: 'Web search cancelled' } } } })
    process.exitCode = 1
  }
}
if (scenario === 'stderr-exit' || scenario === 'stdout-exit' || scenario === 'bounded-exit') {
  emit(terminalError)
  if (scenario !== 'stdout-exit') {
    process.stderr.write(`${scenario === 'bounded-exit' ? 'x'.repeat(6000) : ''}Credentials rejected by provider\n`)
  }
  process.exitCode = 7
} else if (scenario === 'output-limit') {
  process.stdout.write('x'.repeat(600))
  process.stderr.write('y'.repeat(600))
  process.exitCode = 7
} else {
  const context = JSON.parse(stdin.slice(stdin.lastIndexOf('\n{')).trim()) as { attempt: number }
  const text = stdin.startsWith('You are the orchestrator agent')
    ? JSON.stringify(stdin.includes('Ready for review: true') ? { action: 'review', reason: 'Ready' } : { action: 'dispatch', stages: [{ stage: 'work', tasks: [{ agent: (JSON.parse(stdin.split('Available agents: ')[1]!.split('\n')[0]!) as { id: string; role: string }[]).find(agent => agent.role === 'worker')!.id, instructions: 'Write the artifact' }] }], reason: 'Assign worker' })
    : scenario === 'review' ? JSON.stringify({ verdict: context.attempt === 1 ? 'revise' : 'approved', feedback: 'Native adapter review' }) : 'Final native artifact'
  if (kind === 'opencode') {
    emit({ type: 'step_start', part: { messageID: 'intermediate' } })
    emit({ type: 'text', part: { type: 'text', id: 'intro', messageID: 'intermediate', text: 'Thinking about the task' } })
    emit({ type: 'tool_use', part: { tool: 'read', state: { output: 'tool output' } } })
    emit({ type: 'step_finish', part: { messageID: 'intermediate', reason: 'tool-calls' } })
    emit({ type: 'text', part: { type: 'text', id: 'answer', messageID: 'final', text } })
    emit({ type: 'step_finish', part: { messageID: 'final', reason: scenario === 'truncated' ? 'length' : 'stop' } })
    if (scenario === 'error') emit(terminalError)
  } else {
    emit({ type: 'session', version: 3, id: 'fixture' })
    emit({ type: 'agent_start' })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial text' } })
    emit({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool result' }] } })
    const message = { role: 'assistant', stopReason: scenario === 'error' ? 'error' : scenario === 'truncated' ? 'length' : 'stop', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text }] }
    emit({ type: 'message_end', message })
    emit({ type: 'agent_end', messages: [message] })
    if (scenario === 'error') emit(terminalError)
  }
  if (scenario === 'success-exit') process.exitCode = 7
}
