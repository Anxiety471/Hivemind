// Backlog the agents file when they discuss what to do next. Nothing here is implemented.
import { useState } from "react";
import { api, type BacklogIssue, type IssueSettings } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { Badge, Empty, ErrorNote, PageHeader, ago, time, useAction, useAsync } from "../ui";

const isIssueEvent = (type: string) => type.startsWith("issue.") || type === "config.changed";

export function Issues({ selected }: { selected?: string }) {
  const [status, setStatus] = useState("open");
  const issues = useAsync(() => api.issues(status), [status]);
  const settings = useAsync(() => api.issueSettings(), []);
  useRefreshOn((e) => isIssueEvent(e.type), () => {
    issues.reload();
    settings.reload();
  }, [issues.reload, settings.reload]);
  const list = issues.data?.issues ?? [];
  const active = selected && list.some((issue) => issue.id === selected) ? selected : list[0]?.id;

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="list-head">
          <h2>Issues</h2>
          <div className="row">
            {["open", "dismissed", "all"].map((value) => (
              <button
                key={value}
                className={status === value ? "small primary" : "small ghost"}
                onClick={() => setStatus(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <ErrorNote error={issues.error} />
        {issues.data && list.length === 0 && (
          <Empty>{status === "open" ? "No open issues yet." : "Nothing in this list."}</Empty>
        )}
        {list.map((issue) => (
          <a
            key={issue.id}
            href={href("issues", issue.id)}
            className={issue.id === active ? "list-item active" : "list-item"}
          >
            <div className="list-item-top">
              <Badge value={issue.kind} />
              <Badge value={issue.priority} />
              <span className="muted small">{ago(issue.created_at)}</span>
            </div>
            <div className="list-item-title">{issue.title}</div>
            <div className="muted small">filed by {issue.proposed_by}</div>
          </a>
        ))}
      </aside>
      <section className="detail-pane">
        <Council settings={settings.data} error={settings.error} onSaved={settings.reload} />
        {active ? (
          <IssueDetail key={active} id={active} onChanged={issues.reload} />
        ) : (
          <Empty>
            When the council runs, agents discuss the next feature, improvement, or bug fix and file it here.
            The backlog waits; it is not implemented on its own.
          </Empty>
        )}
      </section>
    </div>
  );
}

function Council({
  settings,
  error,
  onSaved,
}: {
  settings: IssueSettings | null;
  error: string | null;
  onSaved: () => void;
}) {
  const rounds = useAsync(() => api.issueRounds(), []);
  const action = useAction();
  useRefreshOn((e) => isIssueEvent(e.type), rounds.reload, [rounds.reload]);
  if (!settings) return <ErrorNote error={error} />;
  const latest = rounds.data?.rounds[0];
  return (
    <div className="card">
      <PageHeader
        title="Issue council"
        sub={
          settings.enabled
            ? settings.mode === "automatic"
              ? `Automatic. A discussion starts after the hive has been quiet for ${Math.round(settings.idle_secs / 60)} min, and at least ${Math.round(settings.interval_secs / 60)} min since the last one.`
              : `Scheduled. A discussion starts every ${Math.round(settings.interval_secs / 60)} min while Hivemind is serving.`
            : "Off. Agents will not discuss or file issues until you turn the council on."
        }
      >
        <button
          className="primary"
          disabled={!settings.enabled || settings.running || action.busy}
          onClick={() =>
            action.run(async () => {
              await api.startIssueRound();
              onSaved();
              rounds.reload();
            })
          }
        >
          {settings.running ? "Discussing…" : "Discuss now"}
        </button>
      </PageHeader>
      <ErrorNote error={action.error} />
      {latest && (
        <p className="muted small">
          Latest council {ago(latest.started_at)} · <Badge value={latest.status} /> · {latest.trigger} ·{" "}
          {latest.issue_count} filed
          {latest.error ? ` · ${latest.error}` : ""}
        </p>
      )}
      {settings.next_eligible_at && !settings.running && (
        <p className="muted small">
          Next eligible {time(settings.next_eligible_at)}
          {settings.mode === "automatic" ? " if the hive is quiet" : ""}.
        </p>
      )}
      <SettingsForm
        key={`${settings.enabled}:${settings.mode}:${settings.interval_secs}:${settings.idle_secs}:${settings.group}:${settings.members.join(",")}:${settings.prompt ?? ""}`}
        settings={settings}
        onSaved={onSaved}
      />
    </div>
  );
}

function SettingsForm({ settings, onSaved }: { settings: IssueSettings; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [mode, setMode] = useState(settings.mode);
  const [intervalMin, setIntervalMin] = useState(Math.max(1, Math.round(settings.interval_secs / 60)));
  const [idleMin, setIdleMin] = useState(Math.max(1, Math.round(settings.idle_secs / 60)));
  const [maxIssues, setMaxIssues] = useState(settings.max_issues_per_round);
  const [who, setWho] = useState(settings.group ? "group" : settings.members.length ? "members" : "everyone");
  const [group, setGroup] = useState(settings.group ?? settings.groups[0] ?? "");
  const [members, setMembers] = useState(settings.members);
  const [workspace, setWorkspace] = useState(settings.workspace ?? "");
  const [prompt, setPrompt] = useState(settings.prompt ?? settings.default_prompt);
  const action = useAction();

  const save = () =>
    action.run(async () => {
      const goal = prompt.trim();
      await api.updateIssueSettings({
        enabled,
        mode,
        interval_secs: intervalMin * 60,
        idle_secs: idleMin * 60,
        max_issues_per_round: maxIssues,
        members: who === "members" ? members : [],
        group: who === "group" ? group : null,
        workspace: workspace.trim() ? workspace.trim() : null,
        prompt: !goal || goal === settings.default_prompt.trim() ? null : goal,
      });
      onSaved();
    });

  return (
    <div className="form">
      <p className="muted small">
        Set what they discuss, how often they meet, and who attends. Saving applies on the next council.
      </p>
      <label className="inline">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable the council
      </label>
      <label>
        What they discuss
        <textarea
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <div className="row">
        <button type="button" className="small ghost" onClick={() => setPrompt(settings.default_prompt)}>
          Use the default prompt
        </button>
      </div>
      <label>
        When to discuss
        <select value={mode} onChange={(e) => setMode(e.target.value as IssueSettings["mode"])}>
          <option value="automatic">Automatic, when the hive is quiet</option>
          <option value="scheduled">On a schedule</option>
        </select>
      </label>
      <div className="row">
        <label>
          At least every (minutes)
          <input
            type="number"
            min={1}
            max={43200}
            value={intervalMin}
            onChange={(e) => setIntervalMin(Number(e.target.value))}
          />
        </label>
        {mode === "automatic" && (
          <label>
            After quiet for (minutes)
            <input
              type="number"
              min={1}
              max={1440}
              value={idleMin}
              onChange={(e) => setIdleMin(Number(e.target.value))}
            />
          </label>
        )}
        <label>
          Issues per discussion
          <input
            type="number"
            min={1}
            max={20}
            value={maxIssues}
            onChange={(e) => setMaxIssues(Number(e.target.value))}
          />
        </label>
      </div>
      <label>
        Who discusses
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="everyone">Every persona</option>
          {settings.groups.length > 0 && <option value="group">A group</option>}
          <option value="members">Selected personas</option>
        </select>
      </label>
      {who === "group" && (
        <label>
          Group
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            {settings.groups.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {who === "members" && (
        <div className="row">
          {settings.personas.map((name) => (
            <label key={name} className="inline">
              <input
                type="checkbox"
                checked={members.includes(name)}
                onChange={(e) =>
                  setMembers((current) =>
                    e.target.checked ? [...current, name] : current.filter((member) => member !== name),
                  )
                }
              />
              {name}
            </label>
          ))}
        </div>
      )}
      <label>
        Workspace to consider <span className="muted">(optional)</span>
        <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="Path the council should look at" />
      </label>
      <ErrorNote error={action.error} />
      <div className="row">
        <button className="primary" disabled={action.busy} onClick={save}>
          Save settings
        </button>
      </div>
    </div>
  );
}

function IssueDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useAsync(() => api.issue(id), [id]);
  const action = useAction();
  const [reason, setReason] = useState("");
  useRefreshOn((e) => isIssueEvent(e.type), detail.reload, [id, detail.reload]);
  const issue: BacklogIssue | undefined = detail.data?.issue;
  if (!issue) return <ErrorNote error={detail.error} />;
  return (
    <article className="card">
      <PageHeader title={issue.title} sub={`Filed by ${issue.proposed_by} · ${time(issue.created_at)}`}>
        <Badge value={issue.kind} />
        <Badge value={issue.status} />
        <Badge value={issue.priority} />
      </PageHeader>
      <p style={{ whiteSpace: "pre-wrap" }}>{issue.body}</p>
      <p className="muted small">Round {issue.round_id}. This issue is not scheduled for implementation.</p>
      {issue.dismiss_reason && <p className="muted">Dismissed: {issue.dismiss_reason}</p>}
      {issue.status === "open" && (
        <div className="form">
          <label>
            Dismiss reason <span className="muted">(optional)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <ErrorNote error={action.error} />
          <button
            className="ghost"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await api.dismissIssue(id, reason.trim() || undefined);
                onChanged();
                detail.reload();
              })
            }
          >
            Dismiss
          </button>
        </div>
      )}
    </article>
  );
}
