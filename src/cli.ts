import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { fromConfig } from './config.js'

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'examples/demo.json' }, task: { type: 'string' },
    graph: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    tui: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } })
  if (values.help) {
    console.log(`Hivemind — TypeScript LangGraph CLI
Usage: npm run dev -- --config <file> --task <request> [--json]
       npm run dev -- --config <file> --graph
       npm run tui -- --config <file>

--tui    Open the interactive terminal UI (also the default in a terminal without --task)
--graph  Print the workflow as Mermaid without invoking any models
--json   Print the complete result and execution events as JSON

Demo: npm run demo
Config paths and command harness working directories are relative to your current directory.
API keys are read from environment variables; optionally use Node's --env-file=.env.`)
    return
  }
  const input: unknown = JSON.parse(await readFile(values.config, 'utf8'))
  if (values.tui && (values.graph || values.json)) throw new Error('--tui cannot be combined with --graph or --json')
  if (values.tui || (!values.task && !values.graph && !values.json && process.stdin.isTTY && process.stdout.isTTY)) {
    const { launchTui } = await import('./tui.js')
    await launchTui(input, values.config, values.task)
    return
  }
  const runtime = fromConfig(input)
  if (values.graph) {
    console.log((await runtime.graph.getGraphAsync()).drawMermaid())
    return
  }
  if (!values.task) throw new Error('Supply --task <request>; use --help for examples')
  const result = await runtime.run(values.task)
  if (values.json) console.log(JSON.stringify(result, null, 2))
  else {
    for (const event of result.events) console.log(`[${event.node} #${event.attempt}] ${event.message}`)
    console.log(`\nStatus: ${result.status}\n\n${result.artifact || result.feedback}`)
  }
  if (result.status !== 'completed') process.exitCode = 2
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Hivemind failed')
  process.exitCode = 1
})
