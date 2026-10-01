// Runtime sessions (epochs) per room, with rotation of live sessions.
import { api } from "../api";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { roomLabel, useTaskNames } from "../rooms";
import { Avatar, Badge, Empty, ErrorNote, PageHeader, duration, time, useAction, useAsync } from "../ui";

export function Sessions({ roomId }: { roomId?: string }) {
  const rooms = useAsync(() => api.rooms(), []);
  const names = useTaskNames();
  const list = rooms.data?.rooms ?? [];
  const active = roomId ?? list.find((r) => r.message_count > 0)?.id ?? list[0]?.id;

  return (
    <div className="split">
      <aside className="list-pane">
        <div className="list-head">
          <h2>Rooms</h2>
        </div>
        <ErrorNote error={rooms.error} />
        {list.map((r) => (
          <a key={r.id} href={href("sessions", r.id)} className={r.id === active ? "list-item active" : "list-item"}>
            <div className="list-item-title">{(r.kind === "solo" ? "@" : "") + roomLabel(r, names)}</div>
            <div className="muted small">
              {r.id.startsWith("task-") ? "task room" : `${r.kind} · ${r.participants.length} participants`}
            </div>
          </a>
        ))}
      </aside>
      <section className="detail-pane">{active ? <RoomSessions
            key={active}
            roomId={active}
            label={(() => {
              const r = list.find((x) => x.id === active);
              return r ? (r.kind === "solo" ? "@" : "") + roomLabel(r, names) : active;
            })()}
          /> : <Empty>No rooms.</Empty>}</section>
    </div>
  );
}

function RoomSessions({ roomId, label }: { roomId: string; label: string }) {
  const sessions = useAsync(() => api.runtimeSessions(roomId), [roomId]);
  const action = useAction();
  useRefreshOn((e) => e.type.startsWith("runtime.") || e.type === "conversation.turn.completed", sessions.reload, [roomId]);
  const items = sessions.data?.sessions ?? [];
  const open = items.filter((s) => s.ended_at == null);

  return (
    <div className="page">
      <PageHeader
        title={label}
        sub="Runtime sessions in this room. A session lives across turns for one room and persona. It rotates when its context budget fills and is discarded on failure; history stays in SQLite."
      >
        <a className="button ghost" href={href("rooms", roomId)}>
          Open room
        </a>
      </PageHeader>
      <ErrorNote error={sessions.error || action.error} />
      <div className="facts">
        <div className="fact">
          <div className="fact-label">Live</div>
          <div className="fact-value">{open.length}</div>
        </div>
        <div className="fact">
          <div className="fact-label">Total epochs</div>
          <div className="fact-value">{items.length}</div>
        </div>
        <div className="fact">
          <div className="fact-label">Rotations</div>
          <div className="fact-value">{items.filter((s) => s.rotation).length}</div>
        </div>
      </div>
      {sessions.data && items.length === 0 ? (
        <Empty>No runtime has started in this room yet. Sending a message starts one per persona.</Empty>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Runtime</th>
                <th>Status</th>
                <th>Started</th>
                <th>Lifetime</th>
                <th>End reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="inline">
                      <Avatar name={s.persona_id} /> {s.persona_id}
                    </span>
                  </td>
                  <td>
                    <Badge value={s.runtime} tone="muted" />
                  </td>
                  <td>{s.ended_at == null ? <Badge value="open" /> : s.rotation ? <Badge value="rotated" tone="info" /> : <Badge value="ended" tone="muted" />}</td>
                  <td>{time(s.started_at)}</td>
                  <td>{duration(s.started_at, s.ended_at)}</td>
                  <td className="mono small">{s.end_reason ?? "—"}</td>
                  <td className="right">
                    {s.ended_at == null && (
                      <button
                        className="ghost small"
                        disabled={action.busy}
                        title="Stop this session so the next prompt starts fresh"
                        onClick={() => action.run(() => api.rotate(s.agent_instance_id))}
                      >
                        Rotate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
