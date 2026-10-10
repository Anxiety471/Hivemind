import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createApiApp } from '../src/api.js'
import { configSchema } from '../src/config.js'
import { loadConfig, type Config } from '../src/config-file.js'
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

const initialConfig = (): Config => configSchema.parse({
  harnesses: { demo: { type: 'demo' } },
  agents: [
    { id: 'worker', role: 'worker', harness: 'demo' },
    { id: 'reviewer', role: 'reviewer', harness: 'demo' },
  ],
  router: { type: 'rule' },
})

async function api(tools: HarnessTools, config = initialConfig()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hivemind-catalog-'))
  const configPath = path.join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify(config))
  const { app, store } = createApiApp({ configPath, project: dir, harnessTools: tools })
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await app.handle(new Request(`http://127.0.0.1${route}`, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }))
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return { call, configPath, dir, close: () => store.shutdown() }
}

test('GET catalog persists only installed harnesses and returns the authoritative config', async () => {
  const { tools } = fakeTools()
  const before = initialConfig()
  const { call, configPath, dir, close } = await api(tools, before)
  const { status, body } = await call('GET', '/api/harness-catalog')
  assert.equal(status, 200)
  assert.equal(body.installer, 'bun')
  assert.deepEqual(body.harnesses.map((item: HarnessCatalogEntry) => [item.type, item.installed]), [['opencode', false], ['pi', true]])
  const persisted = await loadConfig(configPath)
  assert.deepEqual(persisted, {
    ...before, harnesses: { demo: { type: 'demo' }, pi: { type: 'pi', executableArgs: [], maxOutputBytes: 8_388_608 } },
  })
  assert.deepEqual(body.config, { path: configPath, project: dir, config: persisted })
  close()
})

test('repeated catalog detection is idempotent and does not rewrite unchanged config', async () => {
  const { tools } = fakeTools()
  const { call, configPath, close } = await api(tools)
  assert.equal((await call('GET', '/api/harness-catalog')).status, 200)
  const text = `${await readFile(configPath, 'utf8')}\n\n`
  await writeFile(configPath, text)
  const again = await call('GET', '/api/harness-catalog')
  assert.equal(again.status, 200)
  assert.equal(await readFile(configPath, 'utf8'), text)
  assert.deepEqual(Object.keys(again.body.config.config.harnesses), ['demo', 'pi'])
  close()
})

test('catalog preserves custom same-type registrations and does not add a duplicate', async () => {
  const { tools, state } = fakeTools()
  state.installed.add('opencode')
  const config = initialConfig()
  config.harnesses.custom = {
    type: 'pi', executable: '/custom/pi', executableArgs: ['--custom'], cwd: '/custom/project',
    model: 'custom-model', provider: 'custom-provider', thinking: 'high', tools: ['read'], maxOutputBytes: 12345,
  }
  config.maxAttempts = 7
  const { call, configPath, close } = await api(tools, config)
  const response = await call('GET', '/api/harness-catalog')
  assert.equal(response.status, 200)
  assert.deepEqual(await loadConfig(configPath), {
    ...config, harnesses: { ...config.harnesses, opencode: { type: 'opencode', executableArgs: [], maxOutputBytes: 8_388_608 } },
  })
  assert.equal(Object.hasOwn(response.body.config.config.harnesses, 'pi'), false)
  close()
})

test('catalog uses the first free suffixed id without replacing colliding entries', async () => {
  const { tools } = fakeTools()
  const config = initialConfig()
  config.harnesses.pi = { type: 'demo' }
  config.harnesses['pi-2'] = { type: 'command', command: 'custom', args: ['keep'], maxOutputBytes: 999 }
  const { call, configPath, close } = await api(tools, config)
  assert.equal((await call('GET', '/api/harness-catalog')).status, 200)
  assert.deepEqual((await loadConfig(configPath)).harnesses, {
    ...config.harnesses, 'pi-3': { type: 'pi', executableArgs: [], maxOutputBytes: 8_388_608 },
  })
  close()
})

test('concurrent catalog detections merge their installed harnesses rather than losing entries', async () => {
  const first = Promise.withResolvers<HarnessCatalogResponse>()
  const second = Promise.withResolvers<HarnessCatalogResponse>()
  const bothStarted = Promise.withResolvers<void>()
  let detections = 0
  const { tools } = fakeTools({ detect: () => {
    detections++
    if (detections === 2) bothStarted.resolve()
    return detections === 1 ? first.promise : second.promise
  } })
  const { call, configPath, close } = await api(tools)
  const one = call('GET', '/api/harness-catalog')
  const two = call('GET', '/api/harness-catalog')
  await bothStarted.promise
  first.resolve({ harnesses: [entry('pi', true)], installer: 'bun' })
  second.resolve({ harnesses: [entry('opencode', true)], installer: 'bun' })
  const responses = await Promise.all([one, two])
  assert.deepEqual(responses.map(response => response.status), [200, 200])
  assert.deepEqual((await loadConfig(configPath)).harnesses, {
    demo: { type: 'demo' },
    pi: { type: 'pi', executableArgs: [], maxOutputBytes: 8_388_608 },
    opencode: { type: 'opencode', executableArgs: [], maxOutputBytes: 8_388_608 },
  })
  for (const response of responses) {
    const own = response.body.harnesses[0].type
    assert.equal(response.body.config.config.harnesses[own].type, own)
  }
  close()
})

