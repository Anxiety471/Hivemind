import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'

export type HarnessType = 'opencode' | 'pi'
export type Installer = 'bun' | 'npm'

export interface HarnessCatalogEntry {
  type: HarnessType
  /** Display name. */
  name: string
  description: string
  /** Command looked up on PATH. */
  executable: string
  installed: boolean
  /** Resolved absolute path when installed. */
  path?: string
  /** First line of `<exe> --version`, when obtainable. */
  version?: string
  /** An installer (bun or npm) exists on PATH. */
  installable: boolean
  /** Human-readable install command. */
  installCommand: string
}

export interface HarnessCatalogResponse { harnesses: HarnessCatalogEntry[]; installer: Installer | null }

/** Detection and installation, injectable so tests never touch the real machine. */
export interface HarnessTools {
  /** Fresh detection on every call. */
  detect(): Promise<HarnessCatalogResponse>
  /** Install the harness globally and resolve with the installer output tail; reject with `HarnessInstallError` on failure. */
  install(type: HarnessType): Promise<string>
}

export class HarnessInstallError extends Error {
  constructor(message: string, readonly output: string) { super(message) }
}

export const OUTPUT_TAIL_BYTES = 8 * 1024
export const VERSION_TIMEOUT_MS = 5_000
export const INSTALL_TIMEOUT_MS = 5 * 60_000

interface Definition { name: string; description: string; executable: string; pkg: string }

// Package names verified against the npm registry: `opencode-ai` (bin `opencode`) and `@earendil-works/pi-coding-agent` (bin `pi`; the legacy `@mariozechner` package is 0.73.1).
export const HARNESSES: Record<HarnessType, Definition> = {
  opencode: { name: 'OpenCode', description: 'Open-source terminal coding agent, driven through `opencode run`.', executable: 'opencode', pkg: 'opencode-ai' },
  pi: { name: 'Pi', description: 'Minimal terminal coding agent with read, bash, edit and write tools.', executable: 'pi', pkg: '@earendil-works/pi-coding-agent' },
}

export const isHarnessType = (value: string): value is HarnessType => Object.hasOwn(HARNESSES, value)

const installArgs = (installer: Installer, pkg: string) => installer === 'bun' ? ['add', '-g', pkg] : ['install', '-g', pkg]

export const installCommandFor = (type: HarnessType, installer: Installer | null) => `${installer ?? 'bun'} ${installArgs(installer ?? 'bun', HARNESSES[type].pkg).join(' ')}`

async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch { return false }
}

/** Resolve `command` through PATH without spawning a shell. */
export async function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const pathVar = env.PATH ?? env.Path ?? ''
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : ['']
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = path.resolve(dir, command + extension)
      if (await isExecutable(candidate)) return candidate
    }
  }
}

async function probeVersion(file: string): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>()
  const child = execFile(file, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    // Some CLIs print their version to stderr; a failed probe with no stdout is not a version.
    const firstLine = (text: string) => text.split(/\r?\n/).find(item => item.trim())?.trim()
    resolve(firstLine(stdout) ?? (error ? undefined : firstLine(stderr)))
  })
  child.stdin?.end()
  return promise
}

export function tail(text: string, bytes = OUTPUT_TAIL_BYTES): string {
  const buffer = Buffer.from(text)
  return buffer.length <= bytes ? text : buffer.subarray(buffer.length - bytes).toString('utf8').replace(/^\uFFFD+/, '')
}

export async function detectInstaller(env: NodeJS.ProcessEnv = process.env): Promise<Installer | null> {
  for (const installer of ['bun', 'npm'] as const) if (await findOnPath(installer, env)) return installer
  return null
}

export async function detectHarnesses(env: NodeJS.ProcessEnv = process.env): Promise<HarnessCatalogResponse> {
  const installer = await detectInstaller(env)
  const harnesses = await Promise.all((Object.keys(HARNESSES) as HarnessType[]).map(async (type): Promise<HarnessCatalogEntry> => {
    const { name, description, executable } = HARNESSES[type]
    const found = await findOnPath(executable, env)
    const version = found ? await probeVersion(found) : undefined
    return {
      type, name, description, executable, installed: Boolean(found),
      ...(found ? { path: found } : {}), ...(version ? { version } : {}),
      installable: installer !== null, installCommand: installCommandFor(type, installer),
    }
  }))
  return { harnesses, installer }
}

export async function installHarness(type: HarnessType, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const installer = await detectInstaller(env)
  if (!installer) throw new HarnessInstallError('Neither bun nor npm was found on PATH', '')
  const command = (await findOnPath(installer, env))!
  const args = installArgs(installer, HARNESSES[type].pkg)
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  let output = ''
  let timedOut = false
  const collect = (chunk: Buffer) => { output = tail(output + chunk.toString('utf8'), OUTPUT_TAIL_BYTES * 2) }
  // `.cmd` shims (npm on Windows) cannot be spawned without a shell; args here are fixed constants.
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command) })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, INSTALL_TIMEOUT_MS)
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', error => { clearTimeout(timer); reject(new HarnessInstallError(`Could not run ${installer}: ${error.message}`, tail(output))) })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    if (timedOut) reject(new HarnessInstallError(`${installer} timed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes`, tail(output)))
    else if (code !== 0) reject(new HarnessInstallError(`${installer} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`, tail(output)))
    else resolve(tail(output))
  })
  return promise
}

export const defaultHarnessTools: HarnessTools = { detect: () => detectHarnesses(), install: type => installHarness(type) }
