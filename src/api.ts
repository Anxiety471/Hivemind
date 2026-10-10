import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Elysia, t } from 'elysia'
import { ZodError } from 'zod'
import { configSchema, fromConfig } from './config.js'
import { defaultHarnessModelLister, MODEL_CACHE_MS, type HarnessModelLister, type ModelListing } from './harness-models.js'
import { assertRunnable, loadConfig, saveConfig } from './config-file.js'
import { defaultHarnessTools, HarnessInstallError, isHarnessType, tail, type HarnessCatalogResponse, type HarnessTools } from './harness-catalog.js'
import type { Progress } from './graph.js'
import { applyProject, listDirectories, loadRecentProjects, rememberProject, resolveProject } from './projects.js'
import type { RunState } from './types.js'

export type RunStatus = 'running' | 'completed' | 'blocked' | 'exhausted' | 'failed' | 'cancelled'
export interface Run {
  id: string; task: string; project: string; status: RunStatus; progress: Progress[]
  result?: RunState; error?: string; startedAt: string; endedAt?: string
}

export const MAX_BODY_BYTES = 1024 * 1024
export const MAX_RUNS = 50
const PING_INTERVAL_MS = 15_000
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

type Listener = { progress(item: Progress): void; done(run: Run): void }
interface Entry { run: Run; controller: AbortController; listeners: Set<Listener> }

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface RunStore {
  list(): Run[]
  get(id: string): Run | undefined
  /** Abort every active run and finish all event streams. */
  shutdown(): void
}

export interface ApiOptions {
  /** Config file; reloaded from disk on every request that needs it. */
  configPath: string
  /** Initial project directory (must already exist). */
  project: string
  /** Harness detection/installation; defaults to the real PATH scan and bun/npm. Tests inject fakes. */
  harnessTools?: HarnessTools
  /** Model listing for opencode/pi harnesses; defaults to running their CLIs. Tests inject fakes. */
  harnessModels?: HarnessModelLister
}

class Runs implements RunStore {
  private readonly entries = new Map<string, Entry>()

  list(): Run[] { return [...this.entries.values()].reverse().map(entry => entry.run) }
  get(id: string): Run | undefined { return this.entries.get(id)?.run }
  entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new HttpError(404, `Unknown run "${id}"`)
    return entry
  }

  add(task: string, project: string, controller: AbortController): Entry {
    const entry: Entry = {
      run: { id: randomUUID(), task, project, status: 'running', progress: [], startedAt: new Date().toISOString() },
      controller, listeners: new Set(),
    }
    this.entries.set(entry.run.id, entry)
    // Evict oldest finished runs first; active runs are never dropped.
    for (const [id, existing] of this.entries) {
      if (this.entries.size <= MAX_RUNS) break
      if (existing.run.status !== 'running') this.entries.delete(id)
    }
    return entry
  }

  progress(entry: Entry, item: Progress): void {
    if (entry.run.status !== 'running') return
    const stamped = { ...item, at: new Date().toISOString() }
    entry.run.progress.push(stamped)
    for (const listener of entry.listeners) listener.progress(stamped)
  }

  finish(entry: Entry, status: RunStatus, extra: { result?: RunState; error?: string } = {}): void {
    if (entry.run.status !== 'running') return
    entry.run.status = status
    entry.run.endedAt = new Date().toISOString()
    if (extra.result) entry.run.result = extra.result
    if (extra.error !== undefined) entry.run.error = extra.error
    const listeners = [...entry.listeners]
    entry.listeners.clear()
    for (const listener of listeners) listener.done(entry.run)
  }

  cancel(entry: Entry): void {
    entry.controller.abort(new Error('Run cancelled'))
    this.finish(entry, 'cancelled')
  }

  shutdown(): void {
    for (const entry of this.entries.values()) if (entry.run.status === 'running') this.cancel(entry)
  }
}

function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ')
  }
  return error instanceof Error ? error.message : String(error)
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw new HttpError(400, 'Content-Type must be application/json')
  const tooLarge = new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`)
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge
  const chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw tooLarge
      chunks.push(chunk)
    }
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
    throw new HttpError(400, `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be a JSON object')
  return value as Record<string, unknown>
}

// Own parser (instead of Elysia's content-type sniffing) so the JSON-only CSRF guard and the size cap hold on every body route.
const jsonBody = { parse: ({ request }: { request: Request }) => readJson(request) }

const textBody = (label: string) => t.String({ pattern: '\\S', error: `"${label}" must be a non-empty string` })

