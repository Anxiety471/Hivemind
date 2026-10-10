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

// The wrapper owns each CLI's flags/session protocol. No shell interpolation.
export class CommandHarness implements Harness {
  constructor(private options: { command: string; args?: string[]; cwd?: string; maxOutputBytes?: number }) {}
  run(request: HarnessRequest, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd, shell: false, signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
      })
      const chunks: Buffer[] = []
      let bytes = 0
      let failure: Error | undefined
      const limit = this.options.maxOutputBytes ?? 1_048_576
      const collect = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length
        if (bytes > limit) {
          failure = new Error('Harness output exceeded limit')
          child.kill('SIGKILL')
        } else if (stdout) chunks.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, true))
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, false))
      child.on('error', reject)
      child.stdin.on('error', () => { /* close/error events report process failure */ })
      child.on('close', code => {
        if (failure) reject(failure)
        else if (code !== 0) reject(new Error(`Harness process exited with code ${code}`))
        else resolve(Buffer.concat(chunks).toString('utf8').trim())
      })
      child.stdin.end(JSON.stringify(request) + '\n')
    })
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
          { role: 'user', content: JSON.stringify({ task: request.task, artifact: request.artifact, feedback: request.feedback, attempt: request.attempt }) },
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
    if (request.agent.role === 'reviewer') return JSON.stringify({
      verdict: request.attempt > 1 ? 'approved' : 'revise',
      feedback: request.attempt > 1 ? 'The demonstration revision meets the example requirements.' : 'Explain harness selection and the stopping rule.',
    })
    return request.attempt === 1
      ? `Draft for: ${request.task}\nHivemind coordinates agents with LangGraph.`
      : `Revised draft for: ${request.task}\nHivemind uses a decision → worker → review loop. Each agent selects a registered harness. Review approval allows completion; the attempt limit prevents endless execution.`
  }
}
