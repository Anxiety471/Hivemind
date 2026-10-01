// Autonomous tasks: root list, task detail with subtasks, attempts, evidence, budget, and controls.
import type { ReactNode } from "react";
import { useState } from "react";
import { api, type Task } from "../api";
import { useRefreshOn } from "../live";
import { href, navigate } from "../nav";
import { Badge, Empty, ErrorNote, Meter, PageHeader, ago, duration, time, useAction, useAsync } from "../ui";

const isCoordination = (type: string) => /^(task|attempt|message|group)\./.test(type);

export function Tasks({ selected }: { selected?: string }) {
  const tasks = useAsync(() => api.tasks(), []);
  const [creating, setCreating] = useState(false);
  useRefreshOn((e) => isCoordination(e.type), tasks.reload, [tasks.reload]);
  const list = tasks.data?.tasks ?? [];
  const active = selected ?? list[0]?.id;

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="list-head">
          <h2>Tasks</h2>
          <button className="primary small" onClick={() => setCreating(true)}>
            New task
          </button>
        </div>
        <ErrorNote error={tasks.error} />
        {tasks.data && list.length === 0 && <Empty>No tasks yet.</Empty>}
        {list.map((t) => (
          <a key={t.id} href={href("tasks", t.id)} className={t.id === active ? "list-item active" : "list-item"}>
            <div className="list-item-top">
              <Badge value={t.paused ? "paused" : t.status} />
              <span className="muted small">{ago(t.updated_at)}</span>
            </div>
            <div className="list-item-title">{t.objective}</div>
            <div className="muted small">coordinated by {t.coordinator}</div>
          </a>
        ))}
      </aside>
      <section className="detail-pane">
        {creating ? (
          <NewTask
            onDone={(id) => {
              setCreating(false);
              tasks.reload();
              if (id) navigate("tasks", id);
            }}
          />
        ) : active ? (
          <TaskDetailView key={active} id={active} />
        ) : (
          <Empty>Submit a task to see the coordinator plan, run, and review it.</Empty>
        )}
      </section>
    </div>
  );
}

