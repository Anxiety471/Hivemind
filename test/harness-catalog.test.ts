import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createApiApp } from '../src/api.js'
import { detectHarnesses, findOnPath, HarnessInstallError, OUTPUT_TAIL_BYTES, tail, type HarnessCatalogEntry, type HarnessCatalogResponse, type HarnessTools, type HarnessType } from '../src/harness-catalog.js'

const entry = (type: HarnessType, installed: boolean): HarnessCatalogEntry => ({
  type, name: type, description: 'd', executable: type, installed, installable: true, installCommand: `bun add -g ${type}`,
  ...(installed ? { path: `/bin/${type}`, version: '1.0.0' } : {}),
})

function fakeTools(overrides: Partial<HarnessTools> = {}) {
  const state = { installed: new Set<HarnessType>(['pi']), installs: [] as HarnessType[] }
  const tools: HarnessTools = {
    detect: async (): Promise<HarnessCatalogResponse> => ({ harnesses: (['opencode', 'pi'] as const).map(type => entry(type, state.installed.has(type))), installer: 'bun' }),
    install: async type => { state.installs.push(type); state.installed.add(type); return 'installed ok' },
    ...overrides,
  }
  return { state, tools }
}

async function api(tools: HarnessTools) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hivemind-catalog-'))
  const configPath = path.join(dir, 'config.json')
  await writeFile(configPath, '{}')
  const { app, store } = createApiApp({ configPath, project: dir, harnessTools: tools })
  const call = async (method: string, route: string) => {
    const response = await app.handle(new Request(`http://127.0.0.1${route}`, { method }))
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return { call, close: () => store.shutdown() }
}

test('GET /api/harness-catalog returns detection from the injected tools', async () => {
  const { tools } = fakeTools()
  const { call, close } = await api(tools)
  const { status, body } = await call('GET', '/api/harness-catalog')
  assert.equal(status, 200)
  assert.equal(body.installer, 'bun')
  assert.deepEqual(body.harnesses.map((item: HarnessCatalogEntry) => [item.type, item.installed]), [['opencode', false], ['pi', true]])
  close()
})

test('POST install runs the installer once, re-detects, and returns the entry with output', async () => {
  const { tools, state } = fakeTools()
  const { call, close } = await api(tools)
  const { status, body } = await call('POST', '/api/harness-catalog/opencode/install')
  assert.equal(status, 200)
  assert.equal(body.output, 'installed ok')
  assert.equal(body.entry.type, 'opencode')
  assert.equal(body.entry.installed, true)
  assert.deepEqual(state.installs, ['opencode'])
  close()
})

test('POST install rejects unknown types and wrong verbs', async () => {
  const { tools, state } = fakeTools()
  const { call, close } = await api(tools)
  assert.equal((await call('POST', '/api/harness-catalog/emacs/install')).status, 404)
  assert.equal((await call('GET', '/api/harness-catalog/opencode/install')).status, 405)
  assert.equal((await call('POST', '/api/harness-catalog')).status, 405)
  assert.deepEqual(state.installs, [])
  close()
})

test('POST install failure answers 500 with the installer output', async () => {
  const { tools } = fakeTools({ install: async () => { throw new HarnessInstallError('bun add failed', 'E404 not found') } })
  const { call, close } = await api(tools)
  const { status, body } = await call('POST', '/api/harness-catalog/opencode/install')
  assert.equal(status, 500)
  assert.match(body.error, /bun add failed/)
  assert.match(body.error, /E404 not found/)
  close()
})

test('POST install succeeding but not landing on PATH is a 500', async () => {
  const { tools } = fakeTools({ install: async () => 'done' })
  const { call, close } = await api(tools)
  const { status, body } = await call('POST', '/api/harness-catalog/opencode/install')
  assert.equal(status, 500)
  assert.match(body.error, /not on PATH/)
  close()
})

test('only one install per type runs at a time', async () => {
  const gate = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  const { tools, state } = fakeTools({
    install: async type => {
      state.installs.push(type)
      state.installed.add(type)
      if (type !== 'opencode') return 'quick'
      started.resolve()
      return gate.promise
    },
  })
  const { call, close } = await api(tools)
  const first = call('POST', '/api/harness-catalog/opencode/install')
  await started.promise
  assert.equal((await call('POST', '/api/harness-catalog/opencode/install')).status, 409)
  assert.equal((await call('POST', '/api/harness-catalog/pi/install')).status, 200)
  gate.resolve('late')
  assert.equal((await first).status, 200)
  close()
})

test('tail keeps only the last bytes', () => {
  assert.equal(tail('abc'), 'abc')
  const long = 'x'.repeat(OUTPUT_TAIL_BYTES) + 'END'
  assert.equal(tail(long).length, OUTPUT_TAIL_BYTES)
  assert.ok(tail(long).endsWith('END'))
})

test('detectHarnesses scans PATH without a shell and probes --version', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hivemind-path-'))
  const script = (name: string, body: string) => writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`).then(() => chmod(path.join(dir, name), 0o755))
  await script('pi', 'echo "pi 9.9.9"; echo second')
  await script('bun', 'exit 0')
  await writeFile(path.join(dir, 'opencode'), 'not executable')
  const env = { PATH: dir }

  assert.equal(await findOnPath('pi', env), path.join(dir, 'pi'))
  assert.equal(await findOnPath('opencode', env), undefined)
  const { harnesses, installer } = await detectHarnesses(env)
  assert.equal(installer, 'bun')
  const pi = harnesses.find(item => item.type === 'pi')!
  assert.deepEqual([pi.installed, pi.path, pi.version, pi.installable], [true, path.join(dir, 'pi'), 'pi 9.9.9', true])
  const opencode = harnesses.find(item => item.type === 'opencode')!
  assert.deepEqual([opencode.installed, opencode.path, opencode.version], [false, undefined, undefined])
  assert.equal(opencode.installCommand, 'bun add -g opencode-ai')
})

test('without bun or npm nothing is installable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hivemind-empty-'))
  const { harnesses, installer } = await detectHarnesses({ PATH: dir })
  assert.equal(installer, null)
  assert.ok(harnesses.every(item => !item.installable && !item.installed))
})
