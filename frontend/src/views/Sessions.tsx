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
    <div class="split">
      <aside class="list-pane">
        <div class="list-head">
          <h2>Rooms</h2>
        </div>
        <ErrorNote error={rooms.error} />
        {list.map((r) => (
          <a key={r.id} href={href("sessions", r.id)} class={r.id === active ? "list-item active" : "list-item"}>
            <div class="list-item-title">{(r.kind === "solo" ? "@" : "") + roomLabel(r, names)}</div>
            <div class="muted small">
              {r.id.startsWith("task-") ? "task room" : `${r.kind} · ${r.participants.length} participants`}
            </div>
          </a>
        ))}
      </aside>
      <section class="detail-pane">{active ? <RoomSessions
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
    <div class="page">
      <PageHeader
        title={label}
        sub="Runtime sessions in this room. A session lives across turns for one room and persona. It rotates when its context budget fills and is discarded on failure; history stays in SQLite."
      >
        <a class="button ghost" href={href("rooms", roomId)}>
          Open room
        </a>
      </PageHeader>
      <ErrorNote error={sessions.error || action.error} />
      <div class="facts">
        <div class="fact">
          <div class="fact-label">Live</div>
          <div class="fact-value">{open.length}</div>
        </div>
        <div class="fact">
          <div class="fact-label">Total epochs</div>
          <div class="fact-value">{items.length}</div>
        </div>
        <div class="fact">
          <div class="fact-label">Rotations</div>
          <div class="fact-value">{items.filter((s) => s.rotation).length}</div>
        </div>
      </div>
      {sessions.data && items.length === 0 ? (
        <Empty>No runtime has started in this room yet. Sending a message starts one per persona.</Empty>
      ) : (
        <div class="card">
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
                    <span class="inline">
                      <Avatar name={s.persona_id} /> {s.persona_id}
                    </span>
                  </td>
                  <td>
                    <Badge value={s.runtime} tone="muted" />
                  </td>
                  <td>{s.ended_at == null ? <Badge value="open" /> : s.rotation ? <Badge value="rotated" tone="info" /> : <Badge value="ended" tone="muted" />}</td>
                  <td>{time(s.started_at)}</td>
                  <td>{duration(s.started_at, s.ended_at)}</td>
                  <td class="mono small">{s.end_reason ?? "—"}</td>
                  <td class="right">
                    {s.ended_at == null && (
                      <button
                        class="ghost small"
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
