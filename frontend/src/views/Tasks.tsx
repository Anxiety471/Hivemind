// Autonomous tasks: root list, task detail with subtasks, attempts, evidence, budget, and controls.
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CellSignalFull } from "@phosphor-icons/react/dist/csr/CellSignalFull";
import { CellSignalLow } from "@phosphor-icons/react/dist/csr/CellSignalLow";
import { CellSignalMedium } from "@phosphor-icons/react/dist/csr/CellSignalMedium";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Circle } from "@phosphor-icons/react/dist/csr/Circle";
import { CircleHalf } from "@phosphor-icons/react/dist/csr/CircleHalf";
import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { Funnel } from "@phosphor-icons/react/dist/csr/Funnel";
import { Pause } from "@phosphor-icons/react/dist/csr/Pause";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { XCircle } from "@phosphor-icons/react/dist/csr/XCircle";
import { compareIssues, inIssueView, issueGroup, issueGroups, issueViews, terminalIssue, type IssueView } from "./issueList";
import { api, type IssueFields, type Task } from "../api";
import { useRefreshOn } from "../live";
import { href, navigate } from "../nav";
import { Badge, Empty, ErrorNote, Meter, PageHeader, ago, duration, time, useAction, useAsync } from "../ui";

import { IssueDiscussion } from "./IssueDiscussion";

const isCoordination = (type: string) => /^(task|attempt|message|group)\./.test(type);

