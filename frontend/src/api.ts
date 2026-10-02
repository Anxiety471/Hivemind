// Typed client for the Hivemind HTTP API (`/api/v1`). Shapes mirror src/api/*.rs.

export type Participant = { persona_id: string; role: string | null };
export type RoomKind = "main" | "solo" | "group" | "thread" | "archived";

export type Room = {
  id: string;
  name?: string;
  kind: RoomKind;
  mode?: "broadcast" | "discussion";
  participants: Participant[];
  updated_at: number | null;
  message_count: number;
  /** Per-conversation preferences; absent on archived rooms. */
  settings?: RoomPrefs;
  state?: RoomState;
  summary?: string;
  parent_room_id?: string;
  anchor_message_id?: string;
};

export type RoomPrefs = { nickname: string | null; pinned: boolean; muted: boolean };

/** Everything configurable about one conversation, plus why a control may not apply to it. */
export type RoomSettings = {
  room_id: string;
  kind: "main" | "solo" | "group";
  settings: RoomPrefs & {
    mode: "broadcast" | "discussion" | null;
    reply_order: string[];
    workspace: string | null;
  };
  members: string[];
  unavailable: { mode: string | null; reply_order: string | null; workspace: string | null };
};

export type RoomSettingsPatch = Partial<Pick<RoomPrefs, "pinned" | "muted">> & {
  nickname?: string;
  mode?: "broadcast" | "discussion";
  reply_order?: string[];
  /** `null` clears a group's shared workspace. */
  workspace?: string | null;
};

export type RoomState = {
  goal: string | null;
  decisions: string[];
  open_questions: string[];
  completed: string[];
  assignments: Record<string, string>;
};

export type Message = {
  id: string;
  turn_id: string;
  speaker: string;
  content: string;
  created_at: number;
};

export type Thread = {
  id: string;
  name: string;
  parent_room_id: string;
  anchor_message_id: string;
  message_count: number;
  updated_at: number;
};

export type Target =
  | { type: "main" }
  | { type: "solo"; id: string }
  | { type: "group"; id: string }
  | { type: "thread"; id: string };

export type TaskStatus =
  | "submitted"
  | "planning"
  | "ready"
  | "running"
  | "review"
  | "completed"
  | "blocked"
  | "needs_input"
  | "failed"
  | "cancelled";

export type Task = {
  id: string;
  root_id: string;
  parent_id: string | null;
  depth: number;
  kind: string;
  objective: string;
  acceptance: string[];
  capabilities: string[];
  workspace: string;
  coordinator: string;
  owner: string | null;
  reviewer: string | null;
  status: TaskStatus;
  status_reason: string | null;
  revision: number;
  paused: boolean;
  feedback: string[];
  prerequisites: string[];
  created_at: number;
  updated_at: number;
};

export type TaskSummary = Pick<
  Task,
  "id" | "objective" | "owner" | "reviewer" | "status" | "status_reason" | "prerequisites"
>;

export type Artifact = {
  id: string;
  task_id: string;
  attempt_id: string | null;
  kind: string;
  reference: string;
  description: string;
  version: number;
  created_at: number;
};

export type Usage = {
  dispatches: number;
  dispatch_limit: number;
  tool_actions: number;
  tool_action_limit: number;
  messages: number;
  message_limit: number;
  started_at: number;
  deadline: number;
  tokens: number | null;
};

export type TaskDetail = {
  task: Task;
  children: TaskSummary[];
  progress: Record<string, number>;
  artifacts: Artifact[];
  evidence: { check: string; outcome: string; detail: string }[];
  groups: { id: string; purpose?: string; members?: string[] }[];
  usage: Usage | null;
};

export type Attempt = {
  id: string;
  task_id: string;
  kind: "plan" | "work" | "review" | "inbox";
  persona: string;
  instance_id: string;
  runtime_epoch: string | null;
  state: string;
  failure_class: string | null;
  branch: string | null;
  started_at: number;
  ended_at: number | null;
};

export type AgentInstance = {
  persona: string;
  state: string;
  queued_wakes: number;
  running: { attempt_id?: string; task_id?: string; kind?: string }[];
};

export type ChatGroup = {
  id: string;
  room_id: string;
  members: string[];
  mode: "broadcast" | "discussion";
  member_roles: Record<string, string>;
  reply_order: string[];
  workspace: string | null;
};

export type Workspaces = {
  roots: string[];
  /** Workspaces added by the user; they never restrict where agents may work. */
  known: string[];
  groups: { id: string; workspace: string }[];
  personas: { id: string; workspace: string }[];
};

export type ModelOption = {
  /** What is stored on the agent: `provider/model-id`. */
  id: string;
  name: string;
  provider: string;
  /** Reasoning levels this model accepts; empty when it does not reason. */
  reasoning: string[];
  context_window: number | null;
};

export type RuntimeModels = {
  runtime: string;
  models: ModelOption[];
  supports_reasoning: boolean;
  supports_fast: boolean;
};

