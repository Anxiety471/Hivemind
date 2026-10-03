// Agent self-scheduled wakeups as Linear-style rows, shared by the room panel,
// the room header chip, and the Schedules page.
import { useEffect, useState } from "react";
import { api, type Room, type RoomSchedule } from "./api";
import { Icon } from "./icons";
import { useRefreshOn } from "./live";
import { href } from "./nav";
import { isPending, recurrence, relativeDue, sortSchedules } from "./scheduleFormat";
import { ErrorNote, useAction, useAsync } from "./ui";

/** Only these rooms can hold chat schedules (task-room wakeups ride the coordination queue). */
export const hasSchedules = (room: Pick<Room, "id" | "kind">) => ["main", "solo", "group"].includes(room.kind) && !room.id.startsWith("task-");

/** Seconds since the epoch, ticking every `ms` so countdowns stay current. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

const STATE_DOT: Record<RoomSchedule["state"], string> = {
  queued: "st-review",
  dispatched: "st-progress",
  completed: "st-done",
  cancelled: "st-idle",
  failed: "st-attention",
};

// A cancel in one view (room panel) must update the others (header chip, Schedules page).
const changeListeners = new Set<() => void>();
const notifySchedulesChanged = () => changeListeners.forEach((fn) => fn());

/** A turn scheduling or firing a wakeup is the only server signal, so refresh on turns, on local changes, and on a timer. */
export function useScheduleRefresh(reload: () => unknown, deps: unknown[]) {
  useRefreshOn((e) => e.type.startsWith("wakeup") || e.type.startsWith("conversation.turn"), () => void reload(), deps);
  useEffect(() => {
    const fn = () => void reload();
    changeListeners.add(fn);
    const timer = window.setInterval(fn, 30_000);
    return () => {
      changeListeners.delete(fn);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useRoomSchedules(roomId: string, enabled = true) {
  const schedules = useAsync(() => (enabled ? api.roomSchedules(roomId) : Promise.resolve({ room_id: roomId, schedules: [] })), [roomId, enabled]);
  useScheduleRefresh(schedules.reload, [schedules.reload]);
  return schedules;
}

export function ScheduleRow({
  roomId,
  schedule,
  now,
  onChanged,
  room,
}: {
  roomId: string;
  schedule: RoomSchedule;
  now: number;
  onChanged: () => void;
  /** Shown on the Schedules page, where rows from many rooms mix. */
  room?: { label: string; icon: Parameters<typeof Icon>[0]["name"] };
}) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const pending = isPending(schedule);
  const due = new Date(schedule.due_at * 1000).toLocaleString();
  return (
    <li className="schedule-row" data-state={schedule.state} data-open={open}>
      <span className={`state-dot ${STATE_DOT[schedule.state]}`} title={schedule.state} />
      <div className="schedule-main">
        <div className="schedule-line">
          <strong className="schedule-label">{schedule.label || "Wakeup"}</strong>
          {room && (
            <a className="chip schedule-room" href={href("rooms", roomId)} title="Open room">
              <Icon name={room.icon} size={12} /> {room.label}
            </a>
          )}
          <span className="chip" title={schedule.repeat_seconds ? "Recurring" : "One-off"}>
            <Icon name={schedule.repeat_seconds ? "repeat" : "clock"} size={12} /> {recurrence(schedule)}
          </span>
        </div>
        <button type="button" className="schedule-message" aria-expanded={open} title={open ? "Collapse" : "Show the whole message"} onClick={() => setOpen(!open)}>
          {schedule.message}
        </button>
        <ErrorNote error={action.error} />
      </div>
      <div className="schedule-side">
        {pending ? (
          <span className="schedule-due" title={`Next fire ${due}`}>
            {relativeDue(schedule.due_at, now)}
          </span>
        ) : (
          <span className="muted small cap" title={`Last due ${due}`}>
            {schedule.state}
          </span>
        )}
        {pending && (
          <button
            className="ghost small"
            disabled={action.busy}
            aria-label={`Cancel ${schedule.label || "wakeup"}`}
            onClick={() => action.run(() => api.cancelRoomSchedule(roomId, schedule.id).then(() => (onChanged(), notifySchedulesChanged())))}
          >
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

/** The schedules of one room: pending ones listed, finished ones folded away. */
export function RoomSchedules({ roomId }: { roomId: string }) {
  const schedules = useRoomSchedules(roomId);
  const now = useNow();
  const [showPast, setShowPast] = useState(false);
  const list = sortSchedules(schedules.data?.schedules ?? []);
  const pending = list.filter(isPending);
  const past = list.filter((s) => !isPending(s));
  return (
    <div className="schedule-list">
      <ErrorNote error={schedules.error} />
      {schedules.data && pending.length === 0 && <p className="muted small">No pending wakeups. Agents schedule them with wakeup.schedule.</p>}
      {pending.length > 0 && (
        <ul className="schedule-rows">
          {pending.map((s) => (
            <ScheduleRow key={s.id} roomId={roomId} schedule={s} now={now} onChanged={schedules.reload} />
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <>
          <button type="button" className="link-btn small" aria-expanded={showPast} onClick={() => setShowPast(!showPast)}>
            <span className="chev" data-open={showPast}>
              <Icon name="chevron" size={10} />
            </span>
            {showPast ? "Hide" : "Show"} {past.length} past
          </button>
          {showPast && (
            <ul className="schedule-rows">
              {past.map((s) => (
                <ScheduleRow key={s.id} roomId={roomId} schedule={s} now={now} onChanged={schedules.reload} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
