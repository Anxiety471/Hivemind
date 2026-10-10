import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const base = {
  maxAttempts: 3,
  timeoutMs: 120_000,
  harnesses: { demo: { type: 'demo' }, alternate: { type: 'demo' } },
  agents: [
    { id: 'writer', role: 'worker', harness: 'demo', description: 'Writes' },
    { id: 'second', role: 'worker', harness: 'demo', description: 'Also writes' },
    { id: 'reviewer', role: 'reviewer', harness: 'demo', description: 'Reviews' },
  ],
  router: { type: 'rule' },
}
// Keeps every case hermetic: a fresh temp directory is removed even when assertions throw.
function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'hivemind-cli-'))
  try { return body(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
function writeConfig(dir: string): string {
  const file = path.join(dir, 'config.json')
  writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`)
  return file
}
function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, encoding: 'utf8' })
}

test('a setter rewrites the file and --show-config prints the saved value', () => {
  withTempDir(dir => {
    const file = writeConfig(dir)
    const set = run(['--config', file, '--set-max-attempts', '7'])
    assert.equal(set.status, 0, set.stderr)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).maxAttempts, 7)
    const show = run(['--config', file, '--show-config'])
    assert.equal(show.status, 0, show.stderr)
    assert.equal(JSON.parse(show.stdout).maxAttempts, 7)
  })
})

test('--set-agent-harness updates only the named agent', () => {
  withTempDir(dir => {
    const file = writeConfig(dir)
    const result = run(['--config', file, '--set-agent-harness', 'writer=alternate'])
    assert.equal(result.status, 0, result.stderr)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(saved.agents.map((agent: { id: string, harness: string }) => [agent.id, agent.harness]),
      [['writer', 'alternate'], ['second', 'demo'], ['reviewer', 'demo']])
  })
})

test('--set-router model:missing fails and leaves the file byte-identical', () => {
  withTempDir(dir => {
    const file = writeConfig(dir)
    const before = readFileSync(file, 'utf8')
    const result = run(['--config', file, '--set-router', 'model:missing'])
    assert.equal(result.status, 1)
    assert.ok(result.stderr.trim().length > 0)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})

test('--set-max-attempts rejects out-of-range values without touching the file', () => {
  withTempDir(dir => {
    const file = writeConfig(dir)
    const before = readFileSync(file, 'utf8')
    for (const value of ['0', '101']) {
      const result = run(['--config', file, '--set-max-attempts', value])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /1\.\.100/)
      assert.equal(readFileSync(file, 'utf8'), before)
    }
  })
})

test('--migrate-config writes a loadable TOML sibling with [[agents]]', () => {
  withTempDir(dir => {
    const source = writeConfig(dir)
    const migrated = run(['--config', source, '--migrate-config'])
    assert.equal(migrated.status, 0, migrated.stderr)
    const target = path.join(dir, 'config.toml')
    assert.match(readFileSync(target, 'utf8'), /\[\[agents\]\]/)
    const show = run(['--config', target, '--show-config'])
    assert.equal(show.status, 0, show.stderr)
    assert.match(show.stdout, /\[\[agents\]\]/)
    assert.match(show.stdout, /max_attempts = 3/)
  })
})

test('--dry-run prints the change and does not modify the file', () => {
  withTempDir(dir => {
    const file = writeConfig(dir)
    const before = readFileSync(file, 'utf8')
    const result = run(['--config', file, '--dry-run', '--set-max-attempts', '5'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).maxAttempts, 5)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})

test('--add-agent rejects a second reviewer', () => {
  withTempDir(dir => {
    const file = writeConfig(dir)
    const before = readFileSync(file, 'utf8')
    const result = run(['--config', file, '--add-agent', 'x:reviewer:demo'])
    assert.equal(result.status, 1)
    assert.ok(result.stderr.trim().length > 0)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})
