import { useState } from "react";
import { api, type Task } from "../api";
import { useRefreshOn } from "../live";
import { Badge, ErrorNote, ago, useAction, useAsync } from "../ui";

export function IssueDiscussion({ task }: { task: Task }) {
  const comments = useAsync(async () => {
    const all = [] as Awaited<ReturnType<typeof api.taskComments>>["comments"];
    let after = 0;
    for (;;) {
      const page = await api.taskComments(task.id, after);
      all.push(...page.comments);
      if (page.comments.length < 200) return all;
      after = page.next_after;
    }
  }, [task.id]);
  const timeline = useAsync(() => api.taskTimeline(task.id), [task.id]);
  const [older, setOlder] = useState<NonNullable<typeof timeline.data>["events"]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [hasOlder, setHasOlder] = useState(true);
  const [body, setBody] = useState("");
  const action = useAction();
  useRefreshOn((e) => /^(task|attempt)\./.test(e.type), () => {
    comments.reload(); timeline.reload();
  }, [task.id]);
  const events = [...new Map([...older, ...(timeline.data?.events ?? [])].map((event) => [event.seq, event])).values()];
  const commentEvents = new Map(events.filter((event) => event.event_type === "task.commented").map((event) => [event.payload.comment_id, event.seq]));
  const commentIds = new Set((comments.data ?? []).map((comment) => comment.id));
  const rows = [
    ...(comments.data ?? []).map((c) => ({ key: `comment-${c.id}`, at: c.created_at, order: commentEvents.get(c.id) ?? 0, author: c.author, body: c.body, type: "comment" })),
    ...events.filter((e) => e.event_type !== "task.commented" || !commentIds.has(e.payload.comment_id as number)).map((e) => ({
      key: `event-${e.seq}`, at: e.created_at, order: e.seq, author: e.actor,
      body: eventText(e.event_type, e.payload), type: e.event_type,
    })),
  ].sort((a, b) => a.at - b.at || a.order - b.order || a.key.localeCompare(b.key));
  return <section className="card issue-discussion">
    <h3>Discussion & activity</h3>
    <ErrorNote error={comments.error ?? timeline.error ?? action.error} />
    {timeline.data?.has_more && hasOlder && <button className="ghost small" disabled={action.busy} onClick={() => action.run(async () => {
      const page = await api.taskTimeline(task.id, before ?? timeline.data!.next_before!);
      setOlder((current) => [...page.events, ...current.filter((e) => !page.events.some((p) => p.seq === e.seq))]);
      setBefore(page.next_before); setHasOlder(page.has_more);
    })}>Load older activity</button>}
    <ol className="issue-timeline">
      {rows.map((row) => <li key={row.key} className={row.type === "comment" ? "issue-comment" : "issue-event"}>
        <div className="row"><strong>{row.author}</strong><span className="muted small">{ago(row.at)}</span>
          {row.type !== "comment" && <Badge value={row.type.replace(/\./g, " ")} tone="muted" />}</div>
        <p>{row.body}</p>
      </li>)}
    </ol>
    <label>Add a comment<textarea rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Discuss requirements, findings, or progress…" /></label>
    <p className="muted small">Comments enter the next agent context. Use Steer to guide a running attempt, or Send answer when input is needed.</p>
    <button className="primary" disabled={!body.trim() || action.busy} onClick={() => action.run(async () => {
      await api.commentTask(task.id, body.trim()); setBody(""); comments.reload(); timeline.reload();
    })}>Comment</button>
  </section>;
}

function eventText(type: string, payload: Record<string, unknown>) {
  const detail = payload.note ?? payload.summary ?? payload.reason ?? payload.objective;
  if (typeof detail === "string") return detail;
  if (payload.to) return `Changed to ${payload.to}`;
  if (type === "task.issue_updated") return `Priority: ${payload.priority}. Labels: ${Array.isArray(payload.labels) ? payload.labels.join(", ") || "none" : "none"}.`;
  return type.replace(/\./g, " ").replace(/_/g, " ");
}
