// Autonomous tasks: root list, task detail with subtasks, attempts, evidence, budget, and controls.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
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
    <div class="split">
      <aside class="list-pane">
        <div class="list-head">
          <h2>Tasks</h2>
          <button class="primary small" onClick={() => setCreating(true)}>
            New task
          </button>
        </div>
        <ErrorNote error={tasks.error} />
        {tasks.data && list.length === 0 && <Empty>No tasks yet.</Empty>}
        {list.map((t) => (
          <a key={t.id} href={href("tasks", t.id)} class={t.id === active ? "list-item active" : "list-item"}>
            <div class="list-item-top">
              <Badge value={t.paused ? "paused" : t.status} />
              <span class="muted small">{ago(t.updated_at)}</span>
            </div>
            <div class="list-item-title">{t.objective}</div>
            <div class="muted small">coordinated by {t.coordinator}</div>
          </a>
        ))}
      </aside>
      <section class="detail-pane">
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
    <div class="card form">
      <PageHeader title="New task" sub="The coordinator plans it into subtasks, then owners work and reviewers approve." />
      <label>
        Objective
        <textarea rows={3} value={objective} onInput={(e) => setObjective((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label>
        Acceptance criteria <span class="muted">(one per line)</span>
        <textarea rows={3} value={acceptance} onInput={(e) => setAcceptance((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label>
        Capabilities <span class="muted">(optional, comma separated)</span>
        <input value={capabilities} onInput={(e) => setCapabilities((e.target as HTMLInputElement).value)} />
      </label>
      <ErrorNote error={action.error} />
      <div class="row">
        <button
          class="primary"
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
        <button class="ghost" onClick={() => onDone()}>
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
    <div class="task-detail">
      {t.parent_id && (
        <a class="crumb" href={href("tasks", t.root_id)}>
          ← Root task
        </a>
      )}
      <PageHeader title={t.objective} sub={`${t.id} · ${t.kind} · revision ${t.revision}`}>
        <a class="button ghost" href={href("rooms", `task-${t.id}`)}>
          Task room
        </a>
        {!terminal && !t.paused && (
          <button class="ghost" disabled={action.busy} onClick={() => act("pause")}>
            Pause
          </button>
        )}
        {!terminal && (t.paused || t.status === "blocked") && (
          <button class="ghost" disabled={action.busy} onClick={() => act("resume", { retry: t.status === "blocked" })}>
            Resume
          </button>
        )}
        {!terminal && (
          <button class="danger" disabled={action.busy} onClick={() => act("cancel")}>
            Cancel
          </button>
        )}
      </PageHeader>
      <ErrorNote error={action.error} />

      <div class="facts">
        <Fact label="Status">
          <Badge value={t.status} /> {t.paused && <Badge value="paused" />}
        </Fact>
        <Fact label="Coordinator">{t.coordinator}</Fact>
        <Fact label="Owner">{t.owner ?? "—"}</Fact>
        <Fact label="Reviewer">{t.reviewer ?? "—"}</Fact>
        <Fact label="Created">{time(t.created_at)}</Fact>
        <Fact label="Updated">{ago(t.updated_at)}</Fact>
      </div>
      {t.status_reason && <div class="callout">{t.status_reason}</div>}

      {t.status === "needs_input" && (
        <div class="card">
          <h3>Input needed</h3>
          <div class="row">
            <input
              value={answer}
              placeholder="Answer the coordinator's question"
              onInput={(e) => setAnswer((e.target as HTMLInputElement).value)}
            />
            <button
              class="primary"
              disabled={!answer.trim() || action.busy}
              onClick={() => action.run(() => api.taskInput(id, answer.trim()).then(() => (setAnswer(""), detail.reload())))}
            >
              Send answer
            </button>
          </div>
        </div>
      )}

      <div class="grid-2">
        <div class="card">
          <h3>Acceptance criteria</h3>
          {t.acceptance.length ? (
            <ul class="checks">
              {t.acceptance.map((a) => (
                <li data-done={t.status === "completed"}>{a}</li>
              ))}
            </ul>
          ) : (
            <p class="muted">None given</p>
          )}
          {t.feedback.length > 0 && (
            <>
              <h4>Review feedback</h4>
              <ul>{t.feedback.map((f) => <li>{f}</li>)}</ul>
            </>
          )}
        </div>
        {d.usage ? (
          <div class="card">
            <h3>Budget</h3>
            <Meter label="Dispatches" value={d.usage.dispatches} max={d.usage.dispatch_limit} />
            <Meter label="Tool actions" value={d.usage.tool_actions} max={d.usage.tool_action_limit} />
            <Meter label="Messages" value={d.usage.messages} max={d.usage.message_limit} />
            <div class="muted small">
              Running for {duration(d.usage.started_at, terminal ? t.updated_at : null)} · deadline {time(d.usage.deadline)}
              {d.usage.tokens != null && ` · ${d.usage.tokens} measured tokens`}
            </div>
          </div>
        ) : (
          <div class="card">
            <h3>Evidence</h3>
            {d.evidence.length ? (
              <ul class="evidence">
                {d.evidence.map((e) => (
                  <li>
                    <Badge value={e.outcome} tone={e.outcome === "passed" ? "ok" : "bad"} /> <strong>{e.check}</strong>{" "}
                    <span class="muted">{e.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted">No verification submitted yet</p>
            )}
          </div>
        )}
      </div>

      {d.children.length > 0 && (
        <div class="card">
          <h3>
            Subtasks <span class="muted small">{progressLine(d.children)}</span>
          </h3>
          <div class="subtasks">
            {d.children.map((c, i) => (
              <a class="subtask" href={href("tasks", c.id)} key={c.id}>
                <span class="step">{i + 1}</span>
                <div class="grow">
                  <div>{c.objective}</div>
                  <div class="muted small">
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

      <div class="card">
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
                    {a.failure_class && <span class="muted small"> {a.failure_class}</span>}
                  </td>
                  <td>{time(a.started_at)}</td>
                  <td>{duration(a.started_at, a.ended_at)}</td>
                  <td class="mono small">{a.branch ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="muted">No attempts yet{d.children.length ? "; open a subtask to see its attempts" : ""}.</p>
        )}
      </div>

      {(d.artifacts.length > 0 || (d.usage && d.evidence.length > 0)) && (
        <div class="grid-2">
          {d.artifacts.length > 0 && (
            <div class="card">
              <h3>Artifacts</h3>
              <ul class="artifacts">
                {d.artifacts.map((a) => (
                  <li key={a.id}>
                    <Badge value={a.kind} tone="muted" /> <span class="mono small">{a.reference}</span>
                    <div class="muted small">{a.description}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.usage && d.evidence.length > 0 && (
            <div class="card">
              <h3>Evidence</h3>
              <ul class="evidence">
                {d.evidence.map((e) => (
                  <li>
                    <Badge value={e.outcome} tone={e.outcome === "passed" ? "ok" : "bad"} /> {e.check}{" "}
                    <span class="muted">{e.detail}</span>
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

function Fact({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="fact">
      <div class="fact-label">{label}</div>
      <div class="fact-value">{children}</div>
    </div>
  );
}
