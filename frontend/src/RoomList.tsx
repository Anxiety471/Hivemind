// The room navigator shared by Rooms and Runtime sessions: sections per kind,
// pinned rooms first, Linear-style rows with icons and counts.
import { useMemo, useState } from "react";
import type { Room } from "./api";
import { Icon, type IconName } from "./icons";
import { href } from "./nav";
import { listKind, roomLabel } from "./rooms";
import { ErrorNote } from "./ui";

const KIND_ORDER: Record<string, number> = { main: 0, group: 1, solo: 2, task: 3, archived: 4 };
const KIND_LABEL: Record<string, string> = { main: "Main", group: "Groups", solo: "Direct", task: "Task rooms", archived: "Archived" };
const KIND_ICON: Record<string, IconName> = { main: "hash", group: "group", solo: "at", task: "task", archived: "archive" };

export function RoomList({
  rooms,
  active,
  page,
  names,
  error,
  title = "Rooms",
  counts = true,
}: {
  rooms: Room[];
  active?: string;
  page: string;
  names: Map<string, string>;
  error?: string | null;
  title?: string;
  counts?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set(["archived"]));
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...rooms]
      .filter((r) => !q || roomLabel(r, names).toLowerCase().includes(q))
      .sort(
        (a, b) =>
          (KIND_ORDER[listKind(a)] ?? 9) - (KIND_ORDER[listKind(b)] ?? 9) ||
          Number(b.settings?.pinned ?? false) - Number(a.settings?.pinned ?? false),
      );
    const out: [string, Room[]][] = [];
    for (const room of sorted) {
      const last = out[out.length - 1];
      if (last && last[0] === listKind(room)) last[1].push(room);
      else out.push([listKind(room), [room]]);
    }
    return out;
  }, [rooms, names, filter]);

  return (
    <aside className="room-list">
      <div className="room-list-head">
        <span>{title}</span>
      </div>
      <label className="room-filter">
        <Icon name="search" size={13} />
        <input value={filter} placeholder="Filter" aria-label="Filter rooms" onChange={(e) => setFilter((e.target as HTMLInputElement).value)} />
      </label>
      <ErrorNote error={error ?? null} />
      {grouped.map(([kind, items]) => {
        const shut = closed.has(kind) && !filter;
        return (
          <div key={kind} className="room-group">
            <button
              type="button"
              className="room-group-label"
              aria-expanded={!shut}
              onClick={() =>
                setClosed((prev) => {
                  const next = new Set(prev);
                  if (next.has(kind)) next.delete(kind);
                  else next.add(kind);
                  return next;
                })
              }
            >
              {KIND_LABEL[kind] ?? kind}
              <span className="chev" data-open={!shut}>
                <Icon name="chevron" size={10} />
              </span>
            </button>
            {!shut &&
              items.map((room) => (
                <a key={room.id} href={href(page, room.id)} className={room.id === active ? "room active" : "room"} aria-current={room.id === active ? "page" : undefined}>
                  <span className="room-icon">
                    <Icon name={KIND_ICON[kind] ?? "rooms"} size={14} />
                  </span>
                  <span className="room-name">{roomLabel(room, names)}</span>
                  {room.settings?.pinned && (
                    <span className="room-flag" title="Pinned" aria-label="Pinned">
                      <Icon name="pin" size={12} />
                    </span>
                  )}
                  {room.settings?.muted && (
                    <span className="room-flag" title="Muted" aria-label="Muted">
                      <Icon name="mute" size={12} />
                    </span>
                  )}
                  {counts && room.message_count > 0 && !room.settings?.muted && <span className="count">{room.message_count}</span>}
                </a>
              ))}
          </div>
        );
      })}
    </aside>
  );
}

export function roomIcon(room: Room): IconName {
  return KIND_ICON[listKind(room)] ?? "rooms";
}