function NewTask({ onDone }: { onDone: (id?: string) => void }) {
  const [objective, setObjective] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const action = useAction();
  const lines = (s: string) =>
    s
      .split(/\n|,/)
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <div className="card form">
      <PageHeader title="New task" sub="The coordinator plans it into subtasks, then owners work and reviewers approve." />
      <label>
        Objective
        <textarea rows={3} value={objective} onChange={(e) => setObjective((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label>
        Acceptance criteria <span className="muted">(one per line)</span>
        <textarea rows={3} value={acceptance} onChange={(e) => setAcceptance((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label>
        Capabilities <span className="muted">(optional, comma separated)</span>
        <input value={capabilities} onChange={(e) => setCapabilities((e.target as HTMLInputElement).value)} />
      </label>
      <ErrorNote error={action.error} />
      <div className="row">
        <button
          className="primary"
          disabled={!objective.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              const res = await api.submitTask(objective.trim(), lines(acceptance), lines(capabilities));
              onDone(res.id);
            })
          }
        >
          Submit task
        </button>
        <button className="ghost" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TaskDetailView({ id }: { id: string }) {
  const detail = useAsync(() => api.task(id), [id]);
  const attempts = useAsync(() => api.attempts(id), [id]);
  const action = useAction();
  const [answer, setAnswer] = useState("");
  useRefreshOn(
    (e) => isCoordination(e.type),
    () => {
      detail.reload();
      attempts.reload();
    },
    [id],
  );

  const d = detail.data?.task;
  if (!d) return <ErrorNote error={detail.error} />;
  const t: Task = d.task;
  const terminal = ["completed", "failed", "cancelled"].includes(t.status);
  const act = (name: "cancel" | "pause" | "resume", body?: unknown) =>
    action.run(() => api.taskAction(id, name, body).then(() => detail.reload()));

  return (
    <div className="task-detail">
      {t.parent_id && (
        <a className="crumb" href={href("tasks", t.root_id)}>
          ← Root task
        </a>
      )}
      <PageHeader title={t.objective} sub={`${t.id} · ${t.kind} · revision ${t.revision}`}>
        <a className="button ghost" href={href("rooms", `task-${t.id}`)}>
          Task room
        </a>
        {!terminal && !t.paused && (
          <button className="ghost" disabled={action.busy} onClick={() => act("pause")}>
            Pause
          </button>
        )}
        {!terminal && (t.paused || t.status === "blocked") && (
          <button className="ghost" disabled={action.busy} onClick={() => act("resume", { retry: t.status === "blocked" })}>
            Resume
          </button>
        )}
        {!terminal && (
          <button className="danger" disabled={action.busy} onClick={() => act("cancel")}>
            Cancel
          </button>
        )}
      </PageHeader>
      <ErrorNote error={action.error} />

      <div className="facts">
        <Fact label="Status">
          <Badge value={t.status} /> {t.paused && <Badge value="paused" />}
        </Fact>
        <Fact label="Coordinator">{t.coordinator}</Fact>
        <Fact label="Owner">{t.owner ?? "—"}</Fact>
        <Fact label="Reviewer">{t.reviewer ?? "—"}</Fact>
        <Fact label="Created">{time(t.created_at)}</Fact>
        <Fact label="Updated">{ago(t.updated_at)}</Fact>
      </div>
      {t.status_reason && <div className="callout">{t.status_reason}</div>}

      {t.status === "needs_input" && (
        <div className="card">
          <h3>Input needed</h3>
          <div className="row">
            <input
              value={answer}
              placeholder="Answer the coordinator's question"
              onChange={(e) => setAnswer((e.target as HTMLInputElement).value)}
            />
            <button
              className="primary"
              disabled={!answer.trim() || action.busy}
              onClick={() => action.run(() => api.taskInput(id, answer.trim()).then(() => (setAnswer(""), detail.reload())))}
            >
              Send answer
            </button>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>Acceptance criteria</h3>
          {t.acceptance.length ? (
            <ul className="checks">
              {t.acceptance.map((a) => (
                <li key={a} data-done={t.status === "completed"}>{a}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">None given</p>
          )}
          {t.feedback.length > 0 && (
            <>
              <h4>Review feedback</h4>
              <ul>{t.feedback.map((f) => <li key={f}>{f}</li>)}</ul>
            </>
          )}
        </div>
        {d.usage ? (
          <div className="card">
            <h3>Budget</h3>
            <Meter label="Dispatches" value={d.usage.dispatches} max={d.usage.dispatch_limit} />
            <Meter label="Tool actions" value={d.usage.tool_actions} max={d.usage.tool_action_limit} />
            <Meter label="Messages" value={d.usage.messages} max={d.usage.message_limit} />
            <div className="muted small">
              Running for {duration(d.usage.started_at, terminal ? t.updated_at : null)} · deadline {time(d.usage.deadline)}
              {d.usage.tokens != null && ` · ${d.usage.tokens} measured tokens`}
            </div>
          </div>
        ) : (
          <div className="card">
            <h3>Evidence</h3>
            {d.evidence.length ? (
              <ul className="evidence">
                {d.evidence.map((e, i) => (
                  <li key={i}>
                    <Badge value={e.outcome} tone={e.outcome === "passed" ? "ok" : "bad"} /> <strong>{e.check}</strong>{" "}
                    <span className="muted">{e.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No verification submitted yet</p>
            )}
          </div>
        )}
      </div>

      {d.children.length > 0 && (
        <div className="card">
          <h3>
            Subtasks <span className="muted small">{progressLine(d.children)}</span>
          </h3>
          <div className="subtasks">
            {d.children.map((c, i) => (
              <a className="subtask" href={href("tasks", c.id)} key={c.id}>
                <span className="step">{i + 1}</span>
                <div className="grow">
                  <div>{c.objective}</div>
                  <div className="muted small">
                    owner {c.owner ?? "—"} · reviewer {c.reviewer ?? "—"}
                    {c.prerequisites.length > 0 &&
                      ` · after ${c.prerequisites.map((p) => d.children.findIndex((x) => x.id === p) + 1).join(", ")}`}
                  </div>
                </div>
                <Badge value={c.status} />
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3>Attempts</h3>
        {attempts.data?.attempts.length ? (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Persona</th>
                <th>State</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Branch</th>
              </tr>
            </thead>
            <tbody>
              {attempts.data.attempts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Badge value={a.kind} tone="muted" />
                  </td>
                  <td>{a.persona}</td>
                  <td>
                    <Badge value={a.state} />
                    {a.failure_class && <span className="muted small"> {a.failure_class}</span>}
                  </td>
                  <td>{time(a.started_at)}</td>
                  <td>{duration(a.started_at, a.ended_at)}</td>
                  <td className="mono small">{a.branch ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No attempts yet{d.children.length ? "; open a subtask to see its attempts" : ""}.</p>
        )}
      </div>

      {(d.artifacts.length > 0 || (d.usage && d.evidence.length > 0)) && (
        <div className="grid-2">
          {d.artifacts.length > 0 && (
            <div className="card">
              <h3>Artifacts</h3>
              <ul className="artifacts">
                {d.artifacts.map((a) => (
                  <li key={a.id}>
                    <Badge value={a.kind} tone="muted" /> <span className="mono small">{a.reference}</span>
                    <div className="muted small">{a.description}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.usage && d.evidence.length > 0 && (
            <div className="card">
              <h3>Evidence</h3>
              <ul className="evidence">
                {d.evidence.map((e, i) => (
                  <li key={i}>
                    <Badge value={e.outcome} tone={e.outcome === "passed" ? "ok" : "bad"} /> {e.check}{" "}
                    <span className="muted">{e.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function progressLine(children: { status: string }[]) {
  const counts: Record<string, number> = {};
  for (const c of children) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`)
    .join(" · ");
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <div className="fact-label">{label}</div>
      <div className="fact-value">{children}</div>
    </div>
  );
}
