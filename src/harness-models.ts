import { runProcess } from './harnesses.js'

export interface ModelTarget { type: string; executable?: string; executableArgs: string[]; cwd?: string }
export interface ModelListing { models: string[]; error?: string }
/** Lists selectable models for a native harness, injectable so tests never spawn real CLIs. */
export interface HarnessModelLister { list(target: ModelTarget): Promise<ModelListing> }

export const MODEL_LIST_TIMEOUT_MS = 15_000
export const MODEL_CACHE_MS = 60_000

/** `opencode models` prints one `provider/model` per line. */
export function parseOpenCodeModels(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(line => /^\S+\/\S+$/.test(line)))]
}

/** `pi --list-models` prints a `provider model ...` table; `--model provider/id` is accepted, so join them. */
export function parsePiModels(output: string): string[] {
  const rows = output.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(cells => cells.length >= 2)
  const header = rows[0]?.[0] === 'provider' && rows[0]?.[1] === 'model' ? 1 : 0
  return [...new Set(rows.slice(header).map(([provider, model]) => `${provider}/${model}`))]
}

async function listFromCli(target: ModelTarget): Promise<ModelListing> {
  const opencode = target.type === 'opencode'
  if (!opencode && target.type !== 'pi') return { models: [] }
  const command = target.executable ?? target.type
  const args = [...target.executableArgs, ...(opencode ? ['models'] : ['--list-models'])]
  // The CLIs occasionally exit with no output (e.g. while refreshing their model cache), so retry once before reporting failure.
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output = await runProcess({ command, args, cwd: target.cwd, maxOutputBytes: 4 * 1024 * 1024 }, '', AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS))
      const models = (opencode ? parseOpenCodeModels : parsePiModels)(output)
      if (models.length) return { models }
    }
    return { models: [], error: `${command} returned no models` }
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export const defaultHarnessModelLister: HarnessModelLister = { list: listFromCli }