export type DirListing = {
  path: string;
  parent: string | null;
  home: string | null;
  roots: string[];
  truncated: boolean;
  /** The server's desktop can open its own folder dialog. */
  native_picker: boolean;
  entries: { name: string; path: string }[];
};

export type RoleCatalog = {
  builtin: { name: string; permissions: string[] }[];
  custom: { name: string; permissions: string[] }[];
  permissions: string[];
};

/** The editable definition of an agent. Its id is fixed once created. */
export type AgentConfig = {
  runtime: "pi" | "omp" | "opencode";
  system_prompt: string;
  workspace: string;
  model: string | null;
  reasoning: string | null;
  fast: boolean | null;
  role: string | null;
  capabilities: string[];
  permissions: string[];
  roles: string[];
};

export type AgentDetail = {
  id: string;
  capabilities: string[];
  permissions: string[];
  config: AgentConfig;
};

export type RuntimeSession = {
  id: string;
  agent_instance_id: string;
  persona_id: string;
  runtime: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  rotation: boolean | null;
};

export type AccessPersona = { id: string; permissions: string[]; roles: string[]; restricted: boolean };

export type Settings = { baseUrl: string; token: string };
export type SetupPersona = {
  id: string;
  role: string;
  runtime: "pi" | "omp" | "opencode";
  workspace: string;
  model?: string;
  reasoning?: string;
  fast?: boolean;
  system_prompt: string;
};

const SETTINGS_KEY = "hivemind.settings";

function defaultBase(): string {
  const env = import.meta.env.VITE_HIVEMIND_URL as string | undefined;
  return env || "http://127.0.0.1:7474";
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { baseUrl: defaultBase(), token: "", ...JSON.parse(raw) };
  } catch {
    // Storage can be unavailable; fall back to defaults.
  }
  return { baseUrl: defaultBase(), token: "" };
}

export function hasSavedSettings(): boolean {
  try {
    return localStorage.getItem(SETTINGS_KEY) !== null;
  } catch {
    return false;
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not fatal: settings just won't persist.
  }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let settings = loadSettings();

export function currentSettings() {
  return settings;
}

export function applySettings(next: Settings, persist = true) {
  settings = { ...next, baseUrl: next.baseUrl.replace(/\/+$/, "") };
  if (persist) saveSettings(settings);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (settings.token) headers.authorization = `Bearer ${settings.token}`;
  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "unreachable", `Cannot reach Hivemind at ${settings.baseUrl}`);
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(response.status, error.code ?? "error", error.message ?? response.statusText);
  }
  return data as T;
}

const enc = encodeURIComponent;

export type Skill = { name: string; description: string; argument_hint: string; source: string };

