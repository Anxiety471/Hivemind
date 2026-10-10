import { spawn } from 'node:child_process'
import type { Harness, HarnessRequest } from './types.js'

export class HarnessRegistry {
  private entries = new Map<string, Harness>()
  register(id: string, harness: Harness): this {
    if (this.entries.has(id)) throw new Error(`Duplicate harness: ${id}`)
    this.entries.set(id, harness)
    return this
  }
  get(id: string): Harness {
    const harness = this.entries.get(id)
    if (!harness) throw new Error(`Unknown harness: ${id}`)
    return harness
  }
}

export interface ProcessOptions {
  command: string; args?: string[]; cwd?: string; maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
}
export function runProcess(options: ProcessOptions, stdin: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // Node does not update PWD when cwd is set; some CLIs (OpenCode 2.x) resolve the project from $PWD.
    const env = { ...process.env, ...options.env, ...(options.cwd ? { PWD: options.cwd } : {}) }
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd, env, shell: false, signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    const limit = options.maxOutputBytes ?? 1_048_576
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length
      if (bytes > limit) {
        failure = new Error('Harness output exceeded limit')
        child.kill('SIGKILL')
      } else (stdout ? chunks : stderrChunks).push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true))
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false))
    child.on('error', error => {
      reject(new Error(`Cannot run ${options.command}: ${error.message}`))
    })
    child.stdin.on('error', () => { /* close/error events report process failure */ })
    child.on('close', code => {
      if (failure) reject(failure)
      else if (code !== 0) {
        let detail = Buffer.concat(stderrChunks).toString('utf8').trim()
        if (!detail) {
          const stdout = Buffer.concat(chunks).toString('utf8').trim()
          // Terminal errors take priority; some CLIs only expose cancelled
          // forms through a failed tool event before successful final text.
          const lines = stdout.split(/\r?\n/).reverse()
          const errorEvent = lines.find(line => {
            try { return JSON.parse(line)?.type === 'error' } catch { return false }
          })
          const toolError = errorEvent === undefined ? lines.find(line => {
            try {
              const event = JSON.parse(line)
              return event?.type === 'tool_use' && event.part?.state?.status === 'error'
            } catch { return false }
          }) : undefined
          detail = errorEvent ?? toolError ?? stdout
        }
        const bounded = detail.length > 4096 ? `…${detail.slice(-4096)}` : detail
        reject(new Error(`Harness process exited with code ${code}${bounded ? `: ${bounded}` : ''}`))
      }
      else resolve(Buffer.concat(chunks).toString('utf8').trim())
    })
    child.stdin.end(stdin)
  })
}

// Generic protocol for user-written wrappers. Native adapters have their own protocols.
export class CommandHarness implements Harness {
  constructor(private options: ProcessOptions) {}
  run(request: HarnessRequest, signal: AbortSignal): Promise<string> {
    return runProcess(this.options, JSON.stringify(request) + '\n', signal)
  }
}

export class OpenAICompatibleHarness implements Harness {
  constructor(private options: { baseUrl: string; model: string; apiKeyEnv: string; maxTokens?: number }) {
    const url = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported API URL protocol')
  }
  async run(request: HarnessRequest, signal: AbortSignal): Promise<string> {
    const apiKey = process.env[this.options.apiKeyEnv]
    if (!apiKey) throw new Error(`Missing API key environment variable: ${this.options.apiKeyEnv}`)
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: this.options.model, max_tokens: this.options.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: request.instructions },
          { role: 'user', content: JSON.stringify({ task: request.task, artifact: request.artifact, feedback: request.feedback, attempt: request.attempt, messages: request.messages ?? [] }) },
        ],
      }),
    })
    if (!response.ok) throw new Error(`Model API returned HTTP ${response.status}`)
    const data = await response.json() as { choices?: { message?: { content?: unknown } }[] }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('Model API returned no text')
    return text
  }
}

export class DemoHarness implements Harness {
  async run(request: HarnessRequest): Promise<string> {
    if (request.agent.role === 'orchestrator') {
      const ready = request.instructions.includes('Ready for review: true')
      if (ready) return JSON.stringify({ action: 'review', reason: 'All workers returned completed artifacts.' })
      const roster = JSON.parse(request.instructions.split('Available agents: ')[1]!.split('\n')[0]!) as import('./types.js').Agent[]
      const worker = roster.find(agent => agent.role === 'worker')!
      return JSON.stringify({ action: 'dispatch', stages: [{ stage: 'work', tasks: [{ agent: worker.id, instructions: request.feedback || 'Complete the user task.' }] }], reason: 'Assign a worker.' })
    }
    if (request.agent.role === 'reviewer' || request.agent.role === 'security-reviewer') return JSON.stringify({
      verdict: request.attempt > 1 ? 'approved' : 'revise',
      feedback: request.attempt > 1 ? 'The demonstration revision meets the example requirements.' : 'Explain harness selection and the stopping rule.',
    })
    return request.attempt === 1
      ? `Draft for: ${request.task}\nHivemind coordinates agents with LangGraph.`
      : `Revised draft for: ${request.task}\nHivemind uses a decision → worker → review loop. Each agent selects a registered harness. Review approval allows completion; the attempt limit prevents endless execution.`
  }
}
