import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, test } from 'node:test'
import type { Config } from '../src/config-file.js'
import { applyProject, displayPath, listDirectories, loadRecentProjects, rememberProject, resolveProject } from '../src/projects.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hivemind-projects-'))
  process.env.HIVEMIND_STATE_DIR = path.join(root, 'state')
})

test('resolveProject resolves relative and ~ paths, rejects missing and files', async () => {
  await mkdir(path.join(root, 'app'))
  await writeFile(path.join(root, 'file.txt'), 'x')
  assert.equal(await resolveProject('app', root), path.join(root, 'app'))
  assert.equal(await resolveProject(path.join(root, 'app', '..')), root)
  assert.equal(await resolveProject('~'), homedir())
  await assert.rejects(resolveProject('missing', root), /Not a directory/)
  await assert.rejects(resolveProject('file.txt', root), /Not a directory/)
})

test('applyProject points filesystem harnesses at the project without mutating input', () => {
  const config = {
    harnesses: {
      demo: { type: 'demo' },
      api: { type: 'openai-compatible', baseUrl: 'http://x', model: 'm', apiKeyEnv: 'K', maxTokens: 1 },
      bare: { type: 'command', command: 'sh', args: [], maxOutputBytes: 1 },
      rel: { type: 'opencode', cwd: 'sub', executableArgs: [], maxOutputBytes: 1 },
      abs: { type: 'pi', cwd: '/abs', executableArgs: [], maxOutputBytes: 1 },
    },
    agents: [],
  } as unknown as Config
  const before = structuredClone(config)
  const applied = applyProject(config, '/proj')
  assert.deepEqual(config, before)
  const h = applied.harnesses as Record<string, { cwd?: string }>
  assert.equal(h.bare!.cwd, '/proj')
  assert.equal(h.rel!.cwd, path.resolve('/proj', 'sub'))
  assert.equal(h.abs!.cwd, '/abs')
  assert.deepEqual(applied.harnesses.demo, before.harnesses.demo)
  assert.deepEqual(applied.harnesses.api, before.harnesses.api)
})

test('recents dedupe, move to front, cap at 10, and drop missing dirs', async () => {
  const dirs = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const dir = path.join(root, `d${i}`)
    await mkdir(dir)
    return dir
  }))
  assert.deepEqual(await loadRecentProjects(), [])
  for (const dir of dirs) await rememberProject(dir)
  await rememberProject(dirs[5]!)
  const recent = await loadRecentProjects()
  assert.equal(recent.length, 10)
  assert.equal(recent[0], dirs[5])
  assert.equal(recent[1], dirs[11])
  assert.equal(new Set(recent).size, 10)
  await rememberProject(path.join(root, 'gone'))
  assert.ok(!(await loadRecentProjects()).includes(path.join(root, 'gone')))
})

test('corrupt recents file yields []', async () => {
  await mkdir(process.env.HIVEMIND_STATE_DIR!, { recursive: true })
  await writeFile(path.join(process.env.HIVEMIND_STATE_DIR!, 'projects.json'), '{not json')
  assert.deepEqual(await loadRecentProjects(), [])
})

test('listDirectories sorts, hides dot dirs, excludes files', async () => {
  for (const name of ['b', 'a', '.hidden']) await mkdir(path.join(root, name))
  await writeFile(path.join(root, 'c.txt'), '')
  assert.deepEqual(await listDirectories(root), ['a', 'b'])
  assert.deepEqual(await listDirectories(path.join(root, 'nope')), [])
})

test('displayPath abbreviates home', () => {
  assert.equal(displayPath(path.join(homedir(), 'x')), path.join('~', 'x'))
  assert.equal(displayPath('/elsewhere'), '/elsewhere')
})
