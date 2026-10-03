// Pure formatting for agent self-scheduled wakeups (room schedules).
import type { RoomSchedule } from "./api";

export const TERMINAL_SCHEDULE_STATES: RoomSchedule["state"][] = ["completed", "cancelled", "failed"];

export const isPending = (s: Pick<RoomSchedule, "state">) => !TERMINAL_SCHEDULE_STATES.includes(s.state);

/** Short duration for a repeat interval: `45s`, `1m 30s`, `1h`, `7d`. */
export function humanDuration(seconds: number) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const extra = seconds % 60;
    return `${Math.floor(seconds / 60)}m${extra ? ` ${extra}s` : ""}`;
  }
  if (seconds < 86400) {
    const extra = seconds % 3600;
    return `${Math.floor(seconds / 3600)}h${extra >= 60 ? ` ${Math.floor(extra / 60)}m` : ""}`;
  }
  const extra = seconds % 86400;
  return `${Math.floor(seconds / 86400)}d${extra >= 3600 ? ` ${Math.floor(extra / 3600)}h` : ""}`;
}

/** When a pending wakeup fires, relative to `now` (seconds): `in 4m`, `due now`, `1m overdue`. */
export function relativeDue(dueAt: number, now: number) {
  const delta = Math.round(dueAt - now);
  if (Math.abs(delta) < 5) return "due now";
  // Round to the leading unit so a countdown does not churn every second.
  const coarse = (s: number) => humanDuration(s).split(" ")[0];
  return delta > 0 ? `in ${coarse(delta)}` : `${coarse(-delta)} overdue`;
}

/** `Once`, `Every 1h`, `Every 15m · 3 of 10`, `Every 1d · fired 4`. */
export function recurrence(s: Pick<RoomSchedule, "repeat_seconds" | "repeat_count" | "fires">) {
  if (s.repeat_seconds == null) return "Once";
  const every = `Every ${humanDuration(s.repeat_seconds)}`;
  if (s.repeat_count != null) return `${every} · ${s.fires} of ${s.repeat_count}`;
  return s.fires > 0 ? `${every} · fired ${s.fires}` : `${every} · until cancelled`;
}

/** Upcoming first by due time, then everything finished, newest first. */
export function sortSchedules<T extends Pick<RoomSchedule, "state" | "due_at" | "created_at">>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const pa = isPending(a);
    const pb = isPending(b);
    if (pa !== pb) return pa ? -1 : 1;
    return pa ? a.due_at - b.due_at : b.due_at - a.due_at || b.created_at - a.created_at;
  });
}

export type ParsedWakeup = {
  id: string;
  intent?: string;
  reminder?: string;
  note?: string;
};

/** Parse an internal wakeup message body into its structured components, or null if not a wakeup. */
export function parseWakeupMessage(content: string): ParsedWakeup | null {
  if (!content.startsWith("[Hivemind wakeup ")) return null;
  const match = content.match(/^\[Hivemind wakeup ([^:]+):/);
  const id = match ? match[1] : "";
  const intentMatch = content.match(/^Intent:\s*(.+)$/m);
  const reminderMatch = content.match(/^Reminder:\s*(.+)$/m);
  const noteMatch = content.match(/^Note:\s*(.+)$/m);
  return {
    id,
    intent: intentMatch?.[1]?.trim(),
    reminder: reminderMatch?.[1]?.trim(),
    note: noteMatch?.[1]?.trim(),
  };
}
