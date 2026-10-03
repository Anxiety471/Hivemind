// Workspaces: allowed roots, each group's shared workspace, and each persona's own workspace.
import type { ReactNode } from "react";
import { useState } from "react";
import { api, type Workspaces } from "../api";
import { Icon } from "../icons";
import { Avatar, ErrorNote, Section, TopBar, useAction, useAsync } from "../ui";

export function WorkspacesView() {
  const ws = useAsync(() => api.workspaces(), []);
  const groups = useAsync(() => api.chatGroups(), []);
  const data = ws.data;
  const groupIds = groups.data?.groups.map((g) => g.id) ?? [];
  const choices = data ? workspaceChoices(data) : [];

  return (
    <div className="view">
      <TopBar icon="workspaces" title="Workspaces" />
      <div className="view-body settings-body">
      <p className="view-intro muted">
        Paths must be absolute, existing directories inside the allowed roots. A live session in the old directory is replaced before its next turn.
      </p>
      <ErrorNote error={ws.error} />
      {data && (
        <>
          <Section title="Allowed roots" description="Set by [workspaces] roots in hivemind.toml.">
            {data.roots.length ? (
              <ul className="paths">{data.roots.map((r) => <li key={r} className="mono">{r}</li>)}</ul>
            ) : (
              <p className="muted">No roots configured: any existing directory is allowed.</p>
            )}
          </Section>
          <KnownWorkspaces data={data} onUpdated={(next) => ws.setData(next)} />
          <Section title="Group workspaces" description="Inside a group, its shared workspace replaces each member's own.">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Shared workspace</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {groupIds.map((id) => (
                  <PathRow
                    key={id + (data.groups.find((g) => g.id === id)?.workspace ?? "")}
                    label={<span className="inline"><Icon name="group" size={14} /> <strong>{id}</strong></span>}
                    value={data.groups.find((g) => g.id === id)?.workspace ?? ""}
                    options={choices}
                    onSave={(path) => api.setGroupWorkspace(id, path)}
                    onClear={() => api.clearGroupWorkspace(id)}
                    onUpdated={(next) => ws.setData(next)}
                  />
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Persona workspaces" description="Where each agent works outside groups." data-section="persona-workspaces">
            <table>
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>Workspace</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.personas.map((p) => (
                  <PathRow
                    key={p.id + p.workspace}
                    label={
                      <span className="inline">
                        <Avatar name={p.id} /> {p.id}
                      </span>
                    }
                    value={p.workspace}
                    options={choices}
                    onSave={(path) => api.setPersonaWorkspace(p.id, path)}
                    onUpdated={(next) => ws.setData(next)}
                  />
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
      </div>
    </div>
  );
}

/** Every directory worth offering: the ones the user added plus those already in use. */
export function workspaceChoices(w: Workspaces): string[] {
  return [
    ...new Set([...w.known, ...w.personas.map((p) => p.workspace), ...w.groups.flatMap((g) => (g.workspace ? [g.workspace] : []))]),
  ].sort();
}

function KnownWorkspaces({ data, onUpdated }: { data: Workspaces; onUpdated: (w: Workspaces) => void }) {
  const [path, setPath] = useState("");
  const add = useAction();
  const remove = useAction();
  const usedBy = (dir: string) => [
    ...data.personas.filter((p) => p.workspace === dir).map((p) => p.id),
    ...data.groups.filter((g) => g.workspace === dir).map((g) => `group ${g.id}`),
  ];
  return (
    <Section
      title="Workspaces"
      description="Directories you can pick for agents and groups. Adding one never changes the others or restricts where agents may work."
      data-section="workspaces"
    >
      {data.known.length === 0 ? (
        <p className="muted">No workspaces added yet.</p>
      ) : (
        <table>
          <tbody>
            {data.known.map((dir) => {
              const users = usedBy(dir);
              return (
                <tr key={dir}>
                  <td className="mono small grow">{dir}</td>
                  <td className="muted small">{users.length ? `used by ${users.join(", ")}` : "not in use"}</td>
                  <td className="right">
                    <button
                      className="ghost small"
                      disabled={remove.busy || users.length > 0}
                      title={users.length ? "Still in use" : undefined}
                      onClick={() => remove.run(() => api.removeWorkspace(dir).then(onUpdated))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ErrorNote error={remove.error} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!path.trim()) return;
          add.run(() =>
            api.addWorkspace(path.trim()).then((next) => {
              setPath("");
              onUpdated(next);
            }),
          );
        }}
      >
        <input
          className="mono grow"
          value={path}
          aria-label="New workspace path"
          placeholder="/absolute/path/to/another/workspace"
          onChange={(e) => setPath((e.target as HTMLInputElement).value)}
        />
        <button className="primary" type="submit" disabled={add.busy || !path.trim()}>
          Add workspace
        </button>
      </form>
      <ErrorNote error={add.error} />
    </Section>
  );
}

function PathRow(props: {
  label: ReactNode;
  options?: string[];
  value: string;
  onSave: (path: string) => Promise<Workspaces>;
  onClear?: () => Promise<Workspaces>;
  onUpdated: (w: Workspaces) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(props.value);
  const [custom, setCustom] = useState(false);
  const action = useAction();
  const options = props.options ?? [];
  return (
    <tr>
      <td>{props.label}</td>
      <td className="grow">
        {editing ? (
          <>
            {options.length > 0 && (
              <select
                aria-label="Choose a workspace"
                value={custom || !options.includes(path) ? "" : path}
                onChange={(e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  setCustom(value === "");
                  if (value) setPath(value);
                }}
              >
                <option value="">Other path…</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
            {(options.length === 0 || custom || !options.includes(path)) && (
              <input className="mono" value={path} onChange={(e) => setPath((e.target as HTMLInputElement).value)} />
            )}
          </>
        ) : (
          <span className="mono small">{props.value || <span className="muted">not set</span>}</span>
        )}
        <ErrorNote error={action.error} />
      </td>
      <td className="nowrap right">
        {editing ? (
          <>
            <button
              className="primary small"
              disabled={action.busy || !path.trim()}
              onClick={() => action.run(() => props.onSave(path.trim()).then((w) => (setEditing(false), props.onUpdated(w))))}
            >
              Save
            </button>
            <button className="ghost small" onClick={() => (setEditing(false), setCustom(false), setPath(props.value), action.setError(null))}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="ghost small" onClick={() => setEditing(true)}>
              {props.value ? "Change" : "Set"}
            </button>
            {props.onClear && props.value && (
              <button className="ghost small" disabled={action.busy} onClick={() => action.run(() => props.onClear!().then(props.onUpdated))}>
                Clear
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
