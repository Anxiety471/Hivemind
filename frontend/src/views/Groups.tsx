// Chat groups (`group-<id>` rooms): create, edit members/mode/roles/reply order, delete.
import { useState } from "react";
import { api, type ChatGroup } from "../api";
import { href } from "../nav";
import { Avatar, Badge, Empty, ErrorNote, PageHeader, useAction, useAsync } from "../ui";

export function Groups() {
  const groups = useAsync(() => api.chatGroups(), []);
  const agents = useAsync(() => api.agents(), []);
  const [creating, setCreating] = useState(false);
  const names = agents.data?.agents.map((a) => a.name) ?? [];

  return (
    <div className="page">
      <PageHeader title="Groups" sub="Persisted conversation groups. Changes are written to hivemind.toml and apply immediately.">
        <button className="primary" onClick={() => setCreating(true)}>
          New group
        </button>
      </PageHeader>
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
      {groups.data?.groups.length === 0 && !creating && <Empty>No groups yet.</Empty>}
      <div className="cards wide">
        {groups.data?.groups.map((g) => (
          <GroupCard key={g.id + JSON.stringify(g)} group={g} personas={names} onChange={groups.reload} />
        ))}
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
    <div className="card form">
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

  if (!editing)
    return (
      <div className="card group-card">
        <div className="agent-head">
          <div className="group-icon">◆</div>
          <div className="grow">
            <h3>{group.id}</h3>
            <div className="muted small mono">{group.workspace ?? "no shared workspace"}</div>
          </div>
          <Badge value={group.mode} tone="info" />
        </div>
        <div className="order">
          {(group.reply_order.length ? group.reply_order : group.members).map((m, i) => (
            <div className="order-row" key={m}>
              <span className="step">{i + 1}</span>
              <Avatar name={m} />
              <span>{m}</span>
              {group.member_roles?.[m] && <em className="muted">{group.member_roles[m]}</em>}
            </div>
          ))}
        </div>
        <div className="row">
          <a className="button ghost" href={href("rooms", group.room_id)}>
            Open room
          </a>
          <button className="ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="danger ghost"
            disabled={action.busy}
            onClick={() => confirm(`Delete group "${group.id}"? Its history stays as an archived room.`) && action.run(() => api.deleteChatGroup(group.id).then(onChange))}
          >
            Delete
          </button>
        </div>
        <ErrorNote error={action.error} />
      </div>
    );

  return (
    <div className="card group-card form">
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
            <button className="ghost icon" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button className="ghost icon" disabled={i === effectiveOrder.length - 1} onClick={() => move(i, 1)}>
              ↓
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
