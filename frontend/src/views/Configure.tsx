// Budgets, project folders, skill directories, and the other hivemind.toml settings.
import { useState } from "react";
import { api, type OperatorCheck, type OperatorConfig } from "../api";
import { ErrorNote, PageHeader, useAction, useAsync } from "../ui";
import { FolderPicker } from "./agentControls";

type Draft = Omit<OperatorConfig, "restart">;

export function ConfigureView() {
  const loaded = useAsync(() => api.operatorConfig(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [restart, setRestart] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useAction();
  const current = draft ?? (loaded.data ? strip(loaded.data) : null);

  const update = (next: Draft) => {
    setDraft(next);
    setNotice(null);
  };

  return (
    <div className="page configure agent-form">
      <PageHeader
        title="Configure"
        sub="Budgets, project folders, skill directories, and the other settings in hivemind.toml. Saving writes the file and applies them to this running hive."
      >
        <button
          className="primary"
          disabled={!current || save.busy}
          onClick={() => {
            if (!current) return;
            save.run(async () => {
              const saved = await api.saveOperatorConfig(current);
              setDraft(strip(saved));
              setRestart(saved.restart);
              loaded.setData(saved);
              setNotice(
                saved.restart.includes("coordination")
                  ? "Saved. Coordination was off when this hive started, so restart hivemind serve before tasks use the new setting."
                  : "Saved.",
              );
            });
          }}
        >
          {save.busy ? "Saving…" : "Save"}
        </button>
      </PageHeader>
      <ErrorNote error={loaded.error ?? save.error} />
      {notice && <p className="muted">{notice}</p>}
      {restart.includes("coordination") && !notice && (
        <p className="muted">Restart hivemind serve for coordination to start.</p>
      )}
      {current && (
        <>
          <section className="card">
            <h3>Context budget</h3>
            <p className="muted small">How much history a turn keeps, and when a live session rotates.</p>
            <div className="config-grid">
              <Num label="Context target" hint="Approximate tokens for one turn." value={current.context.context_target_tokens} min={1000} onChange={(n) => update(set(current, { context: { ...current.context, context_target_tokens: n } }))} />
              <Num label="Rotate at" hint="Must be larger than the context target." value={current.context.runtime_rotate_tokens} min={1} onChange={(n) => update(set(current, { context: { ...current.context, runtime_rotate_tokens: n } }))} />
              <Num label="Summary budget" hint="Tokens kept in the rolling summary." value={current.context.summary_max_tokens} min={1} onChange={(n) => update(set(current, { context: { ...current.context, summary_max_tokens: n } }))} />
              <Num label="Recent turns" value={current.context.recent_turns} min={1} onChange={(n) => update(set(current, { context: { ...current.context, recent_turns: n } }))} />
              <Num label="Refresh summary every" hint="Turns between summary updates." value={current.context.summary_refresh_turns} min={1} onChange={(n) => update(set(current, { context: { ...current.context, summary_refresh_turns: n } }))} />
            </div>
          </section>

          <section className="card">
            <h3>Usage budgets</h3>
            <p className="muted small">Measured tokens from the runtime. Zero turns a limit off. A task already running keeps the budget it started with.</p>
            <div className="config-grid">
              <Num label="Task token limit" hint="One autonomous task, or one chat room." value={current.execution.task_token_limit} onChange={(n) => update(set(current, { execution: { ...current.execution, task_token_limit: n } }))} />
              <Num label="Project token limit" hint="Accumulated usage for a project folder." value={current.execution.project_token_limit} onChange={(n) => update(set(current, { execution: { ...current.execution, project_token_limit: n } }))} />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={current.execution.require_usage}
                onChange={(e) => update(set(current, { execution: { ...current.execution, require_usage: (e.target as HTMLInputElement).checked } }))}
              />
              Block the next prompt when a runtime did not report usage
            </label>
          </section>

          <section className="card">
            <h3>Task budgets</h3>
            <p className="muted small">Limits for autonomous tasks. New tasks pick these up after you save.</p>
            <label className="check">
              <input
                type="checkbox"
                checked={current.coordination.enabled}
                onChange={(e) => update(set(current, { coordination: { ...current.coordination, enabled: (e.target as HTMLInputElement).checked } }))}
              />
              Coordination enabled
            </label>
            <div className="config-grid">
              <Num label="Dispatches" value={current.coordination.max_dispatches} min={1} onChange={(n) => update(coord(current, { max_dispatches: n }))} />
              <Num label="Tool actions" value={current.coordination.max_tool_actions} min={1} onChange={(n) => update(coord(current, { max_tool_actions: n }))} />
              <Num label="Messages" value={current.coordination.max_messages} min={1} onChange={(n) => update(coord(current, { max_messages: n }))} />
              <Num label="Plan tasks" value={current.coordination.max_plan_tasks} min={1} onChange={(n) => update(coord(current, { max_plan_tasks: n }))} />
              <Num label="Plan depth" value={current.coordination.max_plan_depth} min={1} onChange={(n) => update(coord(current, { max_plan_depth: n }))} />
              <Num label="Time limit (seconds)" value={current.coordination.max_elapsed_secs} min={1} onChange={(n) => update(coord(current, { max_elapsed_secs: n }))} />
              <Num label="Attempts per task" value={current.coordination.max_attempts_per_task} min={1} onChange={(n) => update(coord(current, { max_attempts_per_task: n }))} />
              <Num label="Running at once" value={current.coordination.max_concurrent} min={1} onChange={(n) => update(coord(current, { max_concurrent: n }))} />
              <Num label="Lease (seconds)" value={current.coordination.lease_secs} min={1} onChange={(n) => update(coord(current, { lease_secs: n }))} />
              <Num label="Message depth" value={current.coordination.max_message_depth} min={1} onChange={(n) => update(coord(current, { max_message_depth: n }))} />
              <Num label="Question wait (seconds)" value={current.coordination.question_timeout_secs} min={1} onChange={(n) => update(coord(current, { question_timeout_secs: n }))} />
              <Num label="Questions per attempt" value={current.coordination.max_questions} min={1} onChange={(n) => update(coord(current, { max_questions: n }))} />
            </div>
            <label className="field">
              <span className="label">Planner</span>
              <input
                value={current.coordination.planner ?? ""}
                placeholder="Persona id, or leave empty"
                onChange={(e) => {
                  const value = (e.target as HTMLInputElement).value.trim();
                  update(coord(current, { planner: value ? value : null }));
                }}
              />
              <p className="field-note">The persona that plans tasks. Empty uses the best persona with the coordinate permission.</p>
            </label>
          </section>

          <section className="card">
            <h3>Runtimes</h3>
            <div className="config-grid">
              <Text label="OMP program" value={current.runtime.omp_binary} onChange={(omp_binary) => update(set(current, { runtime: { ...current.runtime, omp_binary } }))} />
              <Text label="Pi program" value={current.runtime.pi_binary} onChange={(pi_binary) => update(set(current, { runtime: { ...current.runtime, pi_binary } }))} />
              <Text label="OpenCode program" value={current.runtime.opencode_binary} onChange={(opencode_binary) => update(set(current, { runtime: { ...current.runtime, opencode_binary } }))} />
              <Num label="Prompt timeout (seconds)" hint="Inactivity before a prompt is stopped. Zero disables it." value={current.runtime.prompt_timeout_secs} onChange={(n) => update(set(current, { runtime: { ...current.runtime, prompt_timeout_secs: n } }))} />
              <Num label="Idle timeout (seconds)" hint="How long an unused session stays up. Zero keeps it until shutdown." value={current.runtime.idle_timeout_secs} onChange={(n) => update(set(current, { runtime: { ...current.runtime, idle_timeout_secs: n } }))} />
              <Num label="Prompt retries" value={current.runtime.prompt_retries} onChange={(n) => update(set(current, { runtime: { ...current.runtime, prompt_retries: n } }))} />
            </div>
          </section>

          <section className="card">
            <Paths
              label="Project folders"
              hint="Folders agents may choose as a workspace. Leave this empty to allow any existing directory. Assign a folder to an agent or group from Workspaces."
              paths={current.workspace_roots}
              onChange={(workspace_roots) => update({ ...current, workspace_roots })}
            />
          </section>

          <section className="card">
            <Paths
              label="Skill folders"
              hint="Each folder holds skill-name/SKILL.md directories. Earlier folders win when two skills share a name. A path may start with ~/."
              paths={current.skills}
              onChange={(skills) => update({ ...current, skills })}
            />
          </section>

          <section className="card">
            <h3>Verification checks</h3>
            <p className="muted small">Commands Hivemind runs against a submitted commit before review can approve it. One argument per line. These run as this process.</p>
            {current.execution.checks.map((check, index) => (
              <CheckRow
                key={index}
                check={check}
                onChange={(next) => {
                  const checks = current.execution.checks.map((item, i) => (i === index ? next : item));
                  update(set(current, { execution: { ...current.execution, checks } }));
                }}
                onRemove={() => {
                  const checks = current.execution.checks.filter((_, i) => i !== index);
                  update(set(current, { execution: { ...current.execution, checks } }));
                }}
              />
            ))}
            <button
              type="button"
              className="ghost"
              onClick={() =>
                update(
                  set(current, {
                    execution: {
                      ...current.execution,
                      checks: [...current.execution.checks, { name: "", command: [], timeout_secs: 300 }],
                    },
                  }),
                )
              }
            >
              Add check
            </button>
          </section>
        </>
      )}
    </div>
  );
}

function strip(config: OperatorConfig): Draft {
  const { restart: _restart, ...draft } = config;
  return draft;
}

function set(draft: Draft, patch: Partial<Draft>): Draft {
  return { ...draft, ...patch };
}

function coord(draft: Draft, patch: Partial<Draft["coordination"]>): Draft {
  return { ...draft, coordination: { ...draft.coordination, ...patch } };
}

function Num(props: { label: string; hint?: string; value: number; min?: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <input
        type="number"
        min={props.min ?? 0}
        step={1}
        value={props.value}
        onChange={(e) => {
          const value = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(value) && value >= 0) props.onChange(Math.trunc(value));
        }}
      />
      {props.hint && <p className="field-note">{props.hint}</p>}
    </label>
  );
}

function Text(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <input className="mono" value={props.value} onChange={(e) => props.onChange((e.target as HTMLInputElement).value)} />
    </label>
  );
}

