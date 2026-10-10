// A subprocess protocol fixture, not an AI model. Captures argv/stdin and emits native JSONL.
import { writeFile } from 'node:fs/promises'
const [kind, capture, scenario, ...args] = process.argv.slice(2)
if (!kind || !capture || !scenario) throw new Error('Missing fixture arguments')
const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const stdin = Buffer.concat(chunks).toString('utf8')
await writeFile(capture, JSON.stringify({ args, stdin, cwd: process.cwd() }))
if (scenario === 'exit') process.exit(7)
if (scenario === 'hang') await new Promise(() => {})
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n')
const context = JSON.parse(stdin.slice(stdin.lastIndexOf('\n{')).trim()) as { attempt: number }
const text = scenario === 'review' ? JSON.stringify({ verdict: context.attempt === 1 ? 'revise' : 'approved', feedback: 'Native adapter review' }) : 'Final native artifact'
if (kind === 'opencode') {
  emit({ type: 'step_start', part: { messageID: 'intermediate' } })
  emit({ type: 'text', part: { type: 'text', id: 'intro', messageID: 'intermediate', text: 'Thinking about the task' } })
  emit({ type: 'tool_use', part: { tool: 'read', state: { output: 'tool output' } } })
  emit({ type: 'step_finish', part: { messageID: 'intermediate', reason: 'tool-calls' } })
  emit({ type: 'text', part: { type: 'text', id: 'answer', messageID: 'final', text } })
  emit({ type: 'step_finish', part: { messageID: 'final', reason: scenario === 'truncated' ? 'length' : 'stop' } })
  if (scenario === 'error') emit({ type: 'error', error: { name: 'APIError' } })
} else {
  emit({ type: 'session', version: 3, id: 'fixture' })
  emit({ type: 'agent_start' })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial text' } })
  emit({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool result' }] } })
  const message = { role: 'assistant', stopReason: scenario === 'error' ? 'error' : scenario === 'truncated' ? 'length' : 'stop', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text }] }
  emit({ type: 'message_end', message })
  emit({ type: 'agent_end', messages: [message] })
}
