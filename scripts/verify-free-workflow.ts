/** Live acceptance run. No mock harnesses: every role calls the installed OpenCode 2 CLI. */
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HarnessRegistry } from '../src/harnesses.js'
import { OpenCodeHarness } from '../src/native-harnesses.js'
import { ModelRouter } from '../src/routers.js'
import { createHivemind, type Progress } from '../src/graph.js'
import type { Agent, HarnessRequest } from '../src/types.js'

const output = path.resolve(process.argv[2] ?? 'docs/evidence/free-opencode')
const project = await mkdtemp(path.join(tmpdir(), 'hivemind-live-'))
const model = process.env.HIVEMIND_FREE_MODEL ?? 'opencode/mimo-v2.6-flash-free'
const executable = process.env.OPENCODE_EXECUTABLE ?? 'opencode'
const task = process.env.HIVEMIND_LIVE_TASK ?? `Build and verify a tiny notes web app in the current workspace using only Node built-ins and static HTML/CSS/JS (no dependencies).
The backend serves GET /api/notes and accepts POST /api/notes with a JSON {text} field, with input validation and a 4096-byte body limit. Notes are in memory. Serve index.html at /. Bind to 127.0.0.1, default port 4319, configurable through PORT.
The frontend has a labelled text input, an add button and a notes list. Use textContent to display notes, never insert user input with innerHTML. Keep a clean, readable design.
Researcher and Designer MUST run asynchronously/independently in the same preparation batch. Researcher writes RESEARCH.md (API contract and risks). Designer writes DESIGN.md (UI contract). Planner must receive BOTH outputs and write PLAN.md synthesizing them BEFORE implementation.
Orchestrator MUST spawn exactly two specialized workers from the worker template: frontend and backend. Frontend owns index.html; backend owns server.mjs and a node:test smoke.test.mjs. Give explicit file ownership and the agreed API contract; they run concurrently after planning.
Both reviewers must inspect the real files and run the tests. They must not edit files; send actionable findings to the orchestrator for repair. The orchestrator must get both approvals before the task is done.
For worker artifact results, return concise evidence of changed files and validation; do not claim tests passed unless executed.`
const agents: Agent[] = [
  { id: 'template', role: 'worker', harness: 'live', model, description: 'Coding worker template' },
  { id: 'router', role: 'router', harness: 'live', model, description: 'Classify route and parallel preparation' },
  { id: 'orchestrator', role: 'orchestrator', harness: 'live', model, description: 'Spawn and coordinate workers' },
  { id: 'researcher', role: 'researcher', harness: 'live', model, description: 'Research requirements, write RESEARCH.md only' },
  { id: 'designer', role: 'designer', harness: 'live', model, description: 'Design UI, write DESIGN.md only' },
  { id: 'planner', role: 'planner', harness: 'live', model, description: 'Synthesize research and design, write PLAN.md only' },
  { id: 'reviewer', role: 'reviewer', harness: 'live', model, description: 'Read-only correctness reviewer' },
  { id: 'security-reviewer', role: 'security-reviewer', harness: 'live', model, description: 'Read-only security reviewer' },
]
await mkdir(output, { recursive: true })
const calls: { startedAt: string; endedAt?: string; request: HarnessRequest; response?: string; error?: string }[] = []
const progress: Progress[] = []
const native = new OpenCodeHarness({ executable, cwd: project })
const registry = new HarnessRegistry().register('live', { async run(request, signal) {
  const call: typeof calls[number] = { startedAt: new Date().toISOString(), request }
  calls.push(call)
  try { call.response = await native.run(request, signal); return call.response }
  catch (error) { call.error = String(error); throw error }
  finally {
    call.endedAt = new Date().toISOString()
    await writeFile(path.join(output, 'calls.json'), JSON.stringify(calls, null, 2) + '\n')
  }
} })
const startedAt = new Date().toISOString()
const runtime = createHivemind({ agents, harnesses: registry, router: new ModelRouter(agents[1]!, registry),
  maxAttempts: 6, timeoutMs: 240_000, harnessRetries: 1,
  onProgress(item) {
    const update = { ...item, at: new Date().toISOString() }
    progress.push(update)
    console.log(`${update.at} ${item.node} ${item.phase} attempt=${item.attempt} ${item.message}`)
  } })
const result = await runtime.run(task)
await writeFile(path.join(output, 'run.json'), JSON.stringify({ startedAt, endedAt: new Date().toISOString(), model, project, task, progress, result }, null, 2) + '\n')
// Copy only the expected public deliverables, never provider state or credentials.
await mkdir(path.join(output, 'workspace'), { recursive: true })
for (const file of ['index.html', 'server.mjs', 'smoke.test.mjs', 'RESEARCH.md', 'DESIGN.md', 'PLAN.md']) {
  try { await writeFile(path.join(output, 'workspace', file), await readFile(path.join(project, file))) } catch { /* failed run may omit artifacts */ }
}
console.log(`RESULT ${result.status}; attempts=${result.attempts}; calls=${calls.length}; evidence=${output}`)
if (result.status !== 'completed') process.exitCode = 1
