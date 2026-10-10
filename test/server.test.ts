import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createApiApp, MAX_BODY_BYTES, type Run } from '../src/api.js'
import type { Config } from '../src/config-file.js'
import type { Progress } from '../src/graph.js'

// Union of every response shape the API returns; tests only read the fields relevant to each route.
interface Reply extends Run {
  ok: boolean; error: string; path: string; current: string; recent: string[]
  parent: string | null; directories: string[]; config: Config; runs: Run[]
}
type Api = (route: string, init?: RequestInit) => Promise<Response>
interface Frame { event: string; data: unknown }

const demo = JSON.parse(await readFile('examples/demo.json', 'utf8')) as Config

let root: string
let configPath: string
let slowConfigPath: string
let project: string
const closers: (() => Promise<void>)[] = []
const doneRun = (frames: Frame[]) => {
  const last = frames.at(-1)!
  assert.equal(last.event, 'done')
  return last.data as Run
}

// Requests go straight into Elysia's fetch handler; no socket is opened.
const ORIGIN = 'http://127.0.0.1'

async function start(config: string) {
  const { app, store } = createApiApp({ configPath: config, project })
  closers.push(async () => store.shutdown())
  const fetchApi = (route: string, init?: RequestInit) => app.handle(new Request(ORIGIN + route, init))
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetchApi(route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Reply }
  }
  return { app, fetchApi, store, call }
}

async function events(fetchApi: Api, id: string): Promise<Frame[]> {
  const response = await fetchApi(`/api/runs/${id}/events`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const text = await response.text()
  return text.split('\n\n').filter(frame => frame.includes('event:')).map(frame => {
    const event = /^event: (.*)$/m.exec(frame)![1]!
    return { event, data: JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) }
  })
}

// Resolves once the live stream has delivered a progress item matching `match`.
async function untilProgress(fetchApi: Api, id: string, match: (item: Progress) => boolean): Promise<void> {
  const response = await fetchApi(`/api/runs/${id}/events`)
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of response.body!) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true })
    const frames = buffered.split('\n\n')
    buffered = frames.pop()!
    for (const frame of frames) {
      if (frame.startsWith('event: progress') && match(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as Progress)) {
        return // leaving the loop cancels the response body
      }
    }
  }
  assert.fail('stream ended before the expected progress item')
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hivemind-server-'))
  process.env.HIVEMIND_STATE_DIR = path.join(root, 'state')
  project = path.join(root, 'project')
  await mkdir(path.join(project, 'sub'), { recursive: true })
  configPath = path.join(root, 'demo.json')
  await writeFile(configPath, await readFile('examples/demo.json', 'utf8'))
  // The worker blocks until aborted so cancellation can be observed.
  slowConfigPath = path.join(root, 'slow.json')
  await writeFile(slowConfigPath, JSON.stringify({
    ...demo,
    harnesses: { ...demo.harnesses, slow: { type: 'command', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] } },
    agents: demo.agents.map(agent => agent.role === 'worker' ? { ...agent, harness: 'slow' } : agent),
  }))
})

after(async () => { await Promise.all(closers.map(close => close())) })

test('health, config, projects and directories', async () => {
  const { call } = await start(configPath)
  assert.deepEqual((await call('GET', '/api/health')).body, { ok: true })
  const config = await call('GET', '/api/config')
  assert.equal(config.status, 200)
  assert.equal(config.body.path, configPath)
  assert.equal(config.body.project, project)
  assert.equal(config.body.config.agents.length, 2)

  const directories = await call('GET', '/api/directories')
  assert.deepEqual(directories.body, { path: project, parent: root, directories: ['sub'] })
  assert.equal((await call('GET', `/api/directories?path=${encodeURIComponent(path.join(root, 'missing'))}`)).status, 400)

  const switched = await call('PUT', '/api/project', { path: path.join(project, 'sub') })
  assert.equal(switched.body.current, path.join(project, 'sub'))
  assert.deepEqual(switched.body.recent, [path.join(project, 'sub')])
  assert.deepEqual((await call('GET', '/api/projects')).body, switched.body)
  assert.equal((await call('PUT', '/api/project', { path: path.join(root, 'missing') })).status, 400)
  assert.equal((await call('PUT', '/api/project', {})).status, 400)
  assert.equal((await call('GET', '/api/config')).body.project, path.join(project, 'sub'))
})

