import { useEffect, useState } from "react";
import { api } from "../api";
import { href } from "../nav";
import { Badge, ErrorNote, PageHeader, time, useAction, useAsync } from "../ui";
export function Routines() {
  const data = useAsync(api.routines, []);
  const goals = useAsync(api.goals, []);
  const [goalId, setGoalId] = useState("");
  const action = useAction();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [workspace, setWorkspace] = useState("");
  const [acceptance, setAcceptance] = useState("");
  useEffect(() => {
    const timer = window.setInterval(data.reload, 5000);
    return () => clearInterval(timer);
  }, [data.reload]);
  return (
    <div className="page task-detail">
      <PageHeader
        title="Routines"
        sub="Recurring tasks with durable run history. Overlapping runs coalesce; missed intervals are skipped."
      />
      <ErrorNote error={data.error} />
      <ErrorNote error={action.error} />
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          action.run(async () => {
            await api.createRoutine({
              name: name.trim(),
              objective: objective.trim(),
              interval_secs: minutes * 60,
              acceptance: acceptance
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              capabilities: [],
              ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
              ...(goalId ? { goal_id: goalId } : {}),
            });
            setName("");
            setObjective("");
            await data.reload();
          });
        }}
      >
        <h3>New routine</h3>
        <ErrorNote error={goals.error} />
        <label>
          Project goal
          <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">No linked goal</option>
            {goals.data?.goals
              .filter((g) => g.status === "active")
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
          </select>
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </label>
        <label>
          Objective
          <textarea value={objective} onChange={(e) => setObjective(e.target.value)} required maxLength={8000} />
        </label>
        <label>
          Every (minutes)
          <input
            type="number"
            min={1}
            max={525600}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            required
          />
        </label>
        <label>
          Workspace (optional)
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        </label>
        <label>
          Acceptance criteria (one per line)
          <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
        </label>
        <button className="primary" disabled={action.busy}>
          Create routine
        </button>
      </form>
      {data.data?.routines.map((r) => (
        <section className="card" key={r.id}>
          <h3>
            {r.name} <Badge value={r.enabled ? "active" : "paused"} />
          </h3>
          <p>{r.objective}</p>
          <p>
            Every {r.interval_secs / 60} minutes · next {r.enabled ? time(r.next_at) : "paused"}
          </p>
          <div className="row">
            <button
              disabled={action.busy || !r.enabled}
              onClick={() =>
                action.run(async () => {
                  await api.runRoutine(r.id);
                  await data.reload();
                })
              }
            >
              Run now
            </button>
            <button
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await api.setRoutineEnabled(r.id, !r.enabled, r.revision);
                  await data.reload();
                })
              }
            >
              {r.enabled ? "Pause routine" : "Resume routine"}
            </button>
          </div>
          <h4>Latest runs</h4>
          {r.runs.length === 0 ? (
            <p className="muted">No runs yet.</p>
          ) : (
            <ul>
              {r.runs.map((run) => (
                <li key={run.id}>
                  {time(run.created_at)} · {run.status}{" "}
                  {run.task_id && <a href={href("tasks", run.task_id)}>Open task</a>}
                  {run.error && <p>{run.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
