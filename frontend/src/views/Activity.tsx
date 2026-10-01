// Live activity: the raw WebSocket event stream, newest first.
import { useState } from "preact/hooks";
import { decodeInstance } from "../api";
import { recentEvents, useLive, type LiveEvent } from "../live";
import { Empty, PageHeader } from "../ui";

const GROUPS = ["all", "conversation", "agent", "runtime", "task", "attempt", "thread", "system"];

function summary(e: LiveEvent) {
  const p = e.payload ?? {};
  const who = p.agent_id ?? (p.agent_instance_id ? decodeInstance(p.agent_instance_id)?.persona : undefined) ?? p.actor;
  const parts = [who, p.room_id, p.runtime, p.reason, p.task_id, p.to ? `→ ${p.to}` : p.payload?.to ? `→ ${p.payload.to}` : null, p.text];
  return parts.filter(Boolean).join(" · ");
}

export function Activity() {
  const [events, setEvents] = useState<LiveEvent[]>(() => recentEvents().reverse());
  const [filter, setFilter] = useState("all");
  const [paused, setPaused] = useState(false);
  useLive(
    (e) => {
      if (!paused) setEvents((list) => [e, ...list].slice(0, 300));
    },
    [paused],
  );
  const shown = events.filter((e) => filter === "all" || e.type.startsWith(filter + "."));
  return (
    <div class="page">
      <PageHeader title="Live activity" sub="Events streamed from /api/v1/ws. Notifications only; durable history lives in rooms and tasks.">
        <button class="ghost" onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button class="ghost" onClick={() => setEvents([])}>
          Clear
        </button>
      </PageHeader>
      <div class="segmented">
        {GROUPS.map((g) => (
          <button class={filter === g ? "on" : ""} onClick={() => setFilter(g)}>
            {g}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Empty>Waiting for events. Send a message or submit a task.</Empty>
      ) : (
        <div class="card events">
          {shown.map((e, i) => (
            <div class="event" key={i}>
              <span class="mono muted small">{new Date(e.at).toLocaleTimeString()}</span>
              <span class={`event-type t-${e.type.split(".")[0]}`}>{e.type}</span>
              <span class="small">{summary(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
