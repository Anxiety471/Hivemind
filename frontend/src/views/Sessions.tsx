// Runtime sessions (epochs) per room, with rotation of live sessions.
import { api } from "../api";
import { Icon } from "../icons";
import { useRefreshOn } from "../live";
import { href } from "../nav";
import { RoomList, roomIcon } from "../RoomList";
import { roomLabel, useTaskNames } from "../rooms";
import { Avatar, Badge, Empty, ErrorNote, TopBar, duration, time, useAction, useAsync } from "../ui";

export function Sessions({ roomId }: { roomId?: string }) {
  const rooms = useAsync(() => api.rooms(), []);
  const names = useTaskNames();
  const list = rooms.data?.rooms ?? [];
  const active = roomId ?? list.find((r) => r.message_count > 0)?.id ?? list[0]?.id;
  const room = list.find((x) => x.id === active);

  return (
    <div className="chat">
      <RoomList rooms={list} active={active} page="sessions" names={names} error={rooms.error} title="Sessions" counts={false} />
      <section className="view">
        {active ? (
          <RoomSessions key={active} roomId={active} label={room ? roomLabel(room, names) : active} icon={room ? roomIcon(room) : "rooms"} />
        ) : (
          <Empty>No rooms.</Empty>
        )}
      </section>
    </div>
  );
}

function RoomSessions({ roomId, label, icon }: { roomId: string; label: string; icon: ReturnType<typeof roomIcon> }) {
  const sessions = useAsync(() => api.runtimeSessions(roomId), [roomId]);
  const action = useAction();
  useRefreshOn((e) => e.type.startsWith("runtime.") || e.type === "conversation.turn.completed", sessions.reload, [roomId]);
  const items = sessions.data?.sessions ?? [];
  const open = items.filter((s) => s.ended_at == null);

  return (
    <>
      <TopBar
        icon={icon}
        title={label}
        actions={
          <a className="button ghost small" href={href("rooms", roomId)}>
            <Icon name="rooms" size={14} /> Open room
          </a>
        }
      >
        <span className="stat-chips">
          <span className="chip">
            <span className="dot-live" /> {open.length} live
          </span>
          <span className="chip">{items.length} epochs</span>
          <span className="chip">{items.filter((s) => s.rotation).length} rotations</span>
        </span>
      </TopBar>
      <div className="view-body">
        <p className="view-intro muted">
          A runtime session lives across turns for one room and persona. It rotates when its context budget fills and is discarded on failure; history stays
          in SQLite.
        </p>
        <ErrorNote error={sessions.error || action.error} />
        {sessions.data && items.length === 0 ? (
          <Empty>No runtime has started in this room yet. Sending a message starts one per persona.</Empty>
        ) : (
          <div className="rows">
            <div className="rows-head session-grid">
              <span>Persona</span>
              <span>Status</span>
              <span>Started</span>
              <span>Lifetime</span>
              <span>End reason</span>
              <span />
            </div>
            {items.map((s) => (
              <div className="row-item session-grid" key={s.id}>
                <span className="person">
                  <Avatar name={s.persona_id} /> {s.persona_id}
                  <span className="chip">{s.runtime}</span>
                </span>
                <span>{s.ended_at == null ? <Badge value="open" /> : s.rotation ? <Badge value="rotated" tone="info" /> : <Badge value="ended" tone="muted" />}</span>
                <span className="muted">{time(s.started_at)}</span>
                <span className="muted">{duration(s.started_at, s.ended_at)}</span>
                <span className="mono small muted">{s.end_reason ?? "—"}</span>
                <span className="right">
                  {s.ended_at == null && (
                    <button
                      className="ghost small"
                      disabled={action.busy}
                      title="Stop this session so the next prompt starts fresh"
                      onClick={() => action.run(() => api.rotate(s.agent_instance_id))}
                    >
                      <Icon name="sessions" size={13} /> Rotate
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
