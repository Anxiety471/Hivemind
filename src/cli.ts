import { parseArgs } from 'node:util'
import { fromConfig } from './config.js'
import { applyProject, resolveProject } from './projects.js'
import type { Config } from './config-file.js'
import { addAgent, assertRunnable, formatFor, loadConfig, removeAgent, removeHarness, saveConfig, serializeConfig,
  withAgentHarness, withHarnessPatch, withLimits, withRouter } from './config-file.js'

function pair(value: string, flag: string): [string, string] {
  const at = value.indexOf('=')
  if (at <= 0 || at === value.length - 1) throw new Error(`${flag} expects <id>=<value>, received "${value}"`)
  return [value.slice(0, at), value.slice(at + 1)]
}

async function main() {
  // parseArgs has no optional string values, so a bare `--migrate-config` is normalized to an empty value here.
  const argv = process.argv.slice(2)
  const migrateAt = argv.indexOf('--migrate-config')
  if (migrateAt !== -1 && (argv[migrateAt + 1] === undefined || argv[migrateAt + 1]!.startsWith('-'))) argv.splice(migrateAt + 1, 0, '')
  const { values } = parseArgs({ args: argv, options: {
    config: { type: 'string', default: 'examples/demo.json' }, task: { type: 'string' }, project: { type: 'string' },
    graph: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    tui: { type: 'boolean', default: false },
    'show-config': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    'set-router': { type: 'string' }, 'set-max-attempts': { type: 'string' }, 'set-timeout-ms': { type: 'string' },
    'set-agent-harness': { type: 'string' }, 'set-harness-model': { type: 'string' }, 'set-harness-cwd': { type: 'string' },
    'add-agent': { type: 'string' }, 'remove-agent': { type: 'string' }, 'remove-harness': { type: 'string' },
    'migrate-config': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  } })
  if (values.help) {
    console.log(`Hivemind — TypeScript LangGraph CLI
Usage: npm run dev -- --config <file> --task <request> [--json]
       npm run dev -- --config <file> --graph
       npm run tui -- --config <file> [--project <dir>]

--tui    Open the interactive terminal UI (also the default in a terminal without --task)
         Inside the TUI, /help lists slash commands such as /settings and /cwd
--project <dir>  Directory agents work in; defaults to the current terminal directory
--graph  Print the workflow as Mermaid without invoking any models
--json   Print the complete result and execution events as JSON

Edit the config file in place; a .toml extension selects TOML, anything else selects JSON.
--show-config    Print the effective config in the file's format and exit
--dry-run        Print what the setters would save instead of writing the file
--set-router <rule|model:AGENT>
--set-max-attempts <1..100>
--set-timeout-ms <positive integer>
--set-agent-harness <agentId>=<harnessId>
--set-harness-model <harnessId>=<model>
--set-harness-cwd <harnessId>=<path>
--add-agent <id>:<role>:<harnessId>   role is worker, reviewer, or router
--remove-agent <id>
--remove-harness <id>
--migrate-config [outPath]   Write --config as TOML (default: same path with a .toml extension)

Setters apply in the order listed, then the config is validated and saved before any run.
Demo: npm run demo
Config paths are relative to your current directory; relative harness cwd values resolve against the project directory.
API keys are read from environment variables; optionally use Node's --env-file=.env.`)
    return
  }
  if (values.tui && (values.graph || values.json)) throw new Error('--tui cannot be combined with --graph or --json')
  const project = values.project === undefined ? undefined : await resolveProject(values.project)
  let configPath = values.config
  if (values['migrate-config'] !== undefined) {
    const target = values['migrate-config'] || `${configPath.replace(/\.[^./\\]+$/, '')}.toml`
    const migrated = await loadConfig(configPath)
    assertRunnable(migrated)
    await saveConfig(target, migrated)
    console.log(`Wrote ${target}`)
    if (!values.task && !values.graph && !values['show-config']) return
    configPath = target
  }
  // Setters are collected first and applied in this exact order, then validated and saved before any run.
  const setters: Array<(config: Config) => Config> = []
  const routerValue = values['set-router']
  if (routerValue !== undefined) setters.push(current => {
    if (routerValue === 'rule') return withRouter(current, { type: 'rule' })
    if (!routerValue.startsWith('model:') || routerValue.length === 'model:'.length)
      throw new Error(`--set-router expects rule or model:<agentId>, received "${routerValue}"`)
    const agent = routerValue.slice('model:'.length)
    if (!current.agents.some(entry => entry.id === agent && entry.role === 'router'))
      throw new Error(`--set-router model:${agent} needs an existing agent with role "router"`)
    return withRouter(current, { type: 'model', agent })
  })
  const attemptsValue = values['set-max-attempts']
  if (attemptsValue !== undefined) setters.push(current => {
    if (!/^\d+$/.test(attemptsValue) || Number(attemptsValue) < 1 || Number(attemptsValue) > 100)
      throw new Error(`--set-max-attempts expects an integer 1..100, received "${attemptsValue}"`)
    return withLimits(current, { maxAttempts: Number(attemptsValue) })
  })
  const timeoutValue = values['set-timeout-ms']
  if (timeoutValue !== undefined) setters.push(current => {
    if (!/^\d+$/.test(timeoutValue) || Number(timeoutValue) < 1)
      throw new Error(`--set-timeout-ms expects a positive integer, received "${timeoutValue}"`)
    return withLimits(current, { timeoutMs: Number(timeoutValue) })
  })
  const agentHarnessValue = values['set-agent-harness']
  if (agentHarnessValue !== undefined) {
    const [agentId, harnessId] = pair(agentHarnessValue, '--set-agent-harness')
    setters.push(current => withAgentHarness(current, agentId, harnessId))
  }
  const harnessModelValue = values['set-harness-model']
  if (harnessModelValue !== undefined) {
    const [harnessId, model] = pair(harnessModelValue, '--set-harness-model')
    setters.push(current => withHarnessPatch(current, harnessId, { model }))
  }
  const harnessCwdValue = values['set-harness-cwd']
  if (harnessCwdValue !== undefined) {
    const [harnessId, cwd] = pair(harnessCwdValue, '--set-harness-cwd')
    setters.push(current => withHarnessPatch(current, harnessId, { cwd }))
  }
  const addAgentValue = values['add-agent']
  if (addAgentValue !== undefined) {
    const parts = addAgentValue.split(':')
    const [id, role, harness] = parts
    if (parts.length !== 3 || !id || !role || !harness) throw new Error('--add-agent expects <id>:<role>:<harnessId>')
    if (role !== 'worker' && role !== 'reviewer' && role !== 'router')
      throw new Error(`--add-agent role must be worker, reviewer, or router, received "${role}"`)
    setters.push(current => addAgent(current, { id, role, harness }))
  }
  const removeAgentValue = values['remove-agent']
  if (removeAgentValue !== undefined) setters.push(current => removeAgent(current, removeAgentValue))
  const removeHarnessValue = values['remove-harness']
  if (removeHarnessValue !== undefined) setters.push(current => removeHarness(current, removeHarnessValue))
  let config: Config = await loadConfig(configPath)
  for (const apply of setters) config = apply(config)
  if (setters.length) {
    assertRunnable(config)
    if (values['dry-run']) {
      if (!values['show-config']) console.log(serializeConfig(config, formatFor(configPath)))
    } else await saveConfig(configPath, config)
  }
  if (values['show-config']) {
    console.log(serializeConfig(config, formatFor(configPath)))
    return
  }
  if ((setters.length || values['dry-run']) && !values.task && !values.graph && !values.tui) return
  if (values.tui || (!values.task && !values.graph && !values.json && process.stdin.isTTY && process.stdout.isTTY)) {
    // Static import cannot work: the TUI pulls in ink/React, which plain --task runs should never load.
    const { launchTui } = await import('./tui.js')
    await launchTui(config, configPath, values.task, project)
    return
  }
  const runtime = fromConfig(values.task ? applyProject(config, project ?? process.cwd()) : config)
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