test('run lifecycle with SSE replay, listing and live streaming', async () => {
  const { fetchApi, call } = await start(configPath)
  // Subscribe before the run has necessarily finished, then replay after it is done.
  const created = await call('POST', '/api/runs', { task: 'Write a note' })
  assert.equal(created.status, 201)
  const run = created.body as Run
  assert.equal(run.status, 'running')
  assert.equal(run.task, 'Write a note')
  assert.equal(run.project, project)

  const live = await events(fetchApi, run.id)
  const last = doneRun(live)
  assert.equal(last.status, 'completed')
  assert.equal(last.result!.status, 'completed')
  assert.ok(live.slice(0, -1).every(frame => frame.event === 'progress'))
  assert.ok(live.length > 1)

  const replay = await events(fetchApi, run.id)
  assert.deepEqual(replay, live)
  assert.deepEqual(replay.slice(0, -1).map(frame => frame.data as Progress), last.progress)

  const fetched = (await call('GET', `/api/runs/${run.id}`)).body as Run
  assert.equal(fetched.status, 'completed')
  assert.ok(fetched.endedAt)
  assert.match(fetched.result!.artifact, /Write a note/)

  const second = (await call('POST', '/api/runs', { task: 'Another' })).body as Run
  const list = (await call('GET', '/api/runs')).body.runs as Run[]
  assert.deepEqual(list.map(item => item.id), [second.id, run.id])

  assert.equal((await call('POST', `/api/runs/${run.id}/cancel`)).status, 409)
  assert.equal((await call('GET', '/api/runs/nope')).status, 404)
  assert.equal((await call('GET', '/api/runs/nope/events')).status, 404)
})

test('run input validation', async () => {
  const { app, fetchApi, call } = await start(configPath)
  assert.equal((await call('POST', '/api/runs', {})).status, 400)
  assert.equal((await call('POST', '/api/runs', { task: '   ' })).status, 400)
  assert.equal((await call('POST', '/api/runs', { task: 5 })).status, 400)
  assert.equal((await call('POST', '/api/runs', [])).status, 400)
  const malformed = await fetchApi('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
  assert.equal(malformed.status, 400)
  assert.match(((await malformed.json()) as { error: string }).error, /Invalid JSON/)
  const plain = await fetchApi('/api/runs', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ task: 'x' }) })
  assert.equal(plain.status, 400)
  const huge = await fetchApi('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'x'.repeat(MAX_BODY_BYTES) }) })
  assert.equal(huge.status, 413)
  const unknown = await call('GET', '/api/nope')
  assert.equal(unknown.status, 404)
  assert.equal(typeof unknown.body.error, 'string')
  assert.equal((await call('DELETE', '/api/health')).status, 405)
  // Hosts other than loopback (DNS rebinding) are refused.
  assert.equal((await app.handle(new Request('http://evil.example/api/health'))).status, 403)
  assert.deepEqual((await call('GET', '/api/runs')).body, { runs: [] })
})

test('cancel aborts a running run and ends its event stream', async () => {
  const { fetchApi, store, call } = await start(slowConfigPath)
  const run = (await call('POST', '/api/runs', { task: 'Never finishes' })).body as Run
  await untilProgress(fetchApi, run.id, item => item.node === 'work' && item.phase === 'start')

  const streamed = events(fetchApi, run.id)
  const cancelled = await call('POST', `/api/runs/${run.id}/cancel`)
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.status, 'cancelled')
  assert.ok(cancelled.body.endedAt)

  assert.equal(doneRun(await streamed).status, 'cancelled')
  // Real delay: the aborted graph settles asynchronously after the child process is killed, with no hook to await.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(store.get(run.id)!.status, 'cancelled')
  assert.equal((await call('POST', `/api/runs/${run.id}/cancel`)).status, 409)
})

test('config updates validate, persist and are reloaded per request', async () => {
  const { call } = await start(configPath)
  const original = (await call('GET', '/api/config')).body.config

  const invalid = await call('PUT', '/api/config', { config: { ...original, maxAttempts: 0 } })
  assert.equal(invalid.status, 400)
  assert.match(invalid.body.error, /maxAttempts/)
  assert.equal((await call('PUT', '/api/config', { config: { ...original, surprise: true } })).status, 400)
  assert.equal((await call('PUT', '/api/config', {})).status, 400)
  const noReviewer = await call('PUT', '/api/config', { config: { ...original, agents: original.agents.filter(agent => agent.role !== 'reviewer') } })
  assert.equal(noReviewer.status, 400)
  assert.deepEqual((await call('GET', '/api/config')).body.config, original)

  const updated = await call('PUT', '/api/config', { config: { ...original, maxAttempts: 5 } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.config.maxAttempts, 5)
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).maxAttempts, 5)

  // External edits on disk are picked up without restarting.
  await writeFile(configPath, JSON.stringify({ ...original, maxAttempts: 7 }))
  assert.equal((await call('GET', '/api/config')).body.config.maxAttempts, 7)
  await call('PUT', '/api/config', { config: original })
})