export const api = {
  info: () => request<{ name: string; version: string; api_version: string }>("GET", "/info"),
  setupStatus: () => request<{ setup_required: boolean }>("GET", "/setup"),
  completeSetup: (personas: SetupPersona[]) =>
    request<{ saved: boolean; setup_required: boolean; persona_count: number }>("POST", "/setup", { personas }),
  agents: () => request<{ agents: { name: string; runtime: string }[] }>("GET", "/agents"),
  agent: (id: string) => request<AgentDetail>("GET", `/agents/${enc(id)}`),
  createAgent: (id: string, config: Partial<AgentConfig>) =>
    request<{ id: string; config: AgentConfig }>("POST", "/agents", { id, ...config }),
  updateAgent: (id: string, config: Partial<AgentConfig>) =>
    request<{ id: string; config: AgentConfig }>("PUT", `/agents/${enc(id)}`, config),
  deleteAgent: (id: string) => request<void>("DELETE", `/agents/${enc(id)}`),
  instances: () =>
    request<{ agents: AgentInstance[]; scheduler_enabled: boolean }>("GET", "/agent-instances"),
  accessPersonas: () => request<{ personas: AccessPersona[] }>("GET", "/access/personas"),

  rooms: () => request<{ rooms: Room[] }>("GET", "/rooms"),
  room: (id: string) => request<{ room: Room }>("GET", `/rooms/${enc(id)}`),
  messages: (id: string, before?: string, limit = 50) =>
    request<{ room_id: string; messages: Message[]; next_before: string | null }>(
      "GET",
      `/rooms/${enc(id)}/messages?limit=${limit}${before ? `&before=${enc(before)}` : ""}`,
    ),
  activeReplies: (id: string) =>
    request<{ room_id: string; agents: string[] }>("GET", `/rooms/${enc(id)}/active`),
  roomSettings: (id: string) => request<RoomSettings>("GET", `/rooms/${enc(id)}/settings`),
  updateRoomSettings: (id: string, patch: RoomSettingsPatch) =>
    request<RoomSettings>("PATCH", `/rooms/${enc(id)}/settings`, patch),
  threads: (id: string) => request<{ threads: Thread[] }>("GET", `/rooms/${enc(id)}/threads`),
  createThread: (id: string, anchor_message_id: string, name?: string) =>
    request<{ thread: Thread; created: boolean }>("POST", `/rooms/${enc(id)}/threads`, {
      anchor_message_id,
      name,
    }),
  sendTurn: (target: Target, message: string) =>
    request<{ turn_id: string; room_id: string; status: string }>("POST", "/turns", {
      target,
      message,
      wait: false,
    }),
  cancelTurn: (id: string) => request("POST", `/turns/${enc(id)}/cancel`),

  tasks: (all = false) =>
    request<{ tasks: Task[]; next_after: string | null }>("GET", `/tasks?limit=200${all ? "&all=true" : ""}`),
  task: (id: string) => request<{ task: TaskDetail }>("GET", `/tasks/${enc(id)}`),
  attempts: (id: string) => request<{ attempts: Attempt[] }>("GET", `/tasks/${enc(id)}/attempts`),
  submitTask: (objective: string, acceptance: string[], capabilities: string[]) =>
    request<{ id: string }>("POST", "/tasks", { objective, acceptance, capabilities }),
  taskAction: (id: string, action: "cancel" | "pause" | "resume", body?: unknown) =>
    request<{ task: TaskDetail }>("POST", `/tasks/${enc(id)}/${action}`, body ?? {}),
  taskInput: (id: string, answer: string) =>
    request<{ task: TaskDetail }>("POST", `/tasks/${enc(id)}/input`, { answer }),

  chatGroups: () => request<{ groups: ChatGroup[] }>("GET", "/chat-groups"),
  createChatGroup: (id: string, members: string[]) =>
    request<{ group: ChatGroup }>("POST", "/chat-groups", { id, members }),
  updateChatGroup: (id: string, patch: Partial<Omit<ChatGroup, "id" | "room_id" | "workspace">>) =>
    request<{ group: ChatGroup }>("PATCH", `/chat-groups/${enc(id)}`, patch),
  deleteChatGroup: (id: string) => request<void>("DELETE", `/chat-groups/${enc(id)}`),

  workspaces: () => request<Workspaces>("GET", "/workspaces"),
  runtimeModels: (runtime: string, refresh = false) =>
    request<RuntimeModels>("GET", `/runtimes/${enc(runtime)}/models${refresh ? "?refresh=true" : ""}`),
  dirs: (path: string, hidden: boolean) =>
    request<DirListing>("GET", `/fs/dirs?${new URLSearchParams({ ...(path ? { path } : {}), hidden: String(hidden) })}`),
  pickFolder: (path: string) =>
    request<{ path: string | null }>("POST", `/fs/pick${path ? `?${new URLSearchParams({ path })}` : ""}`, {}),
  accessRoles: () => request<RoleCatalog>("GET", "/access/roles"),
  addWorkspace: (path: string) => request<Workspaces>("POST", "/workspaces", { path }),
  removeWorkspace: (path: string) => request<Workspaces>("DELETE", "/workspaces", { path }),
  setGroupWorkspace: (id: string, path: string) =>
    request<Workspaces>("PUT", `/workspaces/groups/${enc(id)}`, { path }),
  clearGroupWorkspace: (id: string) => request<Workspaces>("DELETE", `/workspaces/groups/${enc(id)}`),
  setPersonaWorkspace: (id: string, path: string) =>
    request<Workspaces>("PUT", `/workspaces/personas/${enc(id)}`, { path }),

  runtimeSessions: (roomId: string) =>
    request<{ sessions: RuntimeSession[] }>("GET", `/rooms/${enc(roomId)}/runtime-sessions?limit=200`),
  rotate: (agent_instance_id: string) => request("POST", "/runtime/rotate", { agent_instance_id }),
  skills: () => request<{ dirs: string[]; skills: Skill[] }>("GET", "/skills"),
  toolCatalog: () => request<{ tools: string[]; namespaces: Record<string, string[]> }>("GET", "/tools"),
};

export function targetFor(room: Room): Target | null {
  switch (room.kind) {
    case "main":
      return { type: "main" };
    case "solo":
      return { type: "solo", id: room.participants[0]?.persona_id ?? room.id.replace(/^solo-/, "") };
    case "group":
      return { type: "group", id: room.id.replace(/^group-/, "") };
    case "thread":
      return { type: "thread", id: room.id };
    default:
      return null;
  }
}

/** Decode `ai1:<len>:<room><len>:<persona>` into its parts. */
export function decodeInstance(id: string): { room: string; persona: string } | null {
  const m = /^ai1:(\d+):/.exec(id);
  if (!m) return null;
  let i = m[0].length;
  const room = id.slice(i, i + Number(m[1]));
  i += Number(m[1]);
  const rest = /^(\d+):/.exec(id.slice(i));
  if (!rest) return null;
  const persona = id.slice(i + rest[0].length, i + rest[0].length + Number(rest[1]));
  return { room, persona };
}
