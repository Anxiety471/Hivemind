// The agent editor: identity, runtime (with the models and reasoning levels it really offers),
// workspace and access. Everything typed stays put when a save fails or the list refreshes.
import { useEffect, useMemo, useState } from "react";
import { api, type AgentConfig, type ModelOption, type RoleCatalog, type RuntimeModels } from "../api";
import { Avatar, ErrorNote, useAction } from "../ui";
import { CheckList, Choice, FolderPicker, ModelPicker, type CheckOption } from "./agentControls";

const RUNTIMES: { value: AgentConfig["runtime"]; label: string; hint: string }[] = [
  { value: "omp", label: "OMP", hint: "Reasoning and fast mode" },
  { value: "pi", label: "Pi", hint: "Reasoning levels" },
  { value: "opencode", label: "OpenCode", hint: "No reasoning setting" },
  { value: "codex", label: "Codex", hint: "ACP adapter, reasoning and fast mode" },
  { value: "claude_code", label: "Claude Code", hint: "ACP adapter, reasoning levels" },
  { value: "cursor", label: "Cursor", hint: "Cursor CLI (`agent acp`)" },
];

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABEL: Record<string, string> = { xhigh: "X-High" };
const levelLabel = (level: string) => LEVEL_LABEL[level] ?? level.charAt(0).toUpperCase() + level.slice(1);

/** Tags offered before any agent has used them; free-form, only used to match tasks to agents. */
const SUGGESTED_CAPABILITIES = ["backend", "frontend", "design", "docs", "testing", "review", "devops", "security", "research", "data"];

const PERMISSION_HINT: Record<string, string> = {
  coordinate: "Plan root tasks and split them up",
  delegate: "Create subtasks for other agents",
  review: "Be chosen as a task reviewer",
  integrate: "Own integration tasks",
  "task.decide": "Accept or reject task outcomes",
  "task.reassign": "Move tasks between agents",
  "group.manage": "Create groups and change members",
  "workspace.write": "Edit files in the workspace",
  "workspace.exec": "Run shell commands and code",
  "memory.private.write": "Write its own private memory",
  "memory.group.write": "Write memory shared with a group",
  "memory.persona.write": "Propose changes to persona memory",
  "memory.global.write": "Propose changes to global memory",
  "memory.archive": "Archive memory entries",
};

const FALLBACK_PERMISSIONS = Object.keys(PERMISSION_HINT);

function useModels(runtime: string) {
  const [state, setState] = useState<{ data: RuntimeModels | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, data: s.data?.runtime === runtime ? s.data : null, error: null, loading: true }));
    api
      .runtimeModels(runtime, reloads > 0)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e: Error) => live && setState({ data: null, error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [runtime, reloads]);
  return { ...state, reload: () => setReloads((n) => n + 1) };
}

function useRoleCatalog() {
  const [roles, setRoles] = useState<RoleCatalog | null>(null);
  useEffect(() => {
    api.accessRoles().then(setRoles, () => setRoles(null));
  }, []);
  return roles;
}

