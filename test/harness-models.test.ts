import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createApiApp } from '../src/api.js'
import { parseOpenCodeModels, parsePiModels, type HarnessModelLister, type ModelTarget } from '../src/harness-models.js'

test('parsers extract provider/model strings', () => {
  assert.deepEqual(parseOpenCodeModels('a/b\nc/d:e\n\nnoise\na/b\n'), ['a/b', 'c/d:e'])
  assert.deepEqual(parsePiModels('provider  model  context\nopenai    gpt-4  8K\nanthropic claude-x 1M\n'), ['openai/gpt-4', 'anthropic/claude-x'])
})

async function api(lister: HarnessModelLister) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hivemind-models-'))
  const configPath = path.join(dir, 'config.json')
  const agent = (id: string, role: string) => ({ id, role, harness: 'oc' })
  await writeFile(configPath, JSON.stringify({
    harnesses: { oc: { type: 'opencode', executable: 'oc-bin' }, p: { type: 'pi' }, d: { type: 'demo' } },
    agents: [agent('w', 'worker'), agent('r', 'reviewer')], router: { type: 'rule' },
  }))
  const { app, store } = createApiApp({ configPath, project: dir, harnessModels: lister })
  const call = async (method: string, route: string) => {
    const response = await app.handle(new Request(`http://127.0.0.1${route}`, { method }))
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return { call, close: () => store.shutdown(), dir }
}

test('GET /api/harness-models lists via the injected lister and caches successes', async () => {
  const calls: ModelTarget[] = []
  const { call, close, dir } = await api({ list: async target => { calls.push(target); return { models: [`${target.type}/m`] } } })
  const first = await call('GET', '/api/harness-models?harness=oc')
  assert.deepEqual(first, { status: 200, body: { models: ['opencode/m'] } })
  await call('GET', '/api/harness-models?harness=oc')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.executable, 'oc-bin')
  assert.equal(calls[0]?.cwd, dir)
  assert.deepEqual((await call('GET', '/api/harness-models?harness=p')).body, { models: ['pi/m'] })
  close()
})

test('GET /api/harness-models handles other types, unknown ids, missing query and wrong verbs', async () => {
  const { call, close } = await api({ list: async () => { throw new Error('must not be called') } })
  assert.deepEqual(await call('GET', '/api/harness-models?harness=d'), { status: 200, body: { models: [] } })
  assert.equal((await call('GET', '/api/harness-models?harness=nope')).status, 404)
  assert.equal((await call('GET', '/api/harness-models?harness=constructor')).status, 404)
  assert.equal((await call('GET', '/api/harness-models')).status, 400)
  assert.equal((await call('POST', '/api/harness-models?harness=oc')).status, 405)
  close()
})

test('failed listings return 200 with an error and are not cached', async () => {
  let n = 0
  const { call, close } = await api({ list: async () => ++n === 1 ? { models: [], error: 'boom' } : n === 2 ? Promise.reject(new Error('thrown')) : { models: ['x/y'] } })
  assert.deepEqual(await call('GET', '/api/harness-models?harness=oc'), { status: 200, body: { models: [], error: 'boom' } })
  assert.deepEqual(await call('GET', '/api/harness-models?harness=oc'), { status: 200, body: { models: [], error: 'thrown' } })
  assert.deepEqual((await call('GET', '/api/harness-models?harness=oc')).body, { models: ['x/y'] })
  close()
})
