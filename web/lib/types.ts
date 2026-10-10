// Mirrors the Hivemind HTTP API contract (src/server.ts) and the config schema (src/config.ts).

export type RunStatus = 'running' | 'completed' | 'blocked' | 'exhausted'
export type RunPhaseStatus = RunStatus | 'failed' | 'cancelled'
export type NodeName = 'decide' | 'research' | 'plan' | 'design' | 'work' | 'review'
export type StageName = 'research' | 'plan' | 'design' | 'work'

export interface StageTask {
  agent: string
  role?: Role
  instructions: string
}

export interface DispatchStage {
  stage: StageName
  tasks: StageTask[]
}

export interface Progress {
  node: NodeName
  phase: 'start' | 'end'
  attempt: number
  message: string
  at?: string
  artifact?: string
  status?: RunStatus
  retry?: number
  decision?: Decision
}

export type Decision =
  | { action: 'work'; agent: string; instructions: string; reason: string }
  | { action: 'dispatch'; stages: DispatchStage[]; reason: string }
  | { action: 'finish'; reason: string }
  | { action: 'block'; reason: string }
export interface RunEvent { node: string; attempt: number; message: string }

export interface RunState {
  task: string
  artifact: string
  feedback: string
  attempts: number
  status: RunStatus
  approved: boolean
  decision: Decision | null
  events: RunEvent[]
}

export interface Run {
  id: string
  task: string
  project: string
  status: RunPhaseStatus
  progress: Progress[]
  result?: RunState
  error?: string
  startedAt: string
  endedAt?: string
}

export type Role = 'worker' | 'reviewer' | 'router' | 'planner' | 'designer' | 'researcher'

export interface AgentConfig { id: string; role: Role; harness: string; description: string; model?: string }

interface NativeFields {
  executable?: string
  executableArgs: string[]
  cwd?: string
  model?: string
  maxOutputBytes: number
}

export type HarnessConfig =
  | { type: 'demo' }
  | ({ type: 'opencode'; agent?: string; variant?: string } & NativeFields)
  | ({ type: 'pi'; provider?: string; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; tools?: string[] } & NativeFields)
  | { type: 'command'; command: string; args: string[]; cwd?: string; maxOutputBytes: number }
  | { type: 'openai-compatible'; baseUrl: string; model: string; apiKeyEnv: string; maxTokens: number }

export type RouterConfig = { type: 'rule' } | { type: 'model'; agent: string }

export interface Config {
  maxAttempts: number
  harnessRetries: number
  timeoutMs: number
  harnesses: Record<string, HarnessConfig>
  agents: AgentConfig[]
  router: RouterConfig
}

export interface ConfigResponse { path: string; project: string; config: Config }
export interface ProjectsResponse { current: string; recent: string[] }
export interface DirectoriesResponse { path: string; parent: string | null; directories: string[] }

export interface HarnessCatalogEntry {
  type: 'opencode' | 'pi'
  name: string
  description: string
  executable: string
  installed: boolean
  path?: string
  version?: string
  installable: boolean
  installCommand: string
}
export interface HarnessCatalogResponse { harnesses: HarnessCatalogEntry[]; installer: 'bun' | 'npm' | null; config: ConfigResponse }
export interface HarnessInstallResponse { entry: HarnessCatalogEntry; output: string }
export interface HarnessModelsResponse { models: string[]; error?: string }