function Paths(props: { label: string; hint: string; paths: string[]; onChange: (paths: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const add = (path: string) => {
    const next = path.trim();
    if (!next || props.paths.includes(next)) return;
    props.onChange([...props.paths, next]);
    setDraft("");
    setBrowsing(false);
  };
  return (
    <>
      <h3>{props.label}</h3>
      <p className="muted small">{props.hint}</p>
      {props.paths.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="config-paths">
          {props.paths.map((path) => (
            <li key={path}>
              <span className="mono small grow">{path}</span>
              <button type="button" className="ghost small" onClick={() => props.onChange(props.paths.filter((item) => item !== path))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
        }}
      >
        <input className="mono grow" aria-label={`Add ${props.label}`} placeholder="/absolute/path" value={draft} onChange={(e) => setDraft((e.target as HTMLInputElement).value)} />
        <button type="button" className="ghost" onClick={() => setBrowsing((open) => !open)}>
          {browsing ? "Close browser" : "Browse…"}
        </button>
        <button className="primary" type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {browsing && <FolderPicker start={draft} onPick={add} onClose={() => setBrowsing(false)} />}
    </>
  );
}

function CheckRow(props: { check: OperatorCheck; onChange: (check: OperatorCheck) => void; onRemove: () => void }) {
  return (
    <div className="check-row">
      <input
        aria-label="Check name"
        placeholder="name"
        value={props.check.name}
        onChange={(e) => props.onChange({ ...props.check, name: (e.target as HTMLInputElement).value })}
      />
      <textarea
        className="mono"
        aria-label="Check command, one argument per line"
        placeholder={"cargo\ntest\n--locked"}
        value={props.check.command.join("\n")}
        onChange={(e) =>
          props.onChange({
            ...props.check,
            command: (e.target as HTMLTextAreaElement).value.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0),
          })
        }
      />
      <input
        type="number"
        min={1}
        aria-label="Check timeout in seconds"
        value={props.check.timeout_secs}
        onChange={(e) => {
          const value = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(value) && value > 0) props.onChange({ ...props.check, timeout_secs: Math.trunc(value) });
        }}
      />
      <button type="button" className="ghost small" onClick={props.onRemove}>
        Remove
      </button>
    </div>
  );
}
