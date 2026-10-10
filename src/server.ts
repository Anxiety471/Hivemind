import { parseArgs } from 'node:util'
import { createApiApp } from './api.js'
import { resolveProject } from './projects.js'

const HOST = '127.0.0.1'

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'examples/demo.json' }, project: { type: 'string' }, port: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  } })
  if (values.help) {
    console.log(`Hivemind HTTP API (Elysia, run with Bun)
Usage: bun src/server.ts [--config <file>] [--project <dir>] [--port <n>]

--config <file>  Config file served and edited by the API (default examples/demo.json)
--project <dir>  Initial project directory agents work in (default: current directory)
--port <n>       Port on ${HOST} (default: $HIVEMIND_API_PORT or 4100)`)
    return
  }
  const rawPort = values.port ?? process.env.HIVEMIND_API_PORT ?? '4100'
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || port > 65535) throw new Error(`Invalid port "${rawPort}"`)
  const project = await resolveProject(values.project ?? process.cwd())
  const { app, store } = createApiApp({ configPath: values.config, project })
  // idleTimeout 0: event streams stay open for the whole run, longer than Bun's 10s default would allow.
  app.listen({ port, hostname: HOST, idleTimeout: 0 })
  console.log(`Hivemind API listening on http://${HOST}:${app.server?.port ?? port}`)

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    store.shutdown() // aborts runs and finishes every event stream with a final `done`
    setTimeout(() => process.exit(0), 3000).unref()
    void app.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
