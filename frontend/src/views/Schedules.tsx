// Every wakeup agents scheduled for themselves, across all chat rooms: what is
// coming up next, how it recurs, and what already fired.
import { useState } from "react";
import { api, type Room, type RoomSchedule } from "../api";
import { useTaskNames, roomLabel } from "../rooms";
import { RoomList, roomIcon } from "../RoomList";
import { ScheduleRow, hasSchedules, useNow, useScheduleRefresh } from "../Schedules";
import { isPending, sortSchedules } from "../scheduleFormat";
import { Empty, ErrorNote, Tabs, TopBar, useAsync } from "../ui";

type Scope = "upcoming" | "recurring" | "past";
type Entry = { room: Room; schedule: RoomSchedule };

async function loadAll(): Promise<{ rooms: Room[]; entries: Entry[]; failed: string[] }> {
  const { rooms } = await api.rooms();
  const chat = rooms.filter(hasSchedules);
  const results = await Promise.allSettled(chat.map((r) => api.roomSchedules(r.id)));
  const entries: Entry[] = [];
  const failed: string[] = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled") entries.push(...res.value.schedules.map((schedule) => ({ room: chat[i], schedule })));
    else failed.push(chat[i].id);
  });
  return { rooms: chat, entries, failed };
}

export function SchedulesView({ roomId }: { roomId?: string }) {
  const data = useAsync(loadAll, []);
  useScheduleRefresh(data.reload, [data.reload]);
  const names = useTaskNames();
  const now = useNow();
  const [scope, setScope] = useState<Scope>("upcoming");

  const all = data.data?.entries ?? [];
  const inRoom = all.filter((e) => !roomId || e.room.id === roomId);
  const shown = sortSchedulesBy(
    inRoom.filter((e) =>
      scope === "upcoming" ? isPending(e.schedule) : scope === "recurring" ? isPending(e.schedule) && e.schedule.repeat_seconds != null : !isPending(e.schedule),
    ),
  );
  const pendingCount = all.filter((e) => isPending(e.schedule)).length;
  const nextUp = sortSchedulesBy(all.filter((e) => isPending(e.schedule)))[0];
  const rooms = data.data?.rooms ?? [];
  const label = (r: Room) => roomLabel(r, names);

  return (
    <div className="chat">
      <RoomList rooms={rooms} active={roomId} page="schedules" names={names} title="Schedules" counts={false} />
      <section className="view">
        <TopBar
          icon="clock"
          title={roomId ? `Schedules · ${rooms.find((r) => r.id === roomId) ? label(rooms.find((r) => r.id === roomId)!) : roomId}` : "Schedules"}
          count={data.data ? pendingCount : undefined}
          actions={
            roomId ? (
              <a className="button ghost small" href="#/schedules">
                All rooms
              </a>
            ) : undefined
          }
        >
          <Tabs
            label="Which wakeups"
            value={scope}
            onChange={setScope}
            options={[
              { value: "upcoming", label: "Upcoming" },
              { value: "recurring", label: "Recurring" },
              { value: "past", label: "Past" },
            ]}
          />
        </TopBar>
        <div className="view-body">
          <p className="view-intro muted">
            Agents schedule these for themselves with <code>wakeup.schedule</code>: an intent to act on, a reminder, or a note to carry, once or on a
            repeat. When one is due it arrives in its room as a message from the host.
            {nextUp && !roomId && (
              <>
                {" "}
                Next up: <strong>{nextUp.schedule.label || "a wakeup"}</strong> in {label(nextUp.room)}.
              </>
            )}
          </p>
          <ErrorNote error={data.error} />
          {data.data && data.data.failed.length > 0 && <ErrorNote error={`Could not load schedules for ${data.data.failed.join(", ")}.`} />}
          {data.data && shown.length === 0 ? (
            <Empty>
              {scope === "past" ? "Nothing has fired or been cancelled yet." : "No pending wakeups. Ask an agent to remind you, or to check back on something later."}
            </Empty>
          ) : (
            <ul className="schedule-rows page-rows">
              {shown.map((e) => (
                <ScheduleRow
                  key={e.schedule.id}
                  roomId={e.room.id}
                  schedule={e.schedule}
                  now={now}
                  onChanged={data.reload}
                  room={roomId ? undefined : { label: label(e.room), icon: roomIcon(e.room) }}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function sortSchedulesBy(entries: Entry[]): Entry[] {
  const order = new Map(sortSchedules(entries.map((e) => e.schedule)).map((s, i) => [s.id, i]));
  return [...entries].sort((a, b) => (order.get(a.schedule.id) ?? 0) - (order.get(b.schedule.id) ?? 0));
}