export function AgentForm(props: {
  mode: "create" | "edit";
  id?: string;
  initial: AgentConfig;
  library: string[];
  knownCapabilities: string[];
  existing: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { initial } = props;
  const [id, setId] = useState(props.id ?? "");
  const [runtime, setRuntime] = useState(initial.runtime);
  const [model, setModel] = useState(initial.model ?? "");
  const [reasoning, setReasoning] = useState(initial.reasoning ?? "");
  const [fast, setFast] = useState<boolean | null>(initial.fast);
  const [role, setRole] = useState(initial.role ?? "");
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [browsing, setBrowsing] = useState(false);
  const [prompt, setPrompt] = useState(initial.system_prompt);
  const [capabilities, setCapabilities] = useState(initial.capabilities);
  const [roles, setRoles] = useState(initial.roles);
  const [permissions, setPermissions] = useState(initial.permissions);
  const action = useAction();

  const catalog = useModels(runtime);
  const roleCatalog = useRoleCatalog();

  // The server's copy moved on while this form is open (another tab, the CLI): keep the
  // user's edits and say so, instead of silently replacing them.
  const baseline = useMemo(() => JSON.stringify(initial), [initial]);
  const [firstBaseline] = useState(baseline);
  const changedElsewhere = props.mode === "edit" && baseline !== firstBaseline;

  const idTaken = props.mode === "create" && props.existing.some((n) => n.toLowerCase() === id.trim().toLowerCase());
  const supportsFast = runtime === "omp" || runtime === "codex";
  const supportsReasoning = runtime !== "opencode";

  const selectedModel: ModelOption | undefined = catalog.data?.models.find((m) => m.id === model);
  const levels = useMemo(() => {
    if (selectedModel) return selectedModel.reasoning;
    const seen = new Set<string>(catalog.data?.models.flatMap((m) => m.reasoning) ?? []);
    const union = LEVEL_ORDER.filter((l) => seen.has(l));
    return union.length > 0 ? union : LEVEL_ORDER;
  }, [selectedModel, catalog.data]);
  const reasoningOptions = [
    { value: "", label: "Default" },
    ...[...levels, ...(reasoning && !levels.includes(reasoning) ? [reasoning] : [])].map((l) => ({ value: l, label: levelLabel(l) })),
  ];
  const modelCannotReason = !!selectedModel && selectedModel.reasoning.length === 0;

  const chooseRuntime = (next: AgentConfig["runtime"]) => {
    if (next === runtime) return;
    setRuntime(next);
    // Model ids and settings belong to one runtime; carrying them over would be wrong.
    setModel("");
    setReasoning("");
    if (next !== "omp" && next !== "codex") setFast(null);
  };

  const capabilityOptions: CheckOption[] = [
    ...new Set([...SUGGESTED_CAPABILITIES, ...props.knownCapabilities]),
  ].sort().map((value) => ({ value }));
  const roleOptions: CheckOption[] = [...(roleCatalog?.builtin ?? []), ...(roleCatalog?.custom ?? [])].map((r) => ({
    value: r.name,
    hint: r.permissions.length === 0 ? "Read-only" : r.permissions.map((p) => PERMISSION_HINT[p] ?? p).slice(0, 2).join(" · ") + (r.permissions.length > 2 ? ` · +${r.permissions.length - 2} more` : ""),
  }));
  // What the selection grants: role permissions plus direct ones, widened by implications.
  const effective = useMemo(() => {
    const granted = new Set(permissions);
    const byRole: Record<string, string[]> = {};
    for (const r of [...(roleCatalog?.builtin ?? []), ...(roleCatalog?.custom ?? [])]) byRole[r.name] = r.permissions;
    for (const r of roles) for (const p of byRole[r] ?? []) granted.add(p);
    for (const p of [...granted]) for (const implied of roleCatalog?.implies[p] ?? []) granted.add(implied);
    return [...granted].sort();
  }, [permissions, roles, roleCatalog]);
  const permissionOptions: CheckOption[] = (roleCatalog?.permissions ?? FALLBACK_PERMISSIONS).map((value) => ({
    value,
    hint: PERMISSION_HINT[value],
    badge: effective.includes(value) && !permissions.includes(value) ? "from roles" : undefined,
  }));

  const body = (): Partial<AgentConfig> => ({
    runtime,
    system_prompt: prompt,
    workspace: workspace.trim() || undefined,
    model: model.trim() || null,
    reasoning: supportsReasoning ? reasoning.trim() || null : null,
    fast: supportsFast ? fast : null,
    role: role.trim() || null,
    capabilities,
    permissions,
    roles,
  });
  const save = () =>
    action.run(async () => {
      if (props.mode === "create") await api.createAgent(id.trim(), body());
      else await api.updateAgent(props.id!, body());
      props.onSaved();
    });

  return (
    <form
      className="card agent-form"
      data-form={props.mode}
      onSubmit={(e) => {
        e.preventDefault();
        if (!action.busy && !idTaken && !(props.mode === "create" && !id.trim())) save();
      }}
    >
      <header className="form-head">
        <Avatar name={props.mode === "create" ? id.trim() || "New" : props.id!} />
        <div>
          <h3>{props.mode === "create" ? "New agent" : `Edit ${props.id}`}</h3>
          <p className="muted small">
            {props.mode === "create" ? "Pick a runtime and model, give it a workspace and decide what it may do." : "Changes apply from the agent's next message."}
          </p>
        </div>
      </header>
      {changedElsewhere && (
        <div className="warn-note">This agent was changed elsewhere while you were editing. Your edits are kept; saving overwrites it.</div>
      )}

      <section className="form-section">
        <div className="section-title">
          <h4>Identity</h4>
          <p>Who the agent is and how it should behave.</p>
        </div>
        <div className="form-grid two">
          {props.mode === "create" && (
            <label className="field">
              Agent id
              <input value={id} placeholder="e.g. Designer" onChange={(e) => setId((e.target as HTMLInputElement).value)} />
              {idTaken && <span className="field-error">An agent with this id already exists.</span>}
            </label>
          )}
          <label className="field">
            Job title
            <input value={role} placeholder="e.g. Software Engineer (optional)" onChange={(e) => setRole((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <label className="field">
          System prompt
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} />
        </label>
      </section>

      <section className="form-section">
        <div className="section-title">
          <h4>Runtime</h4>
          <p>The harness that runs the agent, and the model it uses.</p>
        </div>
        <Choice legend="Runtime" value={runtime} options={RUNTIMES} onChange={chooseRuntime} className="runtimes" />
        <div className="form-grid two">
          <ModelPicker
            value={model}
            models={catalog.data?.models ?? null}
            loading={catalog.loading}
            error={catalog.error}
            source={RUNTIMES.find((r) => r.value === runtime)?.label ?? runtime}
            onReload={catalog.reload}
            onChange={(next, picked) => {
              setModel(next);
              // Keep the level only while the new model accepts it.
              const known = picked ?? catalog.data?.models.find((m) => m.id === next);
              if (known && reasoning && !known.reasoning.includes(reasoning)) setReasoning("");
            }}
          />
          <Choice
            legend="Fast mode"
            value={fast === null ? "default" : fast ? "on" : "off"}
            options={[
              { value: "default", label: "Default", disabled: !supportsFast },
              { value: "on", label: "On", disabled: !supportsFast },
              { value: "off", label: "Off", disabled: !supportsFast },
            ]}
            onChange={(v) => setFast(v === "default" ? null : v === "on")}
            note={supportsFast ? "Faster responses where the model offers them. Default leaves OMP's own setting alone." : "Fast mode is only available with the OMP runtime."}
            className={supportsFast ? "compact" : "compact disabled"}
          />
        </div>
        <Choice
          legend="Reasoning"
          value={reasoning}
          options={reasoningOptions.map((o) => ({ ...o, disabled: !supportsReasoning || modelCannotReason }))}
          onChange={setReasoning}
          note={
            !supportsReasoning
              ? "OpenCode picks its own reasoning effort; Hivemind cannot set it."
              : modelCannotReason
                ? "This model does not reason."
                : selectedModel
                  ? `Levels ${selectedModel.name} accepts. Default uses the runtime's own level.`
                  : "Pick a model to see exactly which levels it accepts. Default uses the runtime's own level."
          }
          className={supportsReasoning && !modelCannotReason ? "levels" : "levels disabled"}
        />
      </section>

      <section className="form-section">
        <div className="section-title">
          <h4>Workspace</h4>
          <p>
            The agent's own directory, used in direct messages and the main conversation. A group's shared workspace, set in that
            group's room settings, replaces it inside that group only.
          </p>
        </div>
        <label className="field">
          Agent workspace
          <div className="path-input">
            <input
              className="mono"
              value={workspace}
              placeholder="/absolute/path/to/directory (empty: server default)"
              spellCheck={false}
              onChange={(e) => setWorkspace((e.target as HTMLInputElement).value)}
            />
            <button type="button" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing}>
              {browsing ? "Close browser" : "Browse…"}
            </button>
          </div>
        </label>
        {props.library.length > 0 && (
          <div className="known-paths" role="group" aria-label="Known folders">
            <span className="muted small">Known:</span>
            {props.library.map((w) => (
              <button key={w} type="button" className="chip mono" data-on={w === workspace} title={w} onClick={() => setWorkspace(w)}>
                {w}
              </button>
            ))}
          </div>
        )}
        {browsing && (
          <FolderPicker
            start={workspace}
            onPick={(path) => {
              setWorkspace(path);
              setBrowsing(false);
            }}
            onClose={() => setBrowsing(false)}
          />
        )}
      </section>

      <section className="form-section">
        <div className="section-title">
          <h4>Access</h4>
          <p>Capabilities route tasks to the agent. Roles and permissions are the only things that grant authority.</p>
        </div>
        <div className="access-summary" aria-label="Current access">
          <div className="summary-row">
            <span className="summary-key">Job title</span>
            <span>{role.trim() || <span className="muted">none</span>}</span>
          </div>
          <div className="summary-row">
            <span className="summary-key">Capabilities</span>
            <span>{capabilities.length ? capabilities.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted">none</span>}</span>
          </div>
          <div className="summary-row">
            <span className="summary-key">Roles</span>
            <span>{roles.length ? roles.map((r) => <span key={r} className="tag">{r}</span>) : <span className="muted">none</span>}</span>
          </div>
          <div className="summary-row">
            <span className="summary-key">Effective permissions</span>
            <span>{effective.length ? effective.map((p) => <span key={p} className="tag perm">{p}</span>) : <span className="muted">none</span>}</span>
          </div>
          <p className="field-note">
            {roles.length === 0
              ? "No roles are selected, so the agent keeps unrestricted file, shell and memory access. Choose a role to restrict it to that role's permissions."
              : `With these roles the agent ${effective.includes("workspace.write") ? "can" : "cannot"} edit files and ${effective.includes("workspace.exec") ? "can" : "cannot"} run shell commands.`}
          </p>
        </div>
        <CheckList
          legend="Capabilities"
          description="Skill tags used to match tasks with agents."
          options={capabilityOptions}
          selected={capabilities}
          onChange={setCapabilities}
          addLabel="Add capability"
          columns="narrow"
        />
        <CheckList
          legend="Roles"
          description="Each role bundles permissions. An agent with roles only gets the file and shell tools they allow."
          options={roleOptions}
          selected={roles}
          onChange={setRoles}
        />
        <CheckList
          legend="Extra permissions"
          description="Granted on top of the roles."
          options={permissionOptions}
          selected={permissions}
          onChange={setPermissions}
        />
      </section>

      <ErrorNote error={action.error} />
      <footer className="form-foot">
        <button type="submit" className="primary" disabled={action.busy || idTaken || (props.mode === "create" && !id.trim())}>
          {props.mode === "create" ? "Create agent" : "Save changes"}
        </button>
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
      </footer>
    </form>
  );
}
