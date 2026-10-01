// Agents: configured personas with runtime, live activity, capabilities, and effective permissions.
import { api } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Avatar, Badge, Empty, ErrorNote, PageHeader, useAsync } from "../ui";

type AgentRow = {
  name: string;
  runtime: string;
  state: string;
  queued: number;
  running: number;
  capabilities: string[];
  permissions: string[];
  roles: string[];
  workspace?: string;
};

async function load(): Promise<{ rows: AgentRow[]; scheduler: boolean }> {
  const [agents, instances, access, workspaces] = await Promise.all([
    api.agents(),
    api.instances(),
    api.accessPersonas(),
    api.workspaces(),
  ]);
  const details = await Promise.all(agents.agents.map((a) => api.agent(a.name).catch(() => ({}))));
  const rows = agents.agents.map((a, i) => {
    const inst = instances.agents.find((x) => x.persona === a.name);
    const acc = access.personas.find((x) => x.id === a.name);
    return {
      name: a.name,
      runtime: a.runtime,
      state: inst?.state ?? "idle",
      queued: inst?.queued_wakes ?? 0,
      running: inst?.running.length ?? 0,
      capabilities: ((details[i] as { capabilities?: string[] }).capabilities ?? []) as string[],
      permissions: acc?.permissions ?? [],
      roles: acc?.roles ?? [],
      workspace: workspaces.personas.find((p) => p.id === a.name)?.workspace,
    };
  });
  return { rows, scheduler: instances.scheduler_enabled };
}

export function Agents() {
  const data = useAsync(load, []);
  useRefreshOn((e) => e.type === "agent.activity.changed" || e.type.startsWith("runtime."), data.reload, [data.reload]);
  return (
    <div className="page">
      <PageHeader
        title="Agents"
        sub={
          data.data
            ? `${data.data.rows.length} personas · task scheduler ${data.data.scheduler ? "running" : "off"}`
            : undefined
        }
      />
      <ErrorNote error={data.error} />
      {data.data?.rows.length === 0 && <Empty>No personas configured.</Empty>}
      <div className="cards">
        {data.data?.rows.map((a) => (
          <div className="card agent-card" key={a.name}>
            <div className="agent-head">
              <Avatar name={a.name} />
              <div className="grow">
                <h3>{a.name}</h3>
                <div className="muted small">runtime {a.runtime}</div>
              </div>
              <Badge value={a.state} />
            </div>
            <dl>
              <dt>Workspace</dt>
              <dd className="mono small">{a.workspace ?? "—"}</dd>
              <dt>Capabilities</dt>
              <dd>{a.capabilities.length ? a.capabilities.map((c) => <span key={c} className="tag">{c}</span>) : <span className="muted">none</span>}</dd>
              <dt>Permissions</dt>
              <dd>
                {a.permissions.length ? (
                  a.permissions.map((p) => <span key={p} className="tag perm">{p}</span>)
                ) : (
                  <span className="muted">none</span>
                )}
              </dd>
              {a.roles.length > 0 && (
                <>
                  <dt>Roles</dt>
                  <dd>{a.roles.map((r) => <span key={r} className="tag">{r}</span>)}</dd>
                </>
              )}
              <dt>Work</dt>
              <dd>
                {a.running} running · {a.queued} queued wakes
              </dd>
            </dl>
            <a className="button ghost" href={href("rooms", `solo-${a.name}`)}>
              Message {a.name}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
