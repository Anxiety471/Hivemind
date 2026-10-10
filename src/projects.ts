import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Config } from './config-file.js'

const MAX_RECENT = 10

async function isDirectory(dir: string): Promise<boolean> {
  try { return (await stat(dir)).isDirectory() } catch { return false }
}

/** Resolve `input` (absolute, relative to `base`, or `~`-prefixed) to an existing absolute directory. */
export async function resolveProject(input: string, base: string = process.cwd()): Promise<string> {
  const trimmed = input.trim()
  const expanded = trimmed === '~' ? homedir()
    : trimmed.startsWith('~/') || trimmed.startsWith(`~${path.sep}`) ? path.join(homedir(), trimmed.slice(2)) : trimmed
  const resolved = path.resolve(base, expanded)
  if (!(await isDirectory(resolved))) throw new Error(`Not a directory: ${resolved}`)
  return resolved
}

/** Point filesystem harnesses at `project`; relative harness `cwd` resolves against it. Pure. */
export function applyProject(config: Config, project: string): Config {
  const harnesses: Config['harnesses'] = {}
  for (const [id, settings] of Object.entries(config.harnesses)) {
    harnesses[id] = settings.type === 'opencode' || settings.type === 'pi' || settings.type === 'command'
      ? { ...settings, cwd: settings.cwd ? path.resolve(project, settings.cwd) : project }
      : settings
  }
  return { ...config, harnesses }
}

function stateFile(): string {
  const dir = process.env.HIVEMIND_STATE_DIR
    ?? path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'hivemind')
  return path.join(dir, 'projects.json')
}

async function readRecent(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile(), 'utf8'))
    const recent = (parsed as { recent?: unknown } | null)?.recent
    return Array.isArray(recent) ? recent.filter((entry): entry is string => typeof entry === 'string') : []
  } catch { return [] }
}

/** Recent project directories, most recent first, deduped, max 10, existing directories only. */
export async function loadRecentProjects(): Promise<string[]> {
  const unique = [...new Set(await readRecent())]
  const exists = await Promise.all(unique.map(isDirectory))
  return unique.filter((_, index) => exists[index]).slice(0, MAX_RECENT)
}

/** Move `dir` to the front of recents and persist atomically; never throws. */
export async function rememberProject(dir: string): Promise<void> {
  try {
    const file = stateFile()
    const recent = [dir, ...(await readRecent()).filter(entry => entry !== dir)].slice(0, MAX_RECENT)
    await mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify({ recent }, null, 2)}\n`)
    await rename(temp, file)
  } catch { /* recents are best-effort */ }
}

/** Immediate, non-hidden subdirectory names of `dir`, sorted; unreadable → []. */
export async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort()
  } catch { return [] }
}

/** Replace the home-directory prefix with `~`. */
export function displayPath(dir: string): string {
  const home = homedir()
  if (dir === home) return '~'
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir
}
