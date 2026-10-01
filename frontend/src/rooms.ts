// Room naming shared by the chat and sessions views.
import { useMemo } from "preact/hooks";
import { api, type Room } from "./api";
import { useAsync } from "./ui";

/** Task rooms (`task-<id>`) come back as archived; list them separately, named after their task. */
export const listKind = (room: Room) => (room.id.startsWith("task-") ? "task" : room.kind);

export function roomLabel(room: Room, tasks: Map<string, string>) {
  if (room.kind === "solo") return room.participants[0]?.persona_id ?? room.id;
  if (room.id.startsWith("task-")) return tasks.get(room.id.slice(5)) ?? room.id;
  return room.name || room.id;
}

/** Task objectives by id, for naming task rooms. */
export function useTaskNames() {
  const tasks = useAsync(() => api.tasks(true), []);
  return useMemo(() => new Map((tasks.data?.tasks ?? []).map((t) => [t.id, t.objective])), [tasks.data]);
}
