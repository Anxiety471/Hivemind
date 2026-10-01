// Workspaces: allowed roots, each group's shared workspace, and each persona's own workspace.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api, type Workspaces } from "../api";
import { Avatar, ErrorNote, PageHeader, useAction, useAsync } from "../ui";

export function WorkspacesView() {
  const ws = useAsync(() => api.workspaces(), []);
  const groups = useAsync(() => api.chatGroups(), []);
  const data = ws.data;
  const groupIds = groups.data?.groups.map((g) => g.id) ?? [];

  return (
    <div class="page">
      <PageHeader
        title="Workspaces"
        sub="Paths must be absolute, existing directories inside the allowed roots. A live session in the old directory is replaced before its next turn."
      />
      <ErrorNote error={ws.error} />
      {data && (
        <>
          <div class="card">
            <h3>Allowed roots</h3>
            {data.roots.length ? (
              <ul class="paths">{data.roots.map((r) => <li class="mono">{r}</li>)}</ul>
            ) : (
              <p class="muted">No roots configured: any existing directory is allowed.</p>
            )}
          </div>
          <div class="card">
            <h3>Group workspaces</h3>
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
                    label={<strong>◆ {id}</strong>}
                    value={data.groups.find((g) => g.id === id)?.workspace ?? ""}
                    onSave={(path) => api.setGroupWorkspace(id, path)}
                    onClear={() => api.clearGroupWorkspace(id)}
                    onUpdated={(next) => ws.setData(next)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div class="card">
            <h3>Persona workspaces</h3>
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
                      <span class="inline">
                        <Avatar name={p.id} /> {p.id}
                      </span>
                    }
                    value={p.workspace}
                    onSave={(path) => api.setPersonaWorkspace(p.id, path)}
                    onUpdated={(next) => ws.setData(next)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function PathRow(props: {
  label: ComponentChildren;
  value: string;
  onSave: (path: string) => Promise<Workspaces>;
  onClear?: () => Promise<Workspaces>;
  onUpdated: (w: Workspaces) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(props.value);
  const action = useAction();
  return (
    <tr>
      <td>{props.label}</td>
      <td class="grow">
        {editing ? (
          <input class="mono" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
        ) : (
          <span class="mono small">{props.value || <span class="muted">not set</span>}</span>
        )}
        <ErrorNote error={action.error} />
      </td>
      <td class="nowrap right">
        {editing ? (
          <>
            <button
              class="primary small"
              disabled={action.busy || !path.trim()}
              onClick={() => action.run(() => props.onSave(path.trim()).then((w) => (setEditing(false), props.onUpdated(w))))}
            >
              Save
            </button>
            <button class="ghost small" onClick={() => (setEditing(false), setPath(props.value), action.setError(null))}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button class="ghost small" onClick={() => setEditing(true)}>
              {props.value ? "Change" : "Set"}
            </button>
            {props.onClear && props.value && (
              <button class="ghost small" disabled={action.busy} onClick={() => action.run(() => props.onClear!().then(props.onUpdated))}>
                Clear
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