test('catalog loads the latest config after detection overlapping a config save', async () => {
  const detected = Promise.withResolvers<HarnessCatalogResponse>()
  const started = Promise.withResolvers<void>()
  const { tools } = fakeTools({ detect: () => { started.resolve(); return detected.promise } })
  const { call, configPath, close } = await api(tools)
  const catalog = call('GET', '/api/harness-catalog')
  await started.promise
  const edited = initialConfig()
  edited.maxAttempts = 9
  edited.harnesses.custom = { type: 'command', command: 'keep', args: [], maxOutputBytes: 123 }
  const saved = await call('PUT', '/api/config', { config: edited })
  assert.equal(saved.status, 200)
  detected.resolve({ harnesses: [entry('pi', true)], installer: 'bun' })
  const response = await catalog
  assert.equal(response.status, 200)
  const expected = { ...edited, harnesses: { ...edited.harnesses, pi: { type: 'pi', executableArgs: [], maxOutputBytes: 8_388_608 } } }
  assert.deepEqual(await loadConfig(configPath), expected)
  assert.deepEqual(response.body.config.config, expected)
  close()
})

test('catalog reports config failures instead of claiming successful registration', async () => {
  const { tools } = fakeTools()
  const { call, configPath, close } = await api(tools)
  await writeFile(configPath, 'invalid json')
  const response = await call('GET', '/api/harness-catalog')
  assert.equal(response.status, 500)
  assert.match(response.body.error, /Unable to parse config/)
  assert.equal(await readFile(configPath, 'utf8'), 'invalid json')
  close()
})

test('POST install runs the installer once, re-detects, and returns the entry with output', async () => {
  const { tools, state } = fakeTools()
  const { call, configPath, close } = await api(tools)
  const { status, body } = await call('POST', '/api/harness-catalog/opencode/install')
  assert.equal(status, 200)
  assert.equal(body.output, 'installed ok')
  assert.equal(body.entry.type, 'opencode')
  assert.equal(body.entry.installed, true)
  assert.deepEqual(state.installs, ['opencode'])
  assert.deepEqual((await loadConfig(configPath)).harnesses, {
    demo: { type: 'demo' },
    opencode: { type: 'opencode', executableArgs: [], maxOutputBytes: 8_388_608 },
    pi: { type: 'pi', executableArgs: [], maxOutputBytes: 8_388_608 },
  })
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
  const { call, configPath, close } = await api(tools)
  const { status, body } = await call('POST', '/api/harness-catalog/opencode/install')
  assert.equal(status, 500)
  assert.match(body.error, /bun add failed/)
  assert.match(body.error, /E404 not found/)
  assert.deepEqual(await loadConfig(configPath), initialConfig())
  close()
})

test('POST install succeeding but not landing on PATH is a 500', async () => {
  const { tools } = fakeTools({ install: async () => 'done' })
  const { call, configPath, close } = await api(tools)
  const { status, body } = await call('POST', '/api/harness-catalog/opencode/install')
  assert.equal(status, 500)
  assert.match(body.error, /not on PATH/)
  assert.deepEqual(await loadConfig(configPath), initialConfig())
  close()
})

test('successful installation reports registration errors instead of returning success', async () => {
  const { tools } = fakeTools()
  const { call, configPath, close } = await api(tools)
  await writeFile(configPath, 'invalid json')
  const response = await call('POST', '/api/harness-catalog/opencode/install')
  assert.equal(response.status, 500)
  assert.match(response.body.error, /Unable to parse config/)
  assert.equal(await readFile(configPath, 'utf8'), 'invalid json')
  close()
})

test('a failed registration does not poison later queued config writes', async () => {
  const { tools } = fakeTools()
  const { call, configPath, close } = await api(tools)
  await writeFile(configPath, 'invalid json')
  assert.equal((await call('GET', '/api/harness-catalog')).status, 500)
  assert.equal((await call('PUT', '/api/config', { config: initialConfig() })).status, 200)
  assert.equal((await call('GET', '/api/harness-catalog')).status, 200)
  assert.equal((await loadConfig(configPath)).harnesses.pi?.type, 'pi')
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
  assert.equal(opencode.installCommand, 'bun add -g @opencode/cli')
})

test('without bun or npm nothing is installable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hivemind-empty-'))
  const { harnesses, installer } = await detectHarnesses({ PATH: dir })
  assert.equal(installer, null)
  assert.ok(harnesses.every(item => !item.installable && !item.installed))
})
