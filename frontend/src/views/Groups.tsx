// Chat groups (`group-<id>` rooms): create, edit members/mode/roles/reply order, delete.
import { useState } from "react";
import { api, type ChatGroup } from "../api";
import { href } from "../nav";
import { Icon } from "../icons";
import { Avatar, Empty, ErrorNote, TopBar, useAction, useAsync } from "../ui";

export function Groups({ create = false }: { create?: boolean }) {
  const groups = useAsync(() => api.chatGroups(), []);
  const agents = useAsync(() => api.agents(), []);
  const [creating, setCreating] = useState(create);
  const names = agents.data?.agents.map((a) => a.name) ?? [];
  const list = groups.data?.groups ?? [];

  return (
    <div className="view">
      <TopBar
        icon="groups"
        title="Groups"
        count={groups.data ? list.length : undefined}
        actions={
          <button className="primary small" onClick={() => setCreating(true)} disabled={creating}>
            <Icon name="plus" size={14} /> New group
          </button>
        }
      />
      <div className="view-body">
        <p className="view-intro muted">Persisted conversation groups. Changes are written to hivemind.toml and apply immediately.</p>
        <ErrorNote error={groups.error} />
        {creating && (
          <CreateGroup
            personas={names}
            onDone={() => {
              setCreating(false);
              groups.reload();
            }}
          />
        )}
        {groups.data && list.length === 0 && !creating && <Empty>No groups yet.</Empty>}
        {list.length > 0 && (
          <div className="rows">
            {list.map((g) => (
              <GroupCard key={g.id + JSON.stringify(g)} group={g} personas={names} onChange={groups.reload} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberPicker({ personas, value, onChange }: { personas: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="picker">
      {personas.map((p) => {
        const on = value.includes(p);
        return (
          <button
            type="button"
            key={p}
            className={on ? "pick on" : "pick"}
            onClick={() => onChange(on ? value.filter((x) => x !== p) : [...value, p])}
          >
            <Avatar name={p} />
            {p}
          </button>
        );
      })}
    </div>
  );
}

function CreateGroup({ personas, onDone }: { personas: string[]; onDone: () => void }) {
  const [id, setId] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const action = useAction();
  return (
    <div className="panel form">
      <h3>New group</h3>
      <label>
        Name
        <input value={id} placeholder="e.g. frontend" onChange={(e) => setId((e.target as HTMLInputElement).value)} />
      </label>
      <label>Members</label>
      <MemberPicker personas={personas} value={members} onChange={setMembers} />
      <ErrorNote error={action.error} />
      <div className="row">
        <button
          className="primary"
          disabled={!id.trim() || !members.length || action.busy}
          onClick={() => action.run(() => api.createChatGroup(id.trim(), members).then(onDone))}
        >
          Create group
        </button>
        <button className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function GroupCard({ group, personas, onChange }: { group: ChatGroup; personas: string[]; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [members, setMembers] = useState(group.members);
  const [mode, setMode] = useState(group.mode);
  const [roles, setRoles] = useState<Record<string, string>>(group.member_roles ?? {});
  const [order, setOrder] = useState<string[]>(group.reply_order.length ? group.reply_order : group.members);
  const action = useAction();

  const effectiveOrder = [...order.filter((m) => members.includes(m)), ...members.filter((m) => !order.includes(m))];
  const move = (i: number, d: number) => {
    const next = [...effectiveOrder];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setOrder(next);
  };

  const save = () =>
    action.run(async () => {
      const member_roles = Object.fromEntries(
        Object.entries(roles).filter(([k, v]) => members.includes(k) && v.trim()),
      );
      await api.updateChatGroup(group.id, { members, mode, member_roles, reply_order: effectiveOrder });
      setEditing(false);
      onChange();
    });

  if (!editing) {
    const order = group.reply_order.length ? group.reply_order : group.members;
    return (
      <article className="group-row" data-group={group.id}>
        <div className="row-item group-grid">
          <span className="agent-name">
            <span className="group-icon">
              <Icon name="group" size={14} />
            </span>
            <span className="agent-name-text">
              <strong>{group.id}</strong>
              <span className="mono small muted ellipsis" title={group.workspace ?? undefined}>
                {group.workspace ?? "no shared workspace"}
              </span>
            </span>
          </span>
          <span>
            <span className="chip">{group.mode}</span>
          </span>
          <span className="order-inline" aria-label="Reply order">
            {order.map((m, i) => (
              <span className="order-step" key={m} title={group.member_roles?.[m] ? `${m} · ${group.member_roles[m]}` : m}>
                {i > 0 && <Icon name="chevron" size={10} />}
                <Avatar name={m} />
                <span>{m}</span>
                {group.member_roles?.[m] && <em className="muted small">{group.member_roles[m]}</em>}
              </span>
            ))}
          </span>
          <span className="row-actions">
            <a className="button ghost small" href={href("rooms", group.room_id)}>
              Open room
            </a>
            <button className="ghost small" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="danger ghost small"
              disabled={action.busy}
              onClick={() => confirm(`Delete group "${group.id}"? Its history stays as an archived room.`) && action.run(() => api.deleteChatGroup(group.id).then(onChange))}
            >
              Delete
            </button>
          </span>
        </div>
        <ErrorNote error={action.error} />
      </article>
    );
  }

  return (
    <div className="panel group-card form">
      <h3>Edit {group.id}</h3>
      <label>Mode</label>
      <div className="segmented">
        {(["discussion", "broadcast"] as const).map((m) => (
          <button type="button" key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <p className="muted small">
        {mode === "discussion" ? "Each member sees earlier replies in this turn." : "Every member answers the message independently."}
      </p>
      <label>Members</label>
      <MemberPicker personas={personas} value={members} onChange={setMembers} />
      <label>Reply order and roles</label>
      <div className="order">
        {effectiveOrder.map((m, i) => (
          <div className="order-row" key={m}>
            <span className="step">{i + 1}</span>
            <Avatar name={m} />
            <span className="grow">{m}</span>
            <input
              className="small-input"
              placeholder="Role in this group"
              value={roles[m] ?? ""}
              onChange={(e) => setRoles({ ...roles, [m]: (e.target as HTMLInputElement).value })}
            />
            <button className="icon-btn" aria-label={`Move ${m} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <Icon name="up" size={14} />
            </button>
            <button className="icon-btn" aria-label={`Move ${m} down`} disabled={i === effectiveOrder.length - 1} onClick={() => move(i, 1)}>
              <Icon name="down" size={14} />
            </button>
          </div>
        ))}
      </div>
      <ErrorNote error={action.error} />
      <div className="row">
        <button className="primary" disabled={action.busy || !members.length} onClick={save}>
          Save
        </button>
        <button className="ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
