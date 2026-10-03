// Linear-style issue tracker over coordination tasks: grouped list and board
// views, an issue page with nested sub-issues, and a quick-create modal.
// Every issue can spawn sub-issues, which can spawn their own, and so on.
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Attempt, type Task, type TaskDetail } from "../api";
import { Icon, StatusIcon } from "../icons";
import {
  STATUS_GROUPS,
  STATUS_LABEL,
  ancestry,
  childrenIndex,
  isClosed,
  issueKey,
  matches,
  subProgress,
} from "../issues";
import { useRefreshOn } from "../live";
import { Markdown } from "../markdown";
import { href, navigate } from "../nav";
import { Avatar, Badge, ErrorNote, Meter, ago, duration, time, useAction, useAsync } from "../ui";

const isCoordination = (type: string) => /^(task|attempt|message|group)\./.test(type);

type Scope = "all" | "active" | "backlog";
type Layout = "list" | "board";
type Composer = { parent?: Task } | null;

/** Anything shaped like a task row: a full Task or a detail's TaskSummary. */
type Row = Pick<Task, "id" | "parent_id" | "objective" | "owner" | "reviewer" | "status"> &
  Partial<Pick<Task, "capabilities" | "updated_at" | "created_at" | "coordinator" | "root_id">>;

const LAYOUT_KEY = "hivemind.issues.layout";

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

/** First line is the title; anything after it is the description. */
export function splitObjective(objective: string) {
  const text = objective.trim();
  const at = text.indexOf("\n");
  return at < 0 ? { title: text, body: "" } : { title: text.slice(0, at).trim(), body: text.slice(at + 1).trim() };
}

