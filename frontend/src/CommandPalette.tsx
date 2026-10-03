// ⌘K / Ctrl+K command palette plus the global keyboard shortcuts (C, G then a key, ?).
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Icon, StatusIcon, type IconName } from "./icons";
import { issueKey } from "./issues";
import { href, navigate, requestNewIssue } from "./nav";
import { roomLabel } from "./rooms";
import { applyTheme, effectiveTheme } from "./theme";
import { Avatar, Kbd } from "./ui";
import type { ReactNode } from "react";

export type PageLink = { page: string; label: string; icon: IconName; key?: string };

/** Pages reachable with `G` then the key. */
export const GO_KEYS: PageLink[] = [
  { page: "issues", label: "Issues", icon: "issues", key: "i" },
  { page: "rooms", label: "Rooms", icon: "rooms", key: "r" },
  { page: "library", label: "Library", icon: "library", key: "l" },
  { page: "agents", label: "Agents", icon: "agents", key: "a" },
  { page: "groups", label: "Groups", icon: "groups", key: "g" },
  { page: "workspaces", label: "Workspaces", icon: "workspaces", key: "w" },
  { page: "sessions", label: "Runtime sessions", icon: "sessions", key: "s" },
  { page: "activity", label: "Live activity", icon: "activity", key: "v" },
  { page: "settings", label: "Settings", icon: "settings", key: "," },
  { page: "setup", label: "Setup guide", icon: "setup" },
];

type Item = { id: string; group: string; label: string; hint?: string; icon: ReactNode; keywords?: string; run: () => void };

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable=true], [role=dialog]");

/** Mounts once in the shell: owns the palette, the shortcut sheet, and global keys. */
export function CommandLayer({ paletteOpen, setPaletteOpen }: { paletteOpen: boolean; setPaletteOpen: (open: boolean) => void }) {
  const [help, setHelp] = useState(false);
  useEffect(() => {
    let go = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || paletteOpen) return;
      if (go && Date.now() - go < 1200) {
        go = 0;
        const target = GO_KEYS.find((p) => p.key === e.key.toLowerCase());
        if (target) {
          e.preventDefault();
          navigate(target.page);
        }
        return;
      }
      if (e.key === "g") go = Date.now();
      else if (e.key === "c") {
        e.preventDefault();
        requestNewIssue();
      } else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "Escape") setHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPaletteOpen]);
  return (
    <>
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      {help && <ShortcutSheet onClose={() => setHelp(false)} />}
    </>
  );
}

function usePaletteData() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let live = true;
    Promise.allSettled([api.allTasks(400), api.rooms(), api.agents()]).then(([tasks, rooms, agents]) => {
      if (!live) return;
      const out: Item[] = [];
      const names = new Map<string, string>();
      if (tasks.status === "fulfilled") {
        for (const t of tasks.value) {
          names.set(t.id, t.objective);
          out.push({
            id: `issue:${t.id}`,
            group: "Issues",
            label: t.objective.split("\n")[0],
            hint: issueKey(t.id),
            keywords: `${issueKey(t.id)} ${t.owner ?? ""}`,
            icon: <StatusIcon status={t.status} />,
            run: () => navigate("issues", t.id),
          });
        }
      }
      if (rooms.status === "fulfilled") {
        for (const r of rooms.value.rooms) {
          if (r.id.startsWith("task-")) continue;
          out.push({
            id: `room:${r.id}`,
            group: "Rooms",
            label: (r.kind === "solo" ? "@" : "") + roomLabel(r, names),
            hint: r.kind,
            icon: <Icon name="rooms" />,
            run: () => navigate("rooms", r.id),
          });
        }
      }
      if (agents.status === "fulfilled") {
        for (const a of agents.value.agents) {
          out.push({
            id: `agent:${a.name}`,
            group: "Agents",
            label: `Message ${a.name}`,
            hint: a.runtime,
            keywords: a.name,
            icon: <Avatar name={a.name} />,
            run: () => navigate("rooms", `solo-${a.name}`),
          });
        }
      }
      setItems(out);
    });
    return () => {
      live = false;
    };
  }, []);
  return items;
}

function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const data = usePaletteData();
  const actions: Item[] = useMemo(() => {
    const dark = effectiveTheme() === "dark";
    return [
      { id: "new-issue", group: "Actions", label: "Create new issue", hint: "C", icon: <Icon name="plus" />, run: requestNewIssue },
      { id: "new-agent", group: "Actions", label: "Create new agent", icon: <Icon name="agents" />, run: () => (location.hash = "#/agents/new") },
      { id: "new-group", group: "Actions", label: "Create new group", icon: <Icon name="groups" />, run: () => (location.hash = "#/groups/new") },
      {
        id: "theme",
        group: "Actions",
        label: dark ? "Switch to light theme" : "Switch to dark theme",
        icon: <Icon name="theme" />,
        keywords: "appearance dark light mode",
        run: () => applyTheme(dark ? "light" : "dark"),
      },
      ...GO_KEYS.map((p) => ({
        id: `go:${p.page}`,
        group: "Navigation",
        label: `Go to ${p.label}`,
        hint: p.key ? `G ${p.key.toUpperCase()}` : undefined,
        icon: <Icon name={p.icon} />,
        run: () => navigate(p.page),
      })),
    ];
  }, []);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = [...actions, ...data];
  const shown = all
    .filter((item) => {
      const text = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""} ${item.group}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    // Without a query, keep the list short: actions and navigation first.
    .slice(0, query ? 60 : 24);
  const current = Math.min(index, Math.max(0, shown.length - 1));

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = "";
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Command menu">
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            placeholder="Type a command or search…"
            aria-label="Search commands"
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((current + 1) % Math.max(1, shown.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((current - 1 + shown.length) % Math.max(1, shown.length));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[current]);
              } else if (e.key === "Escape") onClose();
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label="Results">
          {shown.length === 0 && <div className="palette-empty muted">No results for “{query}”</div>}
          {shown.map((item, i) => {
            const heading = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {heading && <div className="palette-group">{heading}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === current}
                  data-index={i}
                  className={i === current ? "palette-item active" : "palette-item"}
                  onMouseMove={() => i !== current && setIndex(i)}
                  onClick={() => run(item)}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const rows: [string, ReactNode][] = [
    ["Command menu", <><Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd> <Kbd>K</Kbd></>],
    ["Create issue", <Kbd>C</Kbd>],
    ["Show shortcuts", <Kbd>?</Kbd>],
    ...GO_KEYS.filter((p) => p.key).map((p): [string, ReactNode] => [`Go to ${p.label}`, <><Kbd>G</Kbd> <Kbd>{p.key!.toUpperCase()}</Kbd></>]),
    ["Send message", <Kbd>Enter</Kbd>],
    ["Create issue from modal", <><Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd></>],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <header className="modal-head">
          <span className="modal-title">Keyboard shortcuts</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose} autoFocus>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body">
          {rows.map(([label, keys]) => (
            <div className="shortcut-row" key={label}>
              <span>{label}</span>
              <span className="shortcut-keys">{keys}</span>
            </div>
          ))}
          <a className="muted small" href={href("settings")} onClick={onClose}>
            Appearance and connection settings →
          </a>
        </div>
      </div>
    </div>
  );
}
