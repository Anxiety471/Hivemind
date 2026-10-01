// Agents: create, edit and delete the personas Hivemind runs, with their runtime, workspace,
// capabilities and permissions, next to their live activity.
import { useMemo, useState } from "react";
import { api, type AgentConfig, type ChatGroup } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Avatar, Badge, Empty, ErrorNote, PageHeader, useAction, useAsync } from "../ui";

type AgentRow = {
  name: string;
  state: string;
  queued: number;
  running: number;
  config: AgentConfig;
  resolvedPermissions: string[];
  resolvedRoles: string[];
};

type Loaded = { rows: AgentRow[]; scheduler: boolean; library: string[]; groups: ChatGroup[] };

async function load(): Promise<Loaded> {
  const [agents, instances, access, workspaces, groups] = await Promise.all([
    api.agents(),
    api.instances(),
    api.accessPersonas(),
    api.workspaces(),
    api.chatGroups(),
  ]);
  const details = await Promise.all(agents.agents.map((a) => api.agent(a.name)));
  const rows = agents.agents.map((a, i): AgentRow => {
    const inst = instances.agents.find((x) => x.persona === a.name);
    const acc = access.personas.find((x) => x.id === a.name);
    return {
      name: a.name,
      state: inst?.state ?? "idle",
      queued: inst?.queued_wakes ?? 0,
      running: inst?.running.length ?? 0,
      config: details[i].config,
      resolvedPermissions: acc?.permissions ?? [],
      resolvedRoles: acc?.roles ?? [],
    };
  });
  const library = [
    ...new Set([...workspaces.known, ...workspaces.personas.map((p) => p.workspace)]),
  ].sort();
  return { rows, scheduler: instances.scheduler_enabled, library, groups: groups.groups };
}

const split = (text: string) =>
  text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

const BLANK: AgentConfig = {
  runtime: "omp",
  system_prompt: "",
  workspace: "",
  model: null,
  reasoning: null,
  fast: null,
  role: null,
  capabilities: [],
  permissions: [],
  roles: [],
};