function shortDate(seconds?: number) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Whether a new child may hang from `task`, and why not otherwise (mirrors the server's rule). */
function childBlock(task: Row, root: Row | undefined, index: Map<string, Row[]>): string | null {
  if (isClosed(task.status)) return `This issue is ${STATUS_LABEL[task.status].toLowerCase()}`;
  const top = root ?? task;
  const planned = (index.get(top.id)?.length ?? 0) > 0;
  if (top.status === "running" || (top.status === "needs_input" && planned)) return null;
  if (["submitted", "planning", "needs_input"].includes(top.status)) return "The coordinator is still planning this issue";
  return `The parent issue is ${STATUS_LABEL[top.status].toLowerCase()}`;
}

export function Issues({ selected }: { selected?: string }) {
  const tasks = useAsync(() => api.allTasks(), []);
  useRefreshOn((e) => isCoordination(e.type), tasks.reload, [tasks.reload]);
  const [composer, setComposer] = useState<Composer>(null);

  // `c` opens the composer, as in Linear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable=true]") || e.metaKey || e.ctrlKey || e.altKey)) return;
      if (e.key === "c" && !composer) {
        e.preventDefault();
        setComposer({});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composer]);

  const all = tasks.data ?? [];
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const index = useMemo(() => childrenIndex(all), [all]);

  return (
    <div className="issues">
      {selected ? (
        <IssuePage
          key={selected}
          id={selected}
          byId={byId}
          index={index}
          onNew={(parent) => setComposer({ parent })}
          onChanged={tasks.reload}
        />
      ) : (
        <IssueList all={all} index={index} error={tasks.error} loaded={tasks.data !== null} onNew={(parent) => setComposer({ parent })} />
      )}
      {composer && (
        <NewIssue
          parent={composer.parent}
          onClose={() => setComposer(null)}
          onCreated={(id, parent) => {
            setComposer(null);
            tasks.reload();
            if (!parent) navigate("issues", id);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List and board
// ---------------------------------------------------------------------------

function IssueList({
  all,
  index,
  error,
  loaded,
  onNew,
}: {
  all: Task[];
  index: Map<string, Task[]>;
  error: string | null;
  loaded: boolean;
  onNew: (parent?: Task) => void;
}) {
  const [scope, setScope] = useState<Scope>("all");
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["canceled"]));
  const setLayout = (next: Layout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Only a preference.
    }
  };

  const searching = query.trim() !== "";
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const inScope = (t: Task) =>
    scope === "all" ? true : scope === "active" ? !isClosed(t.status) && t.status !== "submitted" : t.status === "submitted" || t.status === "planning";
  // Searching flattens the tree so a match at any depth shows up.
  const visible = all.filter((t) => (searching ? matches(t, query) : !t.parent_id) && inScope(t));
  const groups = STATUS_GROUPS.map((g) => ({ ...g, items: visible.filter((t) => g.statuses.includes(t.status)) }));
  const total = visible.length;

  return (
    <div className="issues-page">
      <header className="issues-bar">
        <div className="issues-tabs">
          <span className="issues-title">
            <Icon name="issues" /> Issues
          </span>
          {(["all", "active", "backlog"] as Scope[]).map((s) => (
            <button key={s} className={scope === s ? "tab on" : "tab"} onClick={() => setScope(s)}>
              {s === "all" ? "All issues" : s === "active" ? "Active" : "Backlog"}
            </button>
          ))}
        </div>
        <div className="issues-tools">
          <label className="search">
            <Icon name="search" size={14} />
            <input value={query} placeholder="Filter issues" onChange={(e) => setQuery((e.target as HTMLInputElement).value)} />
          </label>
          <div className="view-toggle" role="group" aria-label="Layout">
            <button className={layout === "list" ? "on" : ""} aria-label="List view" title="List" onClick={() => setLayout("list")}>
              <Icon name="list" size={14} />
            </button>
            <button className={layout === "board" ? "on" : ""} aria-label="Board view" title="Board" onClick={() => setLayout("board")}>
              <Icon name="board" size={14} />
            </button>
          </div>
          <button className="primary small new-issue" onClick={() => onNew()} title="New issue (C)">
            <Icon name="plus" size={14} /> New issue
          </button>
        </div>
      </header>
      <ErrorNote error={error} />
      {loaded && all.length === 0 ? (
        <div className="issues-empty">
          <StatusIcon status="submitted" size={28} />
          <h2>No issues yet</h2>
          <p className="muted">Create an issue and the coordinator plans it into sub-issues, or break it down yourself.</p>
          <button className="primary" onClick={() => onNew()}>
            <Icon name="plus" size={14} /> New issue
          </button>
          <span className="muted small">
            or press <kbd>C</kbd>
          </span>
        </div>
      ) : layout === "list" ? (
        <div className="issue-groups">
          {groups
            .filter((g) => g.items.length)
            .map((g) => {
              const closed = collapsed.has(g.key);
              return (
                <section key={g.key} className="issue-group">
                  <div className="group-head">
                    <button
                      className="group-toggle"
                      aria-expanded={!closed}
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.key)) next.delete(g.key);
                          else next.add(g.key);
                          return next;
                        })
                      }
                    >
                      <span className="chev" data-open={!closed}>
                        <Icon name="chevron" size={12} />
                      </span>
                      <StatusIcon status={g.statuses[0]} />
                      <span className="group-label">{g.label}</span>
                      <span className="group-count">{g.items.length}</span>
                    </button>
                    <button className="icon-btn" aria-label={`New issue in ${g.label}`} onClick={() => onNew()}>
                      <Icon name="plus" size={14} />
                    </button>
                  </div>
                  {!closed &&
                    g.items.map((t) => (
                      <IssueTree key={t.id} task={t} index={index} depth={0} nested={!searching} onNew={onNew} root={t.parent_id ? byId.get(t.root_id) : undefined} />
                    ))}
                </section>
              );
            })}
          {loaded && total === 0 && <div className="issues-none muted">No issues match.</div>}
        </div>
      ) : (
        <div className="board">
          {groups
            .filter((g) => g.items.length || ["todo", "progress", "review", "done"].includes(g.key))
            .map((g) => (
              <section key={g.key} className="board-col">
                <div className="board-head">
                  <StatusIcon status={g.statuses[0]} />
                  <span className="group-label">{g.label}</span>
                  <span className="group-count">{g.items.length}</span>
                  <span className="grow" />
                  <button className="icon-btn" aria-label={`New issue in ${g.label}`} onClick={() => onNew()}>
                    <Icon name="plus" size={14} />
                  </button>
                </div>
                <div className="board-cards">
                  {g.items.map((t) => (
                    <IssueCard key={t.id} task={t} index={index} />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}

function SubCount({ id, index }: { id: string; index: Map<string, Row[]> }) {
  const { done, total } = subProgress(id, index);
  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <span className="chip sub-count" title={`${done} of ${total} sub-issues done`}>
      <span className="ring" style={{ ["--pct" as string]: `${pct}%` }} />
      {done}/{total}
    </span>
  );
}

function Labels({ caps }: { caps?: string[] }) {
  if (!caps?.length) return null;
  return (
    <>
      {caps.slice(0, 2).map((c) => (
        <span key={c} className="chip label">
          <span className="label-dot" style={{ background: `hsl(${hue(c)} 60% 55%)` }} />
          {c}
        </span>
      ))}
    </>
  );
}

function hue(text: string) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function Assignee({ name }: { name: string | null | undefined }) {
  return name ? (
    <span className="assignee" title={`Assigned to ${name}`}>
      <Avatar name={name} />
    </span>
  ) : (
    <span className="assignee none" title="Unassigned" />
  );
}

/** One row plus, when expanded, its sub-issues at any depth. */
function IssueTree({
  task,
  index,
  depth,
  nested,
  onNew,
  root,
  expanded = false,
}: {
  task: Row;
  index: Map<string, Row[]>;
  depth: number;
  nested: boolean;
  onNew: (parent?: Task) => void;
  root?: Row;
  /** Start open; nested rows always do once their parent is opened. */
  expanded?: boolean;
}) {
  const kids = nested ? index.get(task.id) ?? [] : [];
  const [open, setOpen] = useState(expanded || depth > 0);
  const blocked = childBlock(task, root ?? (task.parent_id ? undefined : task), index);
  return (
    <>
      <div className="issue-row" style={{ ["--depth" as string]: depth }} onClick={() => navigate("issues", task.id)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && navigate("issues", task.id)}>
        <span className="row-lead">
          {kids.length > 0 ? (
            <button
              className="chev-btn"
              aria-label={open ? "Collapse sub-issues" : "Expand sub-issues"}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(!open);
              }}
            >
              <span className="chev" data-open={open}>
                <Icon name="chevron" size={12} />
              </span>
            </button>
          ) : (
            <span className="chev-btn" />
          )}
        </span>
        <span className="issue-key mono">{issueKey(task.id)}</span>
        <StatusIcon status={task.status} />
        <span className="issue-title">{splitObjective(task.objective).title}</span>
        <span className="row-meta">
          <SubCount id={task.id} index={index} />
          <Labels caps={task.capabilities} />
          <button
            className="icon-btn row-add"
            aria-label="Add sub-issue"
            title={blocked ?? "Add sub-issue"}
            disabled={blocked !== null}
            onClick={(e) => {
              e.stopPropagation();
              onNew(task as Task);
            }}
          >
            <Icon name="subissue" size={14} />
          </button>
          <span className="issue-date muted">{shortDate(task.updated_at ?? task.created_at)}</span>
          <Assignee name={task.owner} />
        </span>
      </div>
      {open &&
        kids.map((k) => (
          <IssueTree key={k.id} task={k} index={index} depth={depth + 1} nested={nested} onNew={onNew} root={root ?? task} />
        ))}
    </>
  );
}

function IssueCard({ task, index }: { task: Task; index: Map<string, Task[]> }) {
  const { title } = splitObjective(task.objective);
  const kids = index.get(task.id) ?? [];
  return (
    <a className="issue-card" href={href("issues", task.id)}>
      <div className="card-top">
        <span className="issue-key mono">{issueKey(task.id)}</span>
        <Assignee name={task.owner} />
      </div>
      <div className="card-title">
        <StatusIcon status={task.status} />
        <span>{title}</span>
      </div>
      {kids.length > 0 && (
        <ul className="card-kids">
          {kids.slice(0, 4).map((k) => (
            <li key={k.id}>
              <StatusIcon status={k.status} size={12} />
              <span>{splitObjective(k.objective).title}</span>
            </li>
          ))}
          {kids.length > 4 && <li className="muted">+{kids.length - 4} more</li>}
        </ul>
      )}
      <div className="card-meta">
        <SubCount id={task.id} index={index} />
        <Labels caps={task.capabilities} />
      </div>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Issue page
// ---------------------------------------------------------------------------

function IssuePage({
  id,
  byId,
  index,
  onNew,
  onChanged,
}: {
  id: string;
  byId: Map<string, Task>;
  index: Map<string, Task[]>;
  onNew: (parent?: Task) => void;
  onChanged: () => void;
}) {
  const detail = useAsync(() => api.task(id), [id]);
  const attempts = useAsync(() => api.attempts(id), [id]);
  const action = useAction();
  useRefreshOn(
    (e) => isCoordination(e.type),
    () => {
      detail.reload();
      attempts.reload();
    },
    [id],
  );

  const d = detail.data?.task;
  if (!d) {
    return (
      <div className="issue-page">
        <div className="issue-top">
          <a className="crumb-link" href={href("issues")}>
            Issues
          </a>
        </div>
        <div className="issue-main-inner">
          <ErrorNote error={detail.error} />
        </div>
      </div>
    );
  }
  const t = d.task;
  const root = byId.get(t.root_id) ?? (t.id === t.root_id ? t : undefined);
  const chain = ancestry(t.id, byId);
  const { title, body } = splitObjective(t.objective);
  const terminal = isClosed(t.status);
  const refresh = () => {
    detail.reload();
    onChanged();
  };
  const act = (name: "cancel" | "pause" | "resume", payload?: unknown) => action.run(() => api.taskAction(id, name, payload).then(refresh));

  // The tree under this issue: the full task list knows every depth; the
  // detail's children fill in anything the list has not loaded yet.
  const merged = new Map<string, Row[]>(index);
  for (const c of d.children) {
    const parent = c.parent_id ?? t.id;
    const list = merged.get(parent) ?? [];
    if (!list.some((x) => x.id === c.id)) merged.set(parent, [...list, c]);
  }
  const kids = merged.get(t.id) ?? [];
  const progress = subProgress(t.id, merged);
  const blocked = childBlock(t, root, merged);

  return (
    <div className="issue-page">
      <div className="issue-top">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a className="crumb-link" href={href("issues")}>
            Issues
          </a>
          {chain.map((p) => (
            <span key={p.id} className="crumb-part">
              <Icon name="chevron" size={10} />
              <a className="crumb-link" href={href("issues", p.id)} title={p.objective}>
                {issueKey(p.id)} <span className="crumb-title">{splitObjective(p.objective).title}</span>
              </a>
            </span>
          ))}
          <span className="crumb-part">
            <Icon name="chevron" size={10} />
            <span className="crumb-here">{issueKey(t.id)}</span>
          </span>
        </nav>
      </div>
      <div className="issue-layout">
        <div className="issue-main">
          <div className="issue-main-inner">
            {chain.length > 0 && (
              <a className="parent-link" href={href("issues", chain[chain.length - 1].id)}>
                <span className="muted">Sub-issue of</span>
                <StatusIcon status={chain[chain.length - 1].status} size={12} />
                <span className="mono muted">{issueKey(chain[chain.length - 1].id)}</span>
                <span>{splitObjective(chain[chain.length - 1].objective).title}</span>
              </a>
            )}
            <h1 className="issue-heading">{title}</h1>
            {body ? <div className="issue-body"><Markdown text={body} /></div> : <p className="issue-body muted">No description.</p>}
            <ErrorNote error={action.error} />
            {t.status_reason && <div className="callout">{t.status_reason}</div>}

            <InputNeeded detail={d} onDone={refresh} />

            {t.acceptance.length > 0 && (
              <section className="issue-section">
                <h3 className="section-title">Acceptance criteria</h3>
                <ul className="checks">
                  {t.acceptance.map((a) => (
                    <li key={a} data-done={t.status === "completed"}>
                      {a}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="issue-section sub-issues">
              <div className="section-head">
                <h3 className="section-title">
                  Sub-issues
                  {progress.total > 0 && (
                    <span className="muted small">
                      {" "}
                      {progress.done}/{progress.total}
                    </span>
                  )}
                </h3>
                {progress.total > 0 && (
                  <div className="progress-bar" aria-hidden="true">
                    <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                  </div>
                )}
                <button className="icon-btn" aria-label="Add sub-issue" title={blocked ?? "Add sub-issue"} disabled={blocked !== null} onClick={() => onNew(t)}>
                  <Icon name="plus" size={14} />
                </button>
              </div>
              <div className="sub-list">
                {kids.map((k) => (
                  <IssueTree key={k.id} task={k} index={merged} depth={0} nested onNew={onNew} root={root} expanded />
                ))}
              </div>
              <QuickAdd parent={t} blocked={blocked} onAdded={refresh} />
            </section>

            {!terminal && <Steer id={id} onDone={() => detail.reload()} />}

            {(d.artifacts.length > 0 || d.evidence.length > 0) && (
              <section className="issue-section">
                <h3 className="section-title">Results</h3>
                {d.evidence.length > 0 && (
                  <ul className="evidence">
                    {d.evidence.map((e, i) => (
                      <li key={i}>
                        <Badge value={e.outcome} tone={e.outcome === "passed" ? "ok" : "bad"} /> <strong>{e.check}</strong> <span className="muted">{e.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {d.artifacts.length > 0 && (
                  <ul className="artifacts">
                    {d.artifacts.map((a) => (
                      <li key={a.id}>
                        <Badge value={a.kind} tone="muted" /> <span className="mono small">{a.reference}</span>
                        <div className="muted small">{a.description}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="issue-section">
              <h3 className="section-title">Activity</h3>
              <Activity task={t} attempts={attempts.data?.attempts ?? []} />
            </section>
          </div>
        </div>

        <aside className="issue-props">
          <Prop label="Status">
            <span className="prop-status">
              <StatusIcon status={t.status} /> {STATUS_LABEL[t.status]}
              {t.paused && <Badge value="paused" />}
            </span>
          </Prop>
          <Prop label="Assignee">
            <Person name={t.owner} />
          </Prop>
          <Prop label="Reviewer">
            <Person name={t.reviewer} />
          </Prop>
          <Prop label="Coordinator">
            <Person name={t.coordinator} />
          </Prop>
          <Prop label="Labels">
            {t.capabilities.length ? (
              <span className="prop-labels">
                <Labels caps={t.capabilities} />
              </span>
            ) : (
              <span className="muted">None</span>
            )}
          </Prop>
          <Prop label="Kind">{t.kind}</Prop>
          <Prop label="Workspace">
            <span className="mono small prop-path" title={t.workspace}>
              {t.workspace}
            </span>
          </Prop>
          <Prop label="Created">{time(t.created_at)}</Prop>
          <Prop label="Updated">{ago(t.updated_at)}</Prop>
          {d.usage && (
            <div className="prop-budget">
              <div className="prop-label">Budget</div>
              <Meter label="Dispatches" value={d.usage.dispatches} max={d.usage.dispatch_limit} />
              <Meter label="Tool actions" value={d.usage.tool_actions} max={d.usage.tool_action_limit} />
              <Meter label="Messages" value={d.usage.messages} max={d.usage.message_limit} />
              <div className="muted small">
                {duration(d.usage.started_at, terminal ? t.updated_at : null)} elapsed · deadline {time(d.usage.deadline)}
                {d.usage.tokens != null && ` · ${d.usage.tokens} tokens`}
              </div>
            </div>
          )}
          <div className="prop-actions">
            <a className="button ghost small" href={href("rooms", `task-${t.root_id}`)}>
              <Icon name="room" size={14} /> Open room
            </a>
            <button className="ghost small" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => onNew(t)}>
              <Icon name="subissue" size={14} /> Add sub-issue
            </button>
            {!terminal && !t.paused && (
              <button className="ghost small" disabled={action.busy} onClick={() => act("pause")}>
                <Icon name="pause" size={14} /> Pause
              </button>
            )}
            {!terminal && (t.paused || t.status === "blocked") && (
              <button className="ghost small" disabled={action.busy} onClick={() => act("resume", { retry: t.status === "blocked" })}>
                <Icon name="play" size={14} /> Resume
              </button>
            )}
            {!terminal && (
              <button className="danger ghost small" disabled={action.busy} onClick={() => act("cancel")}>
                <Icon name="cancel" size={14} /> Cancel issue
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <div className="prop-label">{label}</div>
      <div className="prop-value">{children}</div>
    </div>
  );
}

function Person({ name }: { name: string | null }) {
  if (!name) return <span className="muted">Unassigned</span>;
  return (
    <span className="person">
      <Avatar name={name} />
      {name}
    </span>
  );
}

/** Inline "Add sub-issue" field under the sub-issue list: type a title, press Enter. */
function QuickAdd({ parent, blocked, onAdded }: { parent: Task; blocked: string | null; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const action = useAction();
  const create = () => {
    const objective = title.trim();
    if (!objective || action.busy) return;
    action.run(() =>
      api.addChild(parent.id, { objective }).then(() => {
        setTitle("");
        onAdded();
      }),
    );
  };
  if (blocked) return <div className="quick-add disabled muted small">{blocked}; sub-issues can be added once it is running.</div>;
  return (
    <>
      <div className="quick-add">
        <Icon name="plus" size={14} />
        <input
          value={title}
          placeholder="Add sub-issue…"
          aria-label="New sub-issue title"
          onChange={(e) => setTitle((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") setTitle("");
          }}
        />
        {title.trim() && (
          <button className="primary small" disabled={action.busy} onClick={create}>
            Create
          </button>
        )}
      </div>
      <ErrorNote error={action.error} />
    </>
  );
}

function InputNeeded({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const t = detail.task;
  const [answer, setAnswer] = useState("");
  const action = useAction();
  const questions = detail.questions ?? [];
  if (t.status !== "needs_input" && questions.length === 0) return null;
  const send = () => {
    if (!answer.trim() || action.busy) return;
    action.run(() => api.taskInput(t.id, answer.trim()).then(() => (setAnswer(""), onDone())));
  };
  return (
    <section className="issue-section attention">
      <h3 className="section-title">
        <StatusIcon status="needs_input" /> Input needed
      </h3>
      {questions.map((q) => (
        <div key={q.attempt_id} className="question">
          <Person name={q.persona} /> <em>"{q.question}"</em>
          {q.to && <span className="muted"> (to {q.to})</span>}
          <span className="muted small"> · {ago(q.asked_at)}</span>
        </div>
      ))}
      <div className="row">
        <input value={answer} placeholder="Answer…" onChange={(e) => setAnswer((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className="primary" disabled={!answer.trim() || action.busy} onClick={send}>
          Send answer
        </button>
      </div>
      <ErrorNote error={action.error} />
    </section>
  );
}

function Steer({ id, onDone }: { id: string; onDone: () => void }) {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const action = useAction();
  const send = () => {
    if (!message.trim() || action.busy) return;
    action.run(() =>
      api.steerTask(id, message.trim()).then((res) => {
        setMessage("");
        const targets = res.steer.delivered_to;
        setStatus(targets.length ? `Delivered live to ${targets.join(", ")}` : "Queued as feedback (no live session)");
        onDone();
      }),
    );
  };
  return (
    <div className="steer">
      <input
        value={message}
        placeholder="Steer the running worker…"
        aria-label="Steer running attempt"
        onChange={(e) => setMessage((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
      />
      <button className="ghost small" disabled={!message.trim() || action.busy} onClick={send}>
        Steer
      </button>
      {status && <span className="muted small">{status}</span>}
      <ErrorNote error={action.error} />
    </div>
  );
}

function Activity({ task, attempts }: { task: Task; attempts: Attempt[] }) {
  const verb = (a: Attempt) => (a.kind === "plan" ? "planned" : a.kind === "review" ? "reviewed" : a.kind === "inbox" ? "read the inbox" : "worked");
  const items = [...attempts].sort((a, b) => a.started_at - b.started_at);
  return (
    <ol className="activity">
      <li>
        <span className="act-dot" />
        <span>
          <strong>{task.coordinator || "user"}</strong> created the issue
        </span>
        <span className="muted small">{ago(task.created_at)}</span>
      </li>
      {items.map((a) => (
        <li key={a.id}>
          <Avatar name={a.persona} />
          <span>
            <strong>{a.persona}</strong> {verb(a)} <Badge value={a.state} />
            {a.failure_class && <span className="muted small"> {a.failure_class}</span>}
            {a.branch && <span className="mono small muted"> · {a.branch}</span>}
          </span>
          <span className="muted small">
            {ago(a.started_at)} · {duration(a.started_at, a.ended_at)}
          </span>
        </li>
      ))}
      {feedbackItems(task)}
    </ol>
  );
}

function feedbackItems(task: Task) {
  return task.feedback.map((f, i) => (
    <li key={`f${i}`}>
      <span className="act-dot" />
      <span className="feedback">{f}</span>
    </li>
  ));
}

// ---------------------------------------------------------------------------
// New issue / sub-issue modal
// ---------------------------------------------------------------------------

function NewIssue({ parent, onClose, onCreated }: { parent?: Task; onClose: () => void; onCreated: (id: string, parent?: Task) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [labels, setLabels] = useState("");
  const [owner, setOwner] = useState("");
  const [subs, setSubs] = useState<string[]>([]);
  const agents = useAsync(() => api.agents(), []);
  const action = useAction();
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);

  const lines = (s: string) =>
    s
      .split(/\n|,/)
      .map((x) => x.trim())
      .filter(Boolean);
  const objective = [title.trim(), description.trim()].filter(Boolean).join("\n\n");
  const criteria = lines(acceptance);

  const submit = () => {
    if (!title.trim() || action.busy) return;
    action.run(async () => {
      if (parent) {
        const res = await api.addChild(parent.id, {
          objective,
          acceptance: criteria,
          capabilities: lines(labels),
          ...(owner ? { owner } : {}),
        });
        onCreated(res.id, parent);
        return;
      }
      const plan = subs
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s, i) => ({ key: `sub-${i + 1}`, objective: s, acceptance: [s] }));
      const res = await api.submitTask(objective, criteria, lines(labels), plan);
      onCreated(res.id);
    });
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal new-issue-modal"
        role="dialog"
        aria-modal="true"
        aria-label={parent ? "New sub-issue" : "New issue"}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <header className="modal-head">
          <span className="modal-crumb">
            <span className="team-chip">HM</span>
            {parent ? (
              <>
                <Icon name="chevron" size={10} />
                <span className="mono">{issueKey(parent.id)}</span>
                <Icon name="chevron" size={10} />
                New sub-issue
              </>
            ) : (
              <>
                <Icon name="chevron" size={10} /> New issue
              </>
            )}
          </span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body">
          {parent && (
            <div className="parent-link static">
              <span className="muted">Sub-issue of</span>
              <StatusIcon status={parent.status} size={12} />
              <span>{splitObjective(parent.objective).title}</span>
            </div>
          )}
          <input ref={titleRef} className="title-input" placeholder="Issue title" aria-label="Issue title" value={title} onChange={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <textarea
            className="desc-input"
            rows={4}
            placeholder="Add description…"
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
          />
          <label className="field">
            <span>Acceptance criteria</span>
            <textarea
              rows={2}
              placeholder={parent ? "One per line — defaults to the title" : "One per line"}
              value={acceptance}
              onChange={(e) => setAcceptance((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          {!parent && (
            <div className="field">
              <span>Sub-issues</span>
              {subs.map((s, i) => (
                <div className="sub-draft" key={i}>
                  <StatusIcon status="submitted" size={12} />
                  <input
                    value={s}
                    placeholder="Sub-issue title"
                    aria-label={`Sub-issue ${i + 1}`}
                    autoFocus={i === subs.length - 1 && s === ""}
                    onChange={(e) => setSubs(subs.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault();
                        setSubs([...subs, ""]);
                      }
                    }}
                  />
                  <button className="icon-btn" aria-label={`Remove sub-issue ${i + 1}`} onClick={() => setSubs(subs.filter((_, j) => j !== i))}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
              <button className="ghost small add-sub" onClick={() => setSubs([...subs, ""])}>
                <Icon name="subissue" size={14} /> Add sub-issue
              </button>
              {subs.every((s) => !s.trim()) && <span className="muted small">Leave empty to let the coordinator plan the sub-issues.</span>}
            </div>
          )}
        </div>
        <footer className="modal-foot">
          <div className="pills">
            <label className="pill">
              <Icon name="issues" size={12} />
              <input placeholder="Labels" aria-label="Labels" value={labels} onChange={(e) => setLabels((e.target as HTMLInputElement).value)} />
            </label>
            {parent && (
              <label className="pill">
                <Icon name="agents" size={12} />
                <select aria-label="Assignee" value={owner} onChange={(e) => setOwner((e.target as HTMLSelectElement).value)}>
                  <option value="">Auto-assign</option>
                  {(agents.data?.agents ?? []).map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <ErrorNote error={action.error} />
          <button className="primary" disabled={!title.trim() || action.busy} onClick={submit}>
            {parent ? "Create sub-issue" : "Create issue"}
          </button>
        </footer>
      </div>
    </div>
  );
}

