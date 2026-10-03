// Live activity: the raw WebSocket event stream, newest first.
import { useState } from "react";
import { decodeInstance } from "../api";
import { recentEvents, useLive, type LiveEvent } from "../live";
import { Icon } from "../icons";
import { Empty, Tabs, TopBar } from "../ui";

const GROUPS = ["all", "conversation", "agent", "runtime", "task", "attempt", "thread", "system"];

function summary(e: LiveEvent) {
  const p = e.payload ?? {};
  const who = p.agent_id ?? (p.agent_instance_id ? decodeInstance(p.agent_instance_id)?.persona : undefined) ?? p.actor;
  const parts = [
    who,
    p.room_id,
    p.runtime,
    p.reason,
    p.task_id,
    p.to ? `→ ${p.to}` : p.payload?.to ? `→ ${p.payload.to}` : null,
    p.text,
    p.message ? `steer: "${p.message}"` : null,
    p.question ? `question: "${p.question}"` : null,
    p.answer ? `answer: "${p.answer}"` : null,
  ];
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
    <div className="view">
      <TopBar
        icon="activity"
        title="Live activity"
        actions={
          <>
            <span className="chip">
              <span className={paused ? "dot-off" : "dot-live"} /> {paused ? "Paused" : "Streaming"}
            </span>
            <button className="ghost small" onClick={() => setPaused((p) => !p)}>
              <Icon name={paused ? "play" : "pause"} size={13} /> {paused ? "Resume" : "Pause"}
            </button>
            <button className="ghost small" onClick={() => setEvents([])}>
              Clear
            </button>
          </>
        }
      >
        <Tabs label="Event type" value={filter} onChange={setFilter} options={GROUPS.map((g) => ({ value: g, label: g === "all" ? "All" : g[0].toUpperCase() + g.slice(1) }))} />
      </TopBar>
      {shown.length === 0 ? (
        <div className="view-body">
          <Empty>Waiting for events. Send a message or submit an issue.</Empty>
        </div>
      ) : (
        <div className="events">
          {shown.map((e, i) => (
            <div className="event" key={i}>
              <span className="mono muted small">{new Date(e.at).toLocaleTimeString()}</span>
              <span className={`event-type t-${e.type.split(".")[0]}`}>{e.type}</span>
              <span className="small ellipsis">{summary(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