function eventStream(request: Request, entry: Entry): Response {
  const encoder = new TextEncoder()
  let detach = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text))
      const frame = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      for (const item of entry.run.progress) frame('progress', item)
      if (entry.run.status !== 'running') {
        frame('done', entry.run)
        controller.close()
        return
      }
      const ping = setInterval(() => send(': ping\n\n'), PING_INTERVAL_MS)
      const listener: Listener = {
        progress: item => frame('progress', item),
        done: run => { detach(); frame('done', run); controller.close() },
      }
      entry.listeners.add(listener)
      detach = () => { clearInterval(ping); entry.listeners.delete(listener) }
      request.signal.addEventListener('abort', detach, { once: true })
    },
    cancel() { detach() },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
  })
}

/** Elysia app serving the Hivemind API. Call `app.handle(Request)` directly or `app.listen(...)`. */
export function createApiApp(options: ApiOptions) {
  const configPath = path.resolve(options.configPath)
  let current = options.project
  const runs = new Runs()
  const harnessTools = options.harnessTools ?? defaultHarnessTools
  const installing = new Set<string>()
  const modelLister = options.harnessModels ?? defaultHarnessModelLister
  const modelCache = new Map<string, { at: number; value: ModelListing }>()
  // Only disk read/modify/write transactions are sequenced; CLI detection/install stays concurrent.
  let configWrites: Promise<unknown> = Promise.resolve()
  function writeConfig<T>(transaction: () => Promise<T>): Promise<T> {
    const result = configWrites.then(transaction)
    configWrites = result.catch(() => {})
    return result
  }

  function registerHarnesses(catalog: HarnessCatalogResponse) {
    return writeConfig(async () => {
      const config = await loadConfig(configPath)
      let changed = false
      for (const entry of catalog.harnesses) {
        if (!entry.installed || Object.values(config.harnesses).some(settings => settings.type === entry.type)) continue
        let id: string = entry.type
        for (let suffix = 2; Object.hasOwn(config.harnesses, id); suffix++) id = `${entry.type}-${suffix}`
        config.harnesses[id] = { type: entry.type, executableArgs: [], maxOutputBytes: 8_388_608 }
        changed = true
      }
      if (changed) await saveConfig(configPath, config)
      return { path: configPath, project: current, config }
    })
  }

  async function harnessModels(id: string): Promise<ModelListing> {
    const config = applyProject(await loadConfig(configPath).catch(error => { throw new HttpError(500, describeError(error)) }), current)
    const settings = Object.hasOwn(config.harnesses, id) ? config.harnesses[id] : undefined
    if (!settings) throw new HttpError(404, `Unknown harness "${id}"`)
    if (settings.type !== 'opencode' && settings.type !== 'pi') return { models: [] }
    const target = { type: settings.type, executable: settings.executable, executableArgs: settings.executableArgs, cwd: settings.cwd }
    const key = JSON.stringify([id, target])
    const hit = modelCache.get(key)
    if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.value
    const value = await modelLister.list(target).catch((error): ModelListing => ({ models: [], error: describeError(error) }))
    if (!value.error) modelCache.set(key, { at: Date.now(), value })
    return value
  }

  const configPayload = async () => ({ path: configPath, project: current, config: await loadConfig(configPath).catch(error => { throw new HttpError(500, describeError(error)) }) })
  const projectsPayload = async () => ({ current, recent: await loadRecentProjects() })

  async function startRun(task: string): Promise<Run> {
    const project = current
    const controller = new AbortController()
    let entry: Entry | undefined
    const hivemind = await loadConfig(configPath).then(config => {
      assertRunnable(config)
      return fromConfig(applyProject(config, project), { signal: controller.signal, onProgress: item => entry && runs.progress(entry, item) })
    }).catch(error => { throw new HttpError(500, describeError(error)) })
    const started = runs.add(task, project, controller)
    entry = started
    hivemind.run(task).then(
      result => {
        if (result.status === 'running') runs.finish(started, 'failed', { result, error: 'Run ended without a final status' })
        else runs.finish(started, result.status, { result })
      },
      error => runs.finish(started, controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? {} : { error: describeError(error) }),
    )
    return started.run
  }

  async function installHarness(type: string) {
    if (!isHarnessType(type)) throw new HttpError(404, `Unknown harness "${type}"`)
    if (installing.has(type)) throw new HttpError(409, `${type} is already being installed`)
    installing.add(type)
    try {
      const output = tail(await harnessTools.install(type).catch(error => {
        const detail = error instanceof HarnessInstallError ? error.output : ''
        throw new HttpError(500, detail ? `${describeError(error)}\n${tail(detail)}` : describeError(error))
      }))
      const catalog = await harnessTools.detect()
      const entry = catalog.harnesses.find(item => item.type === type)!
      if (!entry.installed) throw new HttpError(500, `${entry.name} was installed but "${entry.executable}" is not on PATH yet; add the global bin directory to PATH.\n${output}`)
      await registerHarnesses(catalog)
      return { entry, output }
    } finally { installing.delete(type) }
  }

  const notAllowed = () => { throw new HttpError(405, 'Method not allowed') }

  const app = new Elysia()
    .onRequest(({ request }) => {
      // Bun derives request.url from the Host header, so this also rejects DNS-rebinding hosts.
      if (!ALLOWED_HOSTS.has(new URL(request.url).hostname)) throw new HttpError(403, 'Forbidden host')
    })
    .onError(({ code, error: raised, set }) => {
      // Elysia wraps anything thrown inside a body parser in a generic PARSE error; unwrap our own.
      const error = code === 'PARSE' && raised.cause instanceof HttpError ? raised.cause : raised
      if (error instanceof HttpError) set.status = error.status
      else if (code === 'NOT_FOUND') { set.status = 404; return { error: 'Not found' } }
      else if (code === 'VALIDATION' || code === 'PARSE' || code === 'INVALID_COOKIE_SIGNATURE') set.status = 400
      else set.status = 500
      return { error: describeError(error) }
    })
    .get('/api/health', () => ({ ok: true }))
    .get('/api/config', () => configPayload())
    .get('/api/harness-catalog', async () => {
      const catalog = await harnessTools.detect()
      return { ...catalog, config: await registerHarnesses(catalog) }
    })
    .get('/api/harness-models', ({ query }) => {
      if (!query.harness) throw new HttpError(400, '"harness" query parameter is required')
      return harnessModels(query.harness)
    })
    .post('/api/harness-catalog/:type/install', ({ params }) => installHarness(params.type))
    .put('/api/config', async ({ body }) => {
      let config
      try { config = configSchema.parse(body.config); assertRunnable(config) } catch (error) { throw new HttpError(400, describeError(error)) }
      return writeConfig(async () => {
        await saveConfig(configPath, config)
        return configPayload()
      })
    }, { ...jsonBody, body: t.Object({ config: t.Unknown() }, { error: '"config" is required' }) })
    .get('/api/projects', () => projectsPayload())
    .put('/api/project', async ({ body }) => {
      current = await resolveProject(body.path).catch(error => { throw new HttpError(400, describeError(error)) })
      await rememberProject(current)
      return projectsPayload()
    }, { ...jsonBody, body: t.Object({ path: textBody('path') }, { error: '"path" must be a non-empty string' }) })
    .get('/api/directories', async ({ query }) => {
      const dir = await resolveProject(query.path || current, current).catch(error => { throw new HttpError(400, describeError(error)) })
      const parent = path.dirname(dir)
      return { path: dir, parent: parent === dir ? null : parent, directories: await listDirectories(dir) }
    })
    .get('/api/runs', () => ({ runs: runs.list() }))
    .post('/api/runs', async ({ body, set }) => {
      const run = await startRun(body.task)
      set.status = 201
      return run
    }, { ...jsonBody, body: t.Object({ task: textBody('task') }, { error: '"task" must be a non-empty string' }) })
    .get('/api/runs/:id', ({ params }) => runs.entry(params.id).run)
    .post('/api/runs/:id/cancel', ({ params }) => {
      const entry = runs.entry(params.id)
      if (entry.run.status !== 'running') throw new HttpError(409, `Run is already ${entry.run.status}`)
      runs.cancel(entry)
      return entry.run
    })
    .get('/api/runs/:id/events', ({ params, request }) => eventStream(request, runs.entry(params.id)))
    // Known paths with the wrong verb answer 405 instead of Elysia's blanket 404.
    .all('/api/health', notAllowed)
    .all('/api/config', notAllowed)
    .all('/api/projects', notAllowed)
    .all('/api/project', notAllowed)
    .all('/api/directories', notAllowed)
    .all('/api/runs', notAllowed)
    .all('/api/harness-catalog', notAllowed)
    .all('/api/harness-models', notAllowed)
    .all('/api/harness-catalog/:type/install', notAllowed)
    .all('/api/runs/:id', notAllowed)
    .all('/api/runs/:id/cancel', notAllowed)
    .all('/api/runs/:id/events', notAllowed)
    .onStop(() => runs.shutdown())
  return { app, store: runs as RunStore }
}
