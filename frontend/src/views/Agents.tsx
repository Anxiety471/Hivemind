// Agents: create, edit and delete the personas Hivemind runs, with their runtime, workspace,
// capabilities and permissions, next to their live activity.
import { useState } from "react";
import { api, type AgentConfig, type ChatGroup } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Icon } from "../icons";
import { Avatar, Empty, ErrorNote, TopBar, useAction, useAsync } from "../ui";
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

export function Agents({ create = false }: { create?: boolean }) {
  const data = useAsync(load, []);
  const [creating, setCreating] = useState(create);
  const [editing, setEditing] = useState<string | null>(null);
  useRefreshOn(
    (e) => e.type === "agent.activity.changed" || e.type.startsWith("runtime.") || e.type === "config.changed",
    data.reload,
    [data.reload],
  );
  const editingRow = data.data?.rows.some((r) => r.name === editing) ? editing : null;
  const rows = data.data?.rows ?? [];
  const busy = rows.filter((r) => r.running > 0).length;
  return (
    <div className="view">
      <TopBar
        icon="agents"
        title="Agents"
        count={data.data ? rows.length : undefined}
        actions={
          <>
            {data.data && (
              <span className="chip" title="The coordination scheduler dispatches task work to agents">
                <span className={data.data.scheduler ? "dot-live" : "dot-off"} /> Scheduler {data.data.scheduler ? "running" : "off"}
              </span>
            )}
            <button className="primary small" onClick={() => setCreating(true)} disabled={creating}>
              <Icon name="plus" size={14} /> New agent
            </button>
          </>
        }
      >
        {data.data && <span className="muted small">{busy} working · {rows.length - busy} idle</span>}
      </TopBar>
      <div className="view-body">
        <ErrorNote error={data.error} />
        {creating && data.data && (
          <AgentForm
            mode="create"
            initial={BLANK}
            library={data.data.library}
            knownCapabilities={data.data.capabilities}
            existing={rows.map((r) => r.name)}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              data.reload();
            }}
          />
        )}
        {data.data && rows.length === 0 && !creating && <Empty>No agents configured.</Empty>}
        {rows.length > 0 && !editingRow && (
          <div className="rows">
            <div className="rows-head agent-grid">
              <span>Name</span>
              <span>Status</span>
              <span>Capabilities</span>
              <span>Workspace</span>
              <span />
            </div>
            {rows.map((row) => (
              <AgentRowView key={row.name} row={row} loaded={data.data!} onEdit={setEditing} onChanged={data.reload} />
            ))}
          </div>
        )}
        {editingRow && data.data && (
          <AgentForm
            mode="edit"
            id={editingRow}
            initial={rows.find((r) => r.name === editingRow)!.config}
            library={data.data.library}
            knownCapabilities={data.data.capabilities}
            existing={[]}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              data.reload();
            }}
          />
        )}
      </div>
    </div>
  );
}

const STATE_DOT: Record<string, string> = { working: "progress", running: "progress", waiting: "review", queued: "attention", idle: "idle", offline: "idle" };

function AgentRowView(props: { row: AgentRow; loaded: Loaded; onEdit: (name: string | null) => void; onChanged: () => void }) {
  const { row, loaded, onEdit, onChanged } = props;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const del = useAction();
  const c = row.config;
  const overridden = loaded.groups.filter((g) => g.members.includes(row.name) && g.workspace);
  const inGroups = loaded.groups.filter((g) => g.members.includes(row.name));

  return (
    <article className="agent-row" data-agent={row.name} data-open={open}>
      <div className="row-item agent-grid" onClick={() => setOpen(!open)}>
        <span className="agent-name">
          <Avatar name={row.name} />
          <span className="agent-name-text">
            <strong>{row.name}</strong>
            <span className="muted small">
              {c.role ?? "agent"} · {c.runtime}
              {c.model ? ` · ${c.model}` : ""}
            </span>
          </span>
        </span>
        <span className="agent-state">
          <span className={`state-dot st-${STATE_DOT[row.state] ?? "idle"}`} />
          <span className="cap">{row.state.replace(/_/g, " ")}</span>
          {(row.running > 0 || row.queued > 0) && (
            <span className="muted small">
              {row.running} running · {row.queued} queued
            </span>
          )}
        </span>
        <span className="tags">
          {c.capabilities.length ? c.capabilities.map((t) => <span key={t} className="chip">{t}</span>) : <span className="muted small">none</span>}
        </span>
        <span className="mono small muted ellipsis" title={c.workspace}>
          {c.workspace || "—"}
        </span>
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <a className="icon-btn" href={href("rooms", `solo-${row.name}`)} title={`Message ${row.name}`} aria-label={`Message ${row.name}`}>
            <Icon name="rooms" size={14} />
          </a>
          <button className="ghost small" onClick={() => onEdit(row.name)}>
            Edit
          </button>
          <button className="ghost small" onClick={() => setConfirming(true)}>
            Delete
          </button>
          <span className="chev" data-open={open}>
            <Icon name="chevron" size={12} />
          </span>
        </span>
      </div>
      {confirming && (
        <div className="confirm" role="alertdialog" aria-label={`Delete ${row.name}`}>
          <p>
            Delete <strong>{row.name}</strong>?{" "}
            {inGroups.length > 0
              ? `It is still in ${inGroups.map((g) => g.id).join(", ")}; remove it from those groups first.`
              : "Its configuration is removed; past conversations stay in the history."}
          </p>
          <ErrorNote error={del.error} />
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
      )}
      {open && (
        <dl className="agent-detail">
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
          <dt>Permissions</dt>
          <dd className="tags">
            {row.resolvedPermissions.length ? (
              row.resolvedPermissions.map((p) => <span key={p} className="chip perm">{p}</span>)
            ) : (
              <span className="muted">none</span>
            )}
          </dd>
          {row.resolvedRoles.length > 0 && (
            <>
              <dt>Roles</dt>
              <dd className="tags">{row.resolvedRoles.map((r) => <span key={r} className="chip">{r}</span>)}</dd>
            </>
          )}
          <dt>Groups</dt>
          <dd>{inGroups.length ? inGroups.map((g) => g.id).join(", ") : <span className="muted">none</span>}</dd>
          <dt>Work</dt>
          <dd>
            {row.running} running · {row.queued} queued wakes
          </dd>
        </dl>
      )}
    </article>
  );
}
