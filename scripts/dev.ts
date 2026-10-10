import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// `bun run dev`: Hivemind API (src/server.ts) + Next.js web app (web/). The TUI stays available via `bun run tui`.
const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'examples/demo.json' }, project: { type: 'string' },
  'api-port': { type: 'string', default: process.env.HIVEMIND_API_PORT ?? '4100' },
  'web-port': { type: 'string', default: process.env.PORT ?? '3000' },
} })
const root = fileURLToPath(new URL('..', import.meta.url))
const web = fileURLToPath(new URL('../web/', import.meta.url))
const apiPort = values['api-port']!
const webPort = values['web-port']!

let next: string
try { next = createRequire(`${web}package.json`).resolve('next/dist/bin/next') } catch {
  console.error('Next.js is not installed. Run `bun install` (or `npm install`) at the repo root first.')
  process.exit(1)
}

const children: ChildProcess[] = []
let stopping = false
function start(label: string, color: number, command: string, args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ''
    stream.on('data', (chunk: Buffer) => {
      const lines = (buffer + chunk.toString()).split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) console.log(prefix + line)
    })
    stream.on('end', () => { if (buffer) console.log(prefix + buffer) })
  }
  child.on('exit', code => {
    if (stopping) return
    console.error(`${prefix}exited with code ${code}; stopping`)
    stop(code ?? 1)
  })
  children.push(child)
}
function stop(code: number) {
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 3000).unref()
  Promise.all(children.map(child => {
    if (child.exitCode !== null) return undefined
    const { promise, resolve } = Promise.withResolvers<void>()
    child.once('exit', () => resolve())
    return promise
  })).then(() => process.exit(code))
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

const api = ['src/server.ts', '--config', values.config!, '--port', apiPort]
if (values.project) api.push('--project', values.project)
start('api', 36, 'bun', api, root, {})
start('web', 35, 'node', [next, 'dev', '--port', webPort], web, { HIVEMIND_API_URL: `http://127.0.0.1:${apiPort}` })
console.log(`Hivemind web  → http://localhost:${webPort}\nHivemind API  → http://127.0.0.1:${apiPort}\nTUI           → bun run tui`)