export function Agents() {
  const data = useAsync(load, []);
  const [creating, setCreating] = useState(false);
  useRefreshOn(
    (e) => e.type === "agent.activity.changed" || e.type.startsWith("runtime.") || e.type === "config.changed",
    data.reload,
    [data.reload],
  );
  return (
    <div className="page">
      <PageHeader
        title="Agents"
        sub={
          data.data
            ? `${data.data.rows.length} agents · task scheduler ${data.data.scheduler ? "running" : "off"}`
            : undefined
        }
      >
        <button className="primary" onClick={() => setCreating(true)} disabled={creating}>
          New agent
        </button>
      </PageHeader>
      <ErrorNote error={data.error} />
      {creating && data.data && (
        <AgentForm
          mode="create"
          initial={BLANK}
          library={data.data.library}
          existing={data.data.rows.map((r) => r.name)}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            data.reload();
          }}
        />
      )}
      {data.data?.rows.length === 0 && !creating && <Empty>No agents configured.</Empty>}
      <div className="cards">
        {data.data?.rows.map((row) => (
          <AgentCard key={row.name} row={row} loaded={data.data!} onChanged={data.reload} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ row, loaded, onChanged }: { row: AgentRow; loaded: Loaded; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const del = useAction();
  const c = row.config;
  const overridden = loaded.groups.filter((g) => g.members.includes(row.name) && g.workspace);
  const inGroups = loaded.groups.filter((g) => g.members.includes(row.name));

  if (editing)
    return (
      <AgentForm
        mode="edit"
        id={row.name}
        initial={c}
        library={loaded.library}
        existing={[]}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );

  return (
    <div className="card agent-card" data-agent={row.name}>
      <div className="agent-head">
        <Avatar name={row.name} />
        <div className="grow">
          <h3>{row.name}</h3>
          <div className="muted small">
            runtime {c.runtime}
            {c.model ? ` · ${c.model}` : ""}
          </div>
        </div>
        <Badge value={row.state} />
      </div>
      <dl>
        <dt>Agent workspace</dt>
        <dd className="mono small">{c.workspace || "—"}</dd>
        {overridden.length > 0 && (
          <>
            <dt>Group workspaces</dt>
            <dd className="small">
              {overridden.map((g) => (
                <div key={g.id}>
                  <strong>{g.id}</strong> <span className="mono muted">{g.workspace}</span>
                </div>
              ))}
              <span className="muted">Inside these groups the shared workspace is used instead.</span>
            </dd>
          </>
        )}
        <dt>Capabilities</dt>
        <dd>{c.capabilities.length ? c.capabilities.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted">none</span>}</dd>
        <dt>Permissions</dt>
        <dd>
          {row.resolvedPermissions.length ? (
            row.resolvedPermissions.map((p) => <span key={p} className="tag perm">{p}</span>)
          ) : (
            <span className="muted">none</span>
          )}
        </dd>
        {row.resolvedRoles.length > 0 && (
          <>
            <dt>Roles</dt>
            <dd>{row.resolvedRoles.map((r) => <span key={r} className="tag">{r}</span>)}</dd>
          </>
        )}
        <dt>Work</dt>
        <dd>
          {row.running} running · {row.queued} queued wakes
        </dd>
      </dl>
      <ErrorNote error={del.error} />
      {confirming ? (
        <div className="confirm" role="alertdialog" aria-label={`Delete ${row.name}`}>
          <p>
            Delete <strong>{row.name}</strong>?{" "}
            {inGroups.length > 0
              ? `It is still in ${inGroups.map((g) => g.id).join(", ")}; remove it from those groups first.`
              : "Its configuration is removed; past conversations stay in the history."}
          </p>
          <div className="row">
            <button
              className="danger"
              disabled={del.busy}
              onClick={() =>
                del.run(async () => {
                  await api.deleteAgent(row.name);
                  setConfirming(false);
                  onChanged();
                })
              }
            >
              Confirm delete
            </button>
            <button className="ghost" onClick={() => (setConfirming(false), del.setError(null))}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <a className="button ghost" href={href("rooms", `solo-${row.name}`)}>
            Message {row.name}
          </a>
          <button className="ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="ghost" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

const CUSTOM = "__custom__";

/** Create or edit one agent. Everything typed stays put when a save fails or the list refreshes. */
function AgentForm(props: {
  mode: "create" | "edit";
  id?: string;
  initial: AgentConfig;
  library: string[];
  existing: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { initial } = props;
  const [id, setId] = useState(props.id ?? "");
  const [runtime, setRuntime] = useState(initial.runtime);
  const [model, setModel] = useState(initial.model ?? "");
  const [reasoning, setReasoning] = useState(initial.reasoning ?? "");
  const [fast, setFast] = useState(initial.fast === true);
  const [role, setRole] = useState(initial.role ?? "");
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [prompt, setPrompt] = useState(initial.system_prompt);
  const [capabilities, setCapabilities] = useState(initial.capabilities.join(", "));
  const [roles, setRoles] = useState(initial.roles.join(", "));
  const [permissions, setPermissions] = useState(initial.permissions.join(", "));
  const action = useAction();

  // The server's copy moved on while this form is open (another tab, the CLI): keep the
  // user's edits and say so, instead of silently replacing them.
  const baseline = useMemo(() => JSON.stringify(initial), [initial]);
  const [firstBaseline] = useState(baseline);
  const changedElsewhere = props.mode === "edit" && baseline !== firstBaseline;

  const [custom, setCustom] = useState(!!workspace && !props.library.includes(workspace));

  const idTaken = props.mode === "create" && props.existing.some((n) => n.toLowerCase() === id.trim().toLowerCase());
  const body = (): Partial<AgentConfig> => ({
    runtime,
    system_prompt: prompt,
    workspace: workspace.trim() || undefined,
    model: model.trim() || null,
    reasoning: reasoning.trim() || null,
    fast: fast ? true : null,
    role: role.trim() || null,
    capabilities: split(capabilities),
    permissions: split(permissions),
    roles: split(roles),
  });
  const save = () =>
    action.run(async () => {
      if (props.mode === "create") await api.createAgent(id.trim(), body());
      else await api.updateAgent(props.id!, body());
      props.onSaved();
    });

  return (
    <div className="card form agent-form" data-form={props.mode}>
      <h3>{props.mode === "create" ? "New agent" : `Edit ${props.id}`}</h3>
      {changedElsewhere && (
        <div className="warn-note">This agent was changed elsewhere while you were editing. Your edits are kept; saving overwrites it.</div>
      )}
      {props.mode === "create" && (
        <label>
          Agent id
          <input value={id} placeholder="e.g. Designer" onChange={(e) => setId((e.target as HTMLInputElement).value)} />
          {idTaken && <span className="field-error">An agent with this id already exists.</span>}
        </label>
      )}
      <div className="form-grid">
        <label>
          Runtime
          <select value={runtime} onChange={(e) => setRuntime((e.target as HTMLSelectElement).value as AgentConfig["runtime"])}>
            <option value="omp">omp</option>
            <option value="pi">pi</option>
            <option value="opencode">opencode</option>
          </select>
        </label>
        <label>
          Model
          <input value={model} placeholder="provider/model-id (optional)" onChange={(e) => setModel((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Reasoning
          <input
            value={reasoning}
            placeholder="e.g. high (optional)"
            onChange={(e) => setReasoning((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Role
          <input value={role} placeholder="short title (optional)" onChange={(e) => setRole((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={fast} onChange={(e) => setFast((e.target as HTMLInputElement).checked)} />
        Fast mode
      </label>
      <label>
        Agent workspace
        <select
          value={custom ? CUSTOM : workspace}
          onChange={(e) => {
            const value = (e.target as HTMLSelectElement).value;
            if (value === CUSTOM) setCustom(true);
            else (setCustom(false), setWorkspace(value));
          }}
        >
          <option value="">Server default</option>
          {props.library.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
          <option value={CUSTOM}>Other path…</option>
        </select>
        {custom && (
          <input
            className="mono"
            value={workspace}
            placeholder="/absolute/path/to/directory"
            onChange={(e) => setWorkspace((e.target as HTMLInputElement).value)}
          />
        )}
        <span className="hint">
          The agent's own directory, used in direct messages and the main conversation. A group's shared workspace, set in that
          group's room settings, replaces it inside that group only.
        </span>
      </label>
      <label>
        System prompt
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} />
      </label>
      <div className="form-grid">
        <label>
          Capabilities
          <input value={capabilities} placeholder="comma separated" onChange={(e) => setCapabilities((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Roles
          <input value={roles} placeholder="comma separated" onChange={(e) => setRoles((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Extra permissions
          <input
            value={permissions}
            placeholder="comma separated"
            onChange={(e) => setPermissions((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      <ErrorNote error={action.error} />
      <div className="row">
        <button className="primary" disabled={action.busy || idTaken || (props.mode === "create" && !id.trim())} onClick={save}>
          {props.mode === "create" ? "Create agent" : "Save changes"}
        </button>
        <button className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