export function Tasks({ selected }: { selected?: string }) {
  const [view, setView] = useState<IssueView>("active");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [creating, setCreating] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tasks = useAsync(() => api.issueTasks({ q: query, state: "all", label, priority }), [query, label, priority]);
  const action = useAction();
  useRefreshOn((e) => isCoordination(e.type), tasks.reload, [tasks.reload]);
  const routeView = issueViews.find((v) => v.id === selected);
  useEffect(() => {
    if (routeView || !selected) { setView(routeView?.id ?? "active"); setChecked(new Set()); }
  }, [selected, routeView]);
  const currentView = routeView?.id ?? view;
  const active = selected && !routeView ? selected : undefined;
  const list = (tasks.data?.tasks ?? []).filter((t) => inIssueView(t, currentView) && (!assignee || (t.owner ?? t.coordinator) === assignee)).sort(compareIssues);
  const picked = list.filter((t) => checked.has(t.id));
  const title = issueViews.find((v) => v.id === currentView)!.label;
  const toggle = (id: string) => setChecked((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const bulk = (name: "pause" | "resume") => action.run(async () => {
    // Surface partial failures and reload the actual state before retrying.
    const results = await Promise.allSettled(picked.filter((t) => !terminalIssue(t) && (name === "pause" ? !t.paused : t.paused)).map((t) => api.taskAction(t.id, name)));
    await tasks.reload();
    setChecked(new Set());
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) throw new Error(`${failed.length} issue action(s) failed. Refresh the list and retry.`);
  });

  return <div className="ticket-workspace">
    <header className="ticket-toolbar">
      <h1>{title} <span className="ticket-count">{list.length}</span></h1>
      <details className="ticket-filter-menu">
        <summary><Funnel size={14} /> Filter{(query || label || priority || assignee) && <span className="filter-active">On</span>}</summary>
        <form className="issue-filters" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
          <label>Search issues<input placeholder="Title, description, or #number" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <button className="ghost small" type="submit">Search</button>
          <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">Any priority</option>{["urgent", "high", "normal", "low"].map((p) => <option key={p}>{p}</option>)}</select></label>
          <label>Label<input value={label} placeholder="Filter by label" onChange={(e) => setLabel(e.target.value.toLowerCase())} /></label>
          <label>Assignee<select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Any assignee</option>{[...new Set((tasks.data?.tasks ?? []).map((t) => t.owner ?? t.coordinator))].sort().map((name) => <option key={name}>{name}</option>)}</select></label>
          <button className="ghost small" type="button" onClick={() => { setSearch(""); setQuery(""); setLabel(""); setPriority(""); setAssignee(""); }}>Clear filters</button>
        </form>
      </details>
      <span className="grow" />
      <button className="ticket-create" aria-label="New issue" title="New issue" onClick={() => setCreating(true)}><Plus size={16} /></button>
    </header>
    <nav className="ticket-view-tabs" aria-label="Issue views">{issueViews.map((v) => <a key={v.id} href={href("tasks", v.id)} aria-current={currentView === v.id ? "page" : undefined}>{v.label}</a>)}</nav>
    <ErrorNote error={tasks.error ?? action.error} />
    {picked.length > 0 && <div className="ticket-bulk row"><span>{picked.length} selected</span>
      <button className="ghost small" disabled={action.busy || !picked.some((t) => !terminalIssue(t) && t.paused)} onClick={() => bulk("resume")}><Play size={13} /> Start automation</button>
      <button className="ghost small" disabled={action.busy || !picked.some((t) => !terminalIssue(t) && !t.paused)} onClick={() => bulk("pause")}><Pause size={13} /> Pause automation</button>
      <button className="ghost small" onClick={() => setChecked(new Set())}>Clear selection</button>
    </div>}
    {!tasks.data && tasks.loading && <div className="ticket-empty" role="status">Loading issues…</div>}
    {tasks.data && !list.length && <Empty>{currentView === "active" && !query && !label && !priority && !assignee ? "No active issues. Create an issue or start one from Backlog." : "No matching issues."}</Empty>}
    <div className="ticket-groups">
      {issueGroups.map((group) => {
        const rows = list.filter((t) => issueGroup(t) === group);
        if (!rows.length) return null;
        return <section className="ticket-group" key={group} aria-label={group}>
          <div className="ticket-group-head">
            <input type="checkbox" aria-label={`Select ${group} issues`} checked={rows.every((t) => checked.has(t.id))} onChange={(e) => setChecked((old) => { const next = new Set(old); rows.forEach((t) => e.target.checked ? next.add(t.id) : next.delete(t.id)); return next; })} />
            <button className="ticket-group-toggle" aria-expanded={!collapsed.has(group)} onClick={() => setCollapsed((old) => { const next = new Set(old); if (next.has(group)) next.delete(group); else next.add(group); return next; })}><CaretRight size={11} className={collapsed.has(group) ? "" : "expanded"} /><span>{group}</span><span className="ticket-count">{rows.length}</span></button>
            <button className="ticket-icon-button" aria-label={`New issue from ${group}`} title="New issues enter Backlog" onClick={() => setCreating(true)}><Plus size={13} /></button>
          </div>
          {!collapsed.has(group) && rows.map((t) => <div className={`ticket-row${checked.has(t.id) ? " selected" : ""}`} key={t.id}>
            <input type="checkbox" aria-label={`Select issue ${t.issue.number}`} checked={checked.has(t.id)} onChange={() => toggle(t.id)} />
            <PriorityIcon priority={t.issue.priority} />
            <a className="ticket-row-link" href={href("tasks", t.id)} aria-label={`Open issue ${t.issue.number}: ${t.objective}`}>
              <span className="ticket-identifier">HM-{t.issue.number}</span><StatusIcon task={t} /><span className="ticket-title">{t.objective}</span>
              <span className="ticket-row-labels">{t.issue.labels.map((l) => <span className="ticket-label" key={l}>{l}</span>)}</span>
              <time className="ticket-date" dateTime={new Date(t.updated_at * 1000).toISOString()}>{new Date(t.updated_at * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</time>
              <span className="ticket-assignee" title={`Assigned to ${t.owner ?? t.coordinator}`}><UserCircle size={18} /><span>{t.owner ?? t.coordinator}</span></span>
            </a>
            <details className="ticket-row-menu"><summary aria-label={`Actions for issue ${t.issue.number}`}><DotsThree size={18} /></summary><div className="ticket-row-menu-items"><a href={href("tasks", t.id)}>Open issue</a>{!terminalIssue(t) && <button disabled={action.busy} onClick={() => action.run(async () => { await api.taskAction(t.id, t.paused ? "resume" : "pause"); await tasks.reload(); })}>{t.paused ? "Start automation" : "Pause automation"}</button>}</div></details>
          </div>)}
        </section>;
      })}
    </div>
    {creating && <IssueDialog label="New issue" onClose={() => setCreating(false)}><NewTask onDone={(id) => { setCreating(false); tasks.reload(); if (id) navigate("tasks", id); }} /></IssueDialog>}
    {active && !creating && <IssueDialog label="Issue details" drawer onClose={() => navigate("tasks", currentView)}><TaskDetailView key={active} id={active} /></IssueDialog>}
  </div>;
}

function PriorityIcon({ priority }: { priority: IssueFields["priority"] }) {
  const Icon = priority === "urgent" ? Warning : priority === "high" ? CellSignalFull : priority === "normal" ? CellSignalMedium : CellSignalLow;
  return <span className={`ticket-priority priority-${priority}`} title={`${priority} priority`} aria-label={`${priority} priority`}><Icon size={14} /></span>;
}

function StatusIcon({ task }: { task: Task }) {
  const group = issueGroup(task);
  const Icon = group === "Done" ? CheckCircle : group === "In Review" ? CircleHalf : group === "In Progress" ? CircleHalf : group === "Blocked" || group === "Failed" ? WarningCircle : group === "Cancelled" ? XCircle : Circle;
  return <span className={`ticket-status status-${group.toLowerCase().replace(/ /g, "-")}`} title={task.paused ? "Backlog (paused)" : task.status.replace(/_/g, " ")} aria-label={group}><Icon size={14} weight={group === "In Progress" ? "fill" : "regular"} /></span>;
}

function IssueDialog({ label, drawer = false, onClose, children }: { label: string; drawer?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>(".ticket-dialog-close")?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      if (e.key === "Tab") {
        const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length);
        const first = elements[0]; const last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="ticket-dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} role="dialog" aria-modal="true" aria-label={label} className={`ticket-dialog ${drawer ? "ticket-drawer" : "ticket-create-dialog"}`}><div className="ticket-dialog-bar"><span>{label}</span><button className="ticket-icon-button ticket-dialog-close" aria-label="Close dialog" onClick={onClose}><X size={16} /></button></div>{children}</div></div>;
}

function NewTask({ onDone }: { onDone: (id?: string) => void }) {
  const [objective, setObjective] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [priority, setPriority] = useState<IssueFields["priority"]>("normal");
  const [autoStart, setAutoStart] = useState(false);
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
      <PageHeader title="New issue" sub="Describe the work. Start automation when it is ready." />
      <label>
        Title
        <textarea rows={2} value={objective} onChange={(e) => setObjective((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label>Description<textarea rows={4} maxLength={2400} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <div className="grid-2">
        <label>Labels (comma separated)<input value={labels} onChange={(e) => setLabels(e.target.value)} /></label>
        <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value as IssueFields["priority"])}>{["low","normal","high","urgent"].map((p) => <option key={p}>{p}</option>)}</select></label>
      </div>
      <label className="row"><input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />Start automation immediately</label>
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
              const res = await api.submitTask(objective.trim(), lines(acceptance), lines(capabilities), { description, labels: lines(labels), priority }, autoStart);
              onDone(res.id);
            })
          }
        >
          {autoStart ? "Create & automate" : "Save to backlog"}
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
  const [steerMessage, setSteerMessage] = useState("");
  const [steerStatus, setSteerStatus] = useState<string | null>(null);
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
    <div className="task-detail ticket-detail">
      {t.parent_id && (
        <a className="crumb" href={href("tasks", t.root_id)}>
          ← Root task
        </a>
      )}
      <PageHeader title={t.objective} sub={`HM-${t.issue.number} · opened ${ago(t.created_at)}`}>
        <a className="button ghost" href={href("rooms", `task-${t.id}`)}>
          Task room
        </a>
        {!t.parent_id && !terminal && !t.paused && (
          <button className="ghost" disabled={action.busy} onClick={() => act("pause")}>
            Pause
          </button>
        )}
        {!t.parent_id && !terminal && (t.paused || t.status === "blocked") && (
          <button className="ghost" disabled={action.busy} onClick={() => act("resume", { retry: t.status === "blocked" })}>
            {t.paused && !attempts.data?.attempts.length ? "Start automation" : "Resume"}
          </button>
        )}
        {!terminal && (
          <button className="danger" disabled={action.busy} onClick={() => act("cancel")}>
            Cancel
          </button>
        )}
      </PageHeader>
      <ErrorNote error={action.error} />

      <div className="ticket-detail-layout"><section className="ticket-conversation">
      <IssueMetadata key={`${t.id}-${t.revision}`} task={t} onSaved={detail.reload} />
      <IssueDiscussion task={t} />
      <details className="ticket-execution-disclosure"><summary>Automation details</summary><div className="ticket-execution">
      <div className="automation-flow muted small">{terminal ? `Automation ${t.status}` : t.paused ? "Backlog / paused" : "Automation active"} · Plan → Assign by capability → Execute → Review → Complete</div>
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

      {d.questions && d.questions.length > 0 && (
        <div className="card">
          <h3>Waiting on {d.questions.length > 1 ? "questions" : "question"}</h3>
          {d.questions.map((q) => (
            <div key={q.attempt_id} style={{ marginBottom: "1rem" }}>
              <div style={{ marginBottom: "0.5rem" }}>
                <strong>{q.persona}</strong> asks: <em>"{q.question}"</em>
                {q.to && <span className="muted"> (directed to {q.to})</span>}
                <span className="muted small" style={{ marginLeft: "0.5rem" }}>{ago(q.asked_at)}</span>
              </div>
              <div className="row">
                <input
                  value={answer}
                  placeholder={`Reply to ${q.persona}...`}
                  onChange={(e) => setAnswer((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && answer.trim() && !action.busy) {
                      action.run(() =>
                        api.taskInput(id, answer.trim()).then(() => (setAnswer(""), detail.reload()))
                      );
                    }
                  }}
                />
                <button
                  className="primary"
                  disabled={!answer.trim() || action.busy}
                  onClick={() =>
                    action.run(() =>
                      api.taskInput(id, answer.trim()).then(() => (setAnswer(""), detail.reload()))
                    )
                  }
                >
                  Send answer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!terminal && (
        <div className="card">
          <h3>Steer running attempt</h3>
          <p className="muted small">
            Inject guidance into the active worker's session mid-flight (Pi/OMP steer) and record durable task feedback.
          </p>
          <div className="row">
            <input
              value={steerMessage}
              placeholder="Guidance for the active worker..."
              onChange={(e) => setSteerMessage((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && steerMessage.trim() && !action.busy) {
                  action.run(() =>
                    api.steerTask(id, steerMessage.trim()).then((res) => {
                      setSteerMessage("");
                      const targets = res.steer.delivered_to;
                      setSteerStatus(
                        targets.length
                          ? `Steer delivered live to: ${targets.join(", ")}`
                          : "Queued as task feedback (no live session active)"
                      );
                      detail.reload();
                    })
                  );
                }
              }}
            />
            <button
              className="primary"
              disabled={!steerMessage.trim() || action.busy}
              onClick={() =>
                action.run(() =>
                  api.steerTask(id, steerMessage.trim()).then((res) => {
                    setSteerMessage("");
                    const targets = res.steer.delivered_to;
                    setSteerStatus(
                      targets.length
                        ? `Steer delivered live to: ${targets.join(", ")}`
                        : "Queued as task feedback (no live session active)"
                    );
                    detail.reload();
                  })
                )
              }
            >
              Steer
            </button>
          </div>
          {steerStatus && <div className="muted small" style={{ marginTop: "0.5rem" }}>{steerStatus}</div>}
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
      </div></details>
      </section><aside className="ticket-properties" aria-label="Issue properties"><h3>Properties</h3>
      <div className="facts">
        <Fact label="Status">
          <Badge value={issueGroup(t)} />
        </Fact>
        <Fact label="Coordinator">{t.coordinator}</Fact>
        <Fact label="Owner">{t.owner ?? "—"}</Fact>
        <Fact label="Reviewer">{t.reviewer ?? "—"}</Fact>
        <Fact label="Created">{time(t.created_at)}</Fact>
        <Fact label="Updated">{ago(t.updated_at)}</Fact>
      </div>
      <div className="ticket-property"><h4>Priority</h4><div className="row"><PriorityIcon priority={t.issue.priority} />{t.issue.priority}</div></div>
      <div className="ticket-property"><h4>Labels</h4><div className="row">{t.issue.labels.length ? t.issue.labels.map((l) => <span className="ticket-label" key={l}>{l}</span>) : <span className="muted">No labels</span>}</div></div>
      </aside></div>
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

function IssueMetadata({ task, onSaved }: { task: Task; onSaved: () => unknown }) {
  const [editing, setEditing] = useState(false);
  const [labels, setLabels] = useState(task.issue.labels.join(", "));
  const [priority, setPriority] = useState(task.issue.priority);
  const [description, setDescription] = useState(task.issue.description);
  const action = useAction();
  return <div className="card issue-metadata">
    <div className="row"><h3 className="grow">Issue details</h3><Badge value={task.issue.priority} />
      {task.issue.labels.map((label) => <Badge key={label} value={label} tone="info" />)}
      <button className="ghost small" onClick={() => setEditing(!editing)}>{editing ? "Dismiss edit" : "Edit issue"}</button></div>
    {editing ? <div className="form">
      <label>Description<textarea rows={4} maxLength={2400} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <p className="muted small">Pause automation and wait for active attempts before changing the description.</p>
      <label>Labels (comma separated)<input value={labels} onChange={(e) => setLabels(e.target.value)} /></label>
      <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value as IssueFields["priority"])}>{["low","normal","high","urgent"].map((p) => <option key={p}>{p}</option>)}</select></label>
      <ErrorNote error={action.error} />
      <button className="primary" disabled={action.busy} onClick={() => action.run(async () => {
        await api.updateIssue(task.id, { description, labels: labels.split(",").map((l) => l.trim()).filter(Boolean), priority }, task.revision);
        setEditing(false); onSaved();
      })}>Save issue</button>
    </div> : <p className="issue-description">{task.issue.description || "No description provided."}</p>}
  </div>;
}
