// Right-hand panel of a conversation: details, settings, and runtime sessions.
import { useEffect, useState } from "react";
import { api, type Room, type RoomSettings, type RoomSettingsPatch } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Badge, ErrorNote, ago, useAction, useAsync } from "../ui";
import { FolderPicker } from "./agentControls";

export type PanelTab = "details" | "settings" | "sessions";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "settings", label: "Settings" },
  { id: "sessions", label: "Sessions" },
];

export function RoomPanel(props: {
  room: Room;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { room, tab } = props;
  const configurable = room.kind === "main" || room.kind === "solo" || room.kind === "group";
  return (
    <aside className="room-panel" aria-label="Conversation panel">
      <header>
        <div className="tabs" role="tablist">
          {TABS.filter((t) => t.id !== "settings" || configurable).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "tab on" : "tab"}
              onClick={() => props.onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="ghost icon" onClick={props.onClose} aria-label="Close panel">
          ✕
        </button>
      </header>
      <div className="room-panel-body">
        {tab === "details" && <Details room={room} />}
        {tab === "settings" && configurable && <Settings key={room.id} roomId={room.id} onChanged={props.onChanged} />}
        {tab === "sessions" && <Sessions roomId={room.id} />}
      </div>
    </aside>
  );
}

function Details({ room }: { room: Room }) {
  const s = room.state;
  return (
    <div className="room-details">
      <div>
        <h4>Goal</h4>
        <p>{s?.goal ?? <span className="muted">No goal set</span>}</p>
      </div>
      <div>
        <h4>Decisions</h4>
        {s?.decisions.length ? <ul>{s.decisions.map((d) => <li key={d}>{d}</li>)}</ul> : <p className="muted">None yet</p>}
      </div>
      <div>
        <h4>Open questions</h4>
        {s?.open_questions.length ? (
          <ul>{s.open_questions.map((d) => <li key={d}>{d}</li>)}</ul>
        ) : (
          <p className="muted">None</p>
        )}
      </div>
      <div>
        <h4>Summary</h4>
        <p>{room.summary || <span className="muted">No summary yet</span>}</p>
      </div>
      <div className="muted small">
        {room.message_count} messages · updated {ago(room.updated_at)}
      </div>
    </div>
  );
}

function Sessions({ roomId }: { roomId: string }) {
  const sessions = useAsync(() => api.runtimeSessions(roomId), [roomId]);
  useRefreshOn((e) => e.type.startsWith("runtime."), sessions.reload, [sessions.reload]);
  const list = sessions.data?.sessions ?? [];
  return (
    <div className="panel-sessions">
      <ErrorNote error={sessions.error} />
      {sessions.data && list.length === 0 && <p className="muted">No runtime sessions yet.</p>}
      <ul className="session-list">
        {list.slice(0, 8).map((s) => (
          <li key={s.id}>
            <strong>{s.persona_id}</strong> <span className="muted small">{s.runtime}</span>{" "}
            <Badge value={s.ended_at ? s.end_reason ?? "ended" : "open"} tone={s.ended_at ? "muted" : "ok"} />
            <div className="muted small">started {ago(s.started_at)}</div>
          </li>
        ))}
      </ul>
      <a className="button ghost" href={href("sessions", roomId)}>
        Open full session view
      </a>
    </div>
  );
}

type Draft = {
  nickname: string;
  pinned: boolean;
  muted: boolean;
  mode: "broadcast" | "discussion";
  order: string[];
  workspace: string;
  /** "default", "unlimited", or a whole number as text. */
  followUps: string;
};

const MAX_FOLLOW_UPS = 64;
const followUpsFromServer = (v: number | "unlimited" | null) => (v === null ? "default" : String(v));
const followUpsPatch = (text: string): number | "unlimited" | null =>
  text === "default" ? null : text === "unlimited" ? "unlimited" : Number(text);
const followUpsValid = (text: string) =>
  text === "default" || text === "unlimited" || (/^\d+$/.test(text) && Number(text) <= MAX_FOLLOW_UPS);

const fromServer = (s: RoomSettings): Draft => {
  const members = s.members;
  const saved = s.settings.reply_order.filter((m) => members.includes(m));
  return {
    nickname: s.settings.nickname ?? "",
    pinned: s.settings.pinned,
    muted: s.settings.muted,
    mode: s.settings.mode ?? "broadcast",
    order: [...saved, ...members.filter((m) => !saved.includes(m))],
    workspace: s.settings.workspace ?? "",
    followUps: followUpsFromServer(s.settings.follow_up_limit),
  };
};

/** Only the fields the user actually changed, so a save never rewrites untouched settings. */
function diff(server: RoomSettings, draft: Draft): RoomSettingsPatch {
  const base = fromServer(server);
  const patch: RoomSettingsPatch = {};
  const u = server.unavailable;
  if (draft.nickname.trim() !== base.nickname) patch.nickname = draft.nickname.trim();
  if (draft.pinned !== base.pinned) patch.pinned = draft.pinned;
  if (draft.muted !== base.muted) patch.muted = draft.muted;
  if (!u.mode && draft.mode !== base.mode) patch.mode = draft.mode;
  if (!u.reply_order && draft.order.join("\n") !== base.order.join("\n")) patch.reply_order = draft.order;
  if (!u.workspace && draft.workspace.trim() !== base.workspace) patch.workspace = draft.workspace.trim() || null;
  if (!u.follow_up_limit && draft.followUps !== base.followUps && followUpsValid(draft.followUps))
    patch.follow_up_limit = followUpsPatch(draft.followUps);
  return patch;
}

function Settings({ roomId, onChanged }: { roomId: string; onChanged: () => void }) {
  const loaded = useAsync(() => api.roomSettings(roomId), [roomId]);
  const workspaces = useAsync(() => api.workspaces(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const [stale, setStale] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const action = useAction();
  const server = loaded.data;

  // First load fills the form. Later refreshes never overwrite what the user is typing; they
  // only flag that the saved values moved.
  useEffect(() => {
    if (server && !draft) setDraft(fromServer(server));
  }, [server, draft]);
  useRefreshOn(
    (e) => e.type === "config.changed" && (e.payload.scope === "rooms" || e.payload.scope === "agents"),
    () => {
      if (draft && server && Object.keys(diff(server, draft)).length) setStale(true);
      else {
        setDraft(null);
        loaded.reload();
      }
    },
    [draft, server],
  );

  if (!server || !draft) return <div className="muted">{loaded.error ? <ErrorNote error={loaded.error} /> : "Loading settings…"}</div>;
  const u = server.unavailable;
  const patch = diff(server, draft);
  const dirty = Object.keys(patch).length > 0;
  const set = (change: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...change });
  };
  const choices = workspaces.data
    ? [...new Set([...workspaces.data.known, ...workspaces.data.personas.map((p) => p.workspace)])].sort()
    : [];
  const move = (i: number, d: number) => {
    const next = [...draft.order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set({ order: next });
  };
  const save = () =>
    action.run(async () => {
      const next = await api.updateRoomSettings(roomId, patch);
      loaded.setData(next);
      setDraft(fromServer(next));
      setStale(false);
      setSaved(true);
      onChanged();
    });

  return (
    <form
      className="room-settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !action.busy) save();
      }}
    >
      {stale && (
        <div className="warn-note">
          These settings changed elsewhere. Your edits are kept; saving overwrites the changed values.
          <button type="button" className="ghost small" onClick={() => (setDraft(null), setStale(false), loaded.reload())}>
            Discard my edits and reload
          </button>
        </div>
      )}
      <section>
        <h4>General</h4>
        <label>
          Nickname
          <input
            value={draft.nickname}
            maxLength={60}
            placeholder="Show a different name in the room list"
            onChange={(e) => set({ nickname: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.pinned} onChange={(e) => set({ pinned: (e.target as HTMLInputElement).checked })} />
          Pin to the top of the room list
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.muted} onChange={(e) => set({ muted: (e.target as HTMLInputElement).checked })} />
          Mute: hide the message count in the room list
        </label>
      </section>

      <section>
        <h4>Conversation</h4>
        <label className={u.mode ? "disabled" : undefined}>
          Mode
          <select
            disabled={!!u.mode}
            value={draft.mode}
            onChange={(e) => set({ mode: (e.target as HTMLSelectElement).value as Draft["mode"] })}
          >
            <option value="broadcast">Broadcast: every agent answers you independently</option>
            <option value="discussion">Discussion: agents also read earlier replies</option>
          </select>
          {u.mode && <span className="hint">{u.mode}</span>}
        </label>
        <div className={u.reply_order ? "field disabled" : "field"}>
          <span className="label">Reply order</span>
          {u.reply_order ? (
            <span className="hint">{u.reply_order}</span>
          ) : (
            <ol className="order-list">
              {draft.order.map((name, i) => (
                <li key={name}>
                  <span className="grow">{name}</span>
                  <button type="button" className="ghost small" disabled={i === 0} aria-label={`Move ${name} up`} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={i === draft.order.length - 1}
                    aria-label={`Move ${name} down`}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className={u.follow_up_limit ? "field disabled" : "field"}>
          <span className="label">Follow-up budget</span>
          {u.follow_up_limit ? (
            <span className="hint">{u.follow_up_limit}</span>
          ) : (
            <>
              <select
                aria-label="Follow-up budget"
                value={draft.followUps === "default" || draft.followUps === "unlimited" ? draft.followUps : "number"}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  set({ followUps: v === "number" ? String(server.settings.default_follow_up_limit) : v });
                }}
              >
                <option value="default">Default ({server.settings.default_follow_up_limit})</option>
                <option value="number">Set a number…</option>
                <option value="unlimited">Unlimited</option>
              </select>
              {draft.followUps !== "default" && draft.followUps !== "unlimited" && (
                <input
                  type="number"
                  min={0}
                  max={MAX_FOLLOW_UPS}
                  aria-label="Follow-up replies"
                  value={draft.followUps}
                  onChange={(e) => set({ followUps: (e.target as HTMLInputElement).value })}
                />
              )}
              {!followUpsValid(draft.followUps) && <span className="hint">Enter a whole number from 0 to {MAX_FOLLOW_UPS}.</span>}
              <span className="hint">
                Extra replies agents may add in a turn: @mentions and open-floor follow-ups share it. Unlimited keeps going until
                everyone passes (stops at 200 as a safety net).
              </span>
            </>
          )}
        </div>
        <div className={u.workspace ? "field disabled" : "field"}>
          <span className="label">{server.kind === "group" ? "Shared workspace" : "Agent workspace"}</span>
          {u.workspace ? (
            <span className="hint">{u.workspace}</span>
          ) : (
            <>
              <select
                aria-label="Workspace"
                value={choices.includes(draft.workspace) ? draft.workspace : ""}
                onChange={(e) => set({ workspace: (e.target as HTMLSelectElement).value })}
              >
                <option value="">{server.kind === "group" ? "None: members keep their own" : "Choose or type below…"}</option>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <div className="path-input">
                <input
                  className="mono"
                  aria-label="Workspace path"
                  value={draft.workspace}
                  placeholder="/absolute/path"
                  onChange={(e) => set({ workspace: (e.target as HTMLInputElement).value })}
                />
                <button type="button" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing}>
                  {browsing ? "Close browser" : "Browse…"}
                </button>
              </div>
              {browsing && (
                <FolderPicker
                  start={draft.workspace}
                  onPick={(path) => {
                    set({ workspace: path });
                    setBrowsing(false);
                  }}
                  onClose={() => setBrowsing(false)}
                />
              )}
              <span className="hint">
                {server.kind === "group"
                  ? "Replaces each member's own workspace inside this group only."
                  : "This agent's own workspace; it also applies in groups without a shared workspace."}
              </span>
            </>
          )}
        </div>
      </section>

      <ErrorNote error={action.error} />
      {saved && !dirty && <div className="ok-note" role="status">Settings saved.</div>}
      <div className="row">
        <button className="primary" type="submit" disabled={!dirty || action.busy || !followUpsValid(draft.followUps)}>
          Save settings
        </button>
        <button type="button" className="ghost" disabled={!dirty || action.busy} onClick={() => (setDraft(fromServer(server)), action.setError(null))}>
          Reset
        </button>
      </div>
    </form>
  );
}
