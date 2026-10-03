// Right-hand panel of a conversation: details, settings, and runtime sessions.
import { useEffect, useState } from "react";
import {
  api,
  type AgentExposure,
  type HostToolExposure,
  type Room,
  type RoomSettings,
  type RoomSettingsPatch,
  type Skill,
} from "../api";
import { RoomSchedules, hasSchedules } from "../Schedules";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Avatar, Badge, ErrorNote, ago, useAction, useAsync } from "../ui";
import { Icon } from "../icons";
import { FolderPicker } from "./agentControls";
import {
  authStatusBadge,
  formatSkillCommand,
  groupHostTools,
  sandboxStatus,
  workspaceBadge,
} from "../exposure";
export type PanelTab = "details" | "tools" | "settings" | "sessions";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "tools", label: "Tools & Skills" },
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
        {tab === "tools" && <ToolsAndSkills room={room} />}
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
      <div>
        <h4>Scheduled wakeups</h4>
        {hasSchedules(room) ? <RoomSchedules roomId={room.id} /> : <p className="muted small">Wakeups here ride the task queue, not the room.</p>}
      </div>
      <div className="muted small">
        {room.message_count} messages · updated {ago(room.updated_at)}
      </div>
    </div>
  );
}

function ToolsAndSkills({ room }: { room: Room }) {
  const exposure = useAsync(() => api.roomExposure(room.id), [room.id]);
  useRefreshOn((e) => e.type === "config.changed" || e.type.startsWith("runtime."), exposure.reload, [exposure.reload]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agents = exposure.data?.agents ?? [];
  const currentAgent = agents.find((a) => a.persona_id === selectedAgentId) ?? agents[0] ?? null;

  return (
    <div className="room-exposure">
      <div className="room-exposure-header">
        <h4>Exposed Tools & Skills</h4>
      </div>
      <ErrorNote error={exposure.error} />
      {exposure.loading && !exposure.data && <p className="muted small">Loading exposure details…</p>}

      {exposure.data && (
        <>
          {agents.length > 1 && (
            <div className="exposure-agents" role="tablist" aria-label="Select agent">
              {agents.map((ag) => (
                <button
                  key={ag.persona_id}
                  type="button"
                  role="tab"
                  aria-selected={ag.persona_id === currentAgent?.persona_id}
                  className={`exposure-agent-btn ${ag.persona_id === currentAgent?.persona_id ? "on" : ""}`}
                  onClick={() => setSelectedAgentId(ag.persona_id)}
                >
                  <Avatar name={ag.persona_id} />
                  <span className="agent-btn-name">{ag.persona_id}</span>
                  {ag.role && <span className="chip small">{ag.role}</span>}
                </button>
              ))}
            </div>
          )}

          {currentAgent ? (
            <AgentExposureView agent={currentAgent} />
          ) : (
            <p className="muted small">No agents exposed to this room.</p>
          )}

          <SkillsExposureView skills={exposure.data.skills} />
        </>
      )}
    </div>
  );
}

function AgentExposureView({ agent }: { agent: AgentExposure }) {
  const [toolTab, setToolTab] = useState<"runtime" | "host">("runtime");

  return (
    <div className="agent-exposure-view">
      <div className="agent-card">
        <div className="agent-card-header">
          <Avatar name={agent.persona_id} />
          <div className="agent-card-title">
            <div className="agent-name-row">
              <strong className="agent-persona-id">{agent.persona_id}</strong>
              <span className="chip runtime-chip">{agent.runtime}</span>
              {agent.model && <span className="chip model-chip">{agent.model}</span>}
              {agent.reasoning && <span className="chip reasoning-chip">{agent.reasoning}</span>}
              {agent.fast && <span className="chip fast-chip">fast</span>}
            </div>
            {agent.role && (
              <div className="agent-role-row muted small">
                Role: <span>{agent.role}</span>
              </div>
            )}
          </div>
        </div>

        <div className="exposure-section">
          <div className="section-label">Workspace</div>
          <div className="workspace-info">
            <code className="workspace-path" title={agent.workspace.effective}>
              {agent.workspace.effective}
            </code>
            {(() => {
              const wb = workspaceBadge(agent.workspace.is_shared);
              return <span className={`badge tone-${wb.tone}`}>{wb.label}</span>;
            })()}
          </div>
        </div>

        <div className="exposure-section">
          <div className="section-label">
            <Icon name="shield" size={14} /> Authorization & Security
          </div>
          <div className="auth-status-row">
            <span className="muted small">Status:</span>{" "}
            {(() => {
              const ab = authStatusBadge(agent.authorization.restricted);
              return <span className={`badge tone-${ab.tone}`}>{ab.label}</span>;
            })()}
          </div>
          <div className="auth-field">
            <span className="muted small">Assigned Roles:</span>
            <div className="chips-row">
              {agent.authorization.roles.length > 0 ? (
                agent.authorization.roles.map((r) => (
                  <span key={r} className="chip role-chip">{r}</span>
                ))
              ) : (
                <span className="muted small">None (unrestricted)</span>
              )}
            </div>
          </div>
          <div className="auth-field">
            <span className="muted small">Effective Permissions:</span>
            <div className="chips-row">
              {agent.authorization.permissions.length > 0 ? (
                agent.authorization.permissions.map((p) => (
                  <span key={p} className="chip perm-chip">{p}</span>
                ))
              ) : (
                <span className="muted small">None</span>
              )}
            </div>
          </div>
          {agent.authorization.capabilities.length > 0 && (
            <div className="auth-field">
              <span className="muted small">Capabilities:</span>
              <div className="chips-row">
                {agent.authorization.capabilities.map((c) => (
                  <span key={c} className="chip cap-chip">{c}</span>
                ))}
              </div>
            </div>
          )}
          <div className="sandbox-indicators">
            <div className="sandbox-indicator">
              <span className="muted small">File editing:</span>
              {(() => {
                const sb = sandboxStatus("file_editing", agent.authorization.sandbox.file_editing);
                return <span className={`badge tone-${sb.tone}`}>{sb.label}</span>;
              })()}
            </div>
            <div className="sandbox-indicator">
              <span className="muted small">Shell execution:</span>
              {(() => {
                const sb = sandboxStatus("shell_execution", agent.authorization.sandbox.shell_execution);
                return <span className={`badge tone-${sb.tone}`}>{sb.label}</span>;
              })()}
            </div>
            <div className="sandbox-indicator">
              <span className="muted small">Web access:</span>
              {(() => {
                const sb = sandboxStatus("web_access", agent.authorization.sandbox.web_access);
                return <span className={`badge tone-${sb.tone}`}>{sb.label}</span>;
              })()}
            </div>
          </div>
        </div>

        <div className="exposure-section">
          <div className="section-label">Tools</div>
          <div className="tool-subtabs" role="tablist" aria-label="Tool categories">
            <button
              type="button"
              role="tab"
              aria-selected={toolTab === "runtime"}
              className={`tab ${toolTab === "runtime" ? "on" : ""}`}
              onClick={() => setToolTab("runtime")}
            >
              Runtime tools ({agent.tools.runtime.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={toolTab === "host"}
              className={`tab ${toolTab === "host" ? "on" : ""}`}
              onClick={() => setToolTab("host")}
            >
              Host tools (hivemind-tool) ({agent.tools.host.length})
            </button>
          </div>

          {toolTab === "runtime" ? (
            <div className="tool-grid">
              {agent.tools.runtime.map((t) => (
                <div key={t.name} className={`tool-item ${t.allowed ? "allowed" : "denied"}`}>
                  <div className="tool-item-head">
                    <span className="tool-name"><code>{t.name}</code></span>
                    <span className="tool-category muted small">{t.category}</span>
                    <span className={`badge ${t.allowed ? "tone-ok" : "tone-muted"}`}>
                      {t.allowed ? "Allowed" : "Denied"}
                    </span>
                  </div>
                  <p className="tool-description">{t.description}</p>
                  {t.reason && <p className="tool-reason muted small">Reason: {t.reason}</p>}
                </div>
              ))}
            </div>
          ) : (
            <HostToolsView hostTools={agent.tools.host} />
          )}
        </div>
      </div>
    </div>
  );
}

function HostToolsView({ hostTools }: { hostTools: HostToolExposure[] }) {
  const groups = groupHostTools(hostTools);
  return (
    <div className="host-tools-grouped">
      {groups.map((g) => (
        <div key={g.category} className="host-category-group">
          <h5 className="category-title">{g.title}</h5>
          <div className="tool-grid">
            {g.tools.map((t) => (
              <div key={t.name} className={`tool-item ${t.allowed && t.available ? "allowed" : "denied"}`}>
                <div className="tool-item-head">
                  <span className="tool-name"><code>{t.name}</code></span>
                  <span className={`badge ${t.available ? "tone-info" : "tone-muted"}`}>
                    {t.available ? "Offered in room" : "Not offered"}
                  </span>
                  <span className={`badge ${t.allowed ? "tone-ok" : "tone-muted"}`}>
                    {t.allowed ? "Allowed" : "Denied"}
                  </span>
                </div>
                <div className="tool-perm-row muted small">
                  <span>Required permission:</span>{" "}
                  {t.permission ? <code>{t.permission}</code> : <span>None</span>}
                </div>
                <p className="tool-description">{t.description}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillsExposureView({ skills }: { skills: Skill[] }) {
  const [copiedSkill, setCopiedSkill] = useState<string | null>(null);

  const copyOrRun = (skill: Skill) => {
    const cmd = formatSkillCommand(skill);
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea");
    if (textarea) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeSetter) {
        nativeSetter.call(textarea, cmd + " ");
      } else {
        textarea.value = cmd + " ";
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cmd).catch(() => {});
    }
    setCopiedSkill(skill.name);
    setTimeout(() => setCopiedSkill((curr) => (curr === skill.name ? null : curr)), 1500);
  };

  return (
    <div className="exposure-section skills-exposure">
      <div className="section-label">Configured Skills ({skills.length})</div>
      {skills.length === 0 ? (
        <p className="muted small">No configured skills available in this room.</p>
      ) : (
        <div className="skill-list">
          {skills.map((s) => (
            <div key={s.name} className="skill-card">
              <div className="skill-card-head">
                <div className="skill-cmd-group">
                  <code className="skill-name">/skill:{s.name}</code>
                  {s.argument_hint && <span className="skill-hint muted small">{s.argument_hint}</span>}
                </div>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => copyOrRun(s)}
                  title={`Copy or insert command for ${s.name}`}
                >
                  {copiedSkill === s.name ? "Copied!" : "Copy / Run"}
                </button>
              </div>
              {s.description && <p className="skill-desc">{s.description}</p>}
            </div>
          ))}
        </div>
      )}
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
