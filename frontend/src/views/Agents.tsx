// Agents: create, edit and delete the personas Hivemind runs, with their runtime, workspace,
// capabilities and permissions, next to their live activity.
import { useState } from "react";
import { api, type AgentConfig, type ChatGroup } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Avatar, Badge, Empty, ErrorNote, PageHeader, useAction, useAsync } from "../ui";
import { AgentForm } from "./AgentForm";

type AgentRow = {
  name: string;
  state: string;
  queued: number;
  running: number;
  config: AgentConfig;
  resolvedPermissions: string[];
  resolvedRoles: string[];
};

type Loaded = { rows: AgentRow[]; scheduler: boolean; library: string[]; capabilities: string[]; groups: ChatGroup[] };

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
  const capabilities = [...new Set(rows.flatMap((r) => r.config.capabilities))].sort();
  return { rows, scheduler: instances.scheduler_enabled, library, capabilities, groups: groups.groups };
}

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
  const [editing, setEditing] = useState<string | null>(null);
  useRefreshOn(
    (e) => e.type === "agent.activity.changed" || e.type.startsWith("runtime.") || e.type === "config.changed",
    data.reload,
    [data.reload],
  );
  const editingRow = data.data?.rows.some((r) => r.name === editing) ? editing : null;
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
          knownCapabilities={data.data.capabilities}
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
        {data.data?.rows
          // While one agent is being edited, the others are out of the way.
          .filter((row) => !editingRow || row.name === editingRow)
          .map((row) => (
            <AgentCard key={row.name} row={row} loaded={data.data!} editing={row.name === editingRow} onEdit={setEditing} onChanged={data.reload} />
          ))}
      </div>
    </div>
  );
}

function AgentCard(props: { row: AgentRow; loaded: Loaded; editing: boolean; onEdit: (name: string | null) => void; onChanged: () => void }) {
  const { row, loaded, editing, onEdit, onChanged } = props;
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
        knownCapabilities={loaded.capabilities}
        existing={[]}
        onCancel={() => onEdit(null)}
        onSaved={() => {
          onEdit(null);
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
          <button className="ghost" onClick={() => onEdit(row.name)}>
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

