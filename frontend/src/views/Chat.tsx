import { LinkedText } from "../LinkedText";
// Rooms: room list, paged history, threads, and live replies over the WebSocket.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, decodeInstance, targetFor, type Message, type Participant, type Room, type Skill, type Thread, type LibraryArtifact } from "../api";
import { useLive, useLiveStatus, useRefreshOn, type LiveEvent } from "../live";
import { href } from "../nav";
import { listKind, roomLabel, useTaskNames } from "../rooms";
import { RoomPanel, type PanelTab } from "./RoomPanel";
import { Markdown } from "../markdown";
import { Avatar, Badge, Empty, ErrorNote, time, useAsync } from "../ui";
import { applyMention, filterParticipants, getMentionMatch, type MentionMatch } from "../mentions";
import { SKILL_PREFIX, completions, helpText, parseSlash, skillPrompt, skillsText, toolsText } from "../slash";

const KIND_ORDER: Record<string, number> = { main: 0, group: 1, solo: 2, task: 3, archived: 4 };
const KIND_LABEL: Record<string, string> = { main: "Main", group: "Groups", solo: "Direct", task: "Task rooms", archived: "Archived" };

export function Chat({ roomId }: { roomId?: string }) {
  const rooms = useAsync(() => api.rooms(), []);
  const taskNames = useTaskNames();
  useRefreshOn(
    (e) => e.type === "conversation.turn.completed" || e.type === "thread.created" || e.type === "config.changed",
    rooms.reload,
    [rooms.reload],
  );
  const list = rooms.data?.rooms ?? [];
  const active = roomId ?? list[0]?.id;

  const grouped = useMemo(() => {
    const sorted = [...list].sort(
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
  }, [list]);

  return (
    <div className="chat">
      <aside className="room-list">
        <div className="room-list-head">Rooms</div>
        <ErrorNote error={rooms.error} />
        {grouped.map(([kind, items]) => (
          <div key={kind} className="room-group">
            <div className="room-group-label">{KIND_LABEL[kind] ?? kind}</div>
            {items.map((room) => (
              <a key={room.id} href={href("rooms", room.id)} className={room.id === active ? "room active" : "room"}>
                <span className="room-icon">{room.kind === "main" ? "#" : room.kind === "solo" ? "@" : kind === "task" ? "▸" : "◆"}</span>
                <span className="room-name">{roomLabel(room, taskNames)}</span>
                {room.settings?.pinned && <span className="room-flag" title="Pinned" aria-label="Pinned">📌</span>}
                {room.settings?.muted && <span className="room-flag" title="Muted" aria-label="Muted">🔕</span>}
                {room.message_count > 0 && !room.settings?.muted && <span className="count">{room.message_count}</span>}
              </a>
            ))}
          </div>
        ))}
      </aside>
      {active ? (
        <RoomView key={active} roomId={active} taskNames={taskNames} onRoomsChanged={rooms.reload} />
      ) : (
        !rooms.loading && !rooms.error && <Empty>No rooms yet. Configure personas in hivemind.toml.</Empty>
      )}
    </div>
  );
}

type Typing = Record<string, { persona: string; text: string }>;

/** Track in-flight replies for one room from agent.reply.* and agent.progress frames. */
function useTyping(roomId: string) {
  const [typing, setTyping] = useState<Typing>({});
  useLive(
    (e: LiveEvent) => {
      const p = e.payload ?? {};
      if (p.room_id !== roomId) return;
      const persona = p.agent_id ?? decodeInstance(p.agent_instance_id ?? "")?.persona ?? "agent";
      if (e.type === "agent.reply.started") setTyping((t) => ({ ...t, [persona]: { persona, text: "" } }));
      else if (e.type === "agent.progress" && p.kind === "text")
        setTyping((t) => ({ ...t, [persona]: { persona, text: p.text ?? "" } }));
      else if (e.type === "agent.reply.completed" || e.type === "agent.reply.failed")
        setTyping((t) => {
          const { [persona]: _, ...rest } = t;
          return rest;
        });
      else if (e.type === "conversation.turn.completed") setTyping({});
    },
    [roomId],
  );
  // A dropped socket loses the completion frames, and leaving the room loses the
  // start frames. Ask the server what is running now instead of guessing: the
  // turn itself never depends on this view.
  const live = useLiveStatus();
  useEffect(() => {
    if (live !== "open") {
      setTyping({});
      return;
    }
    let current = true;
    api
      .activeReplies(roomId)
      .then(({ agents }) => {
        if (!current) return;
        setTyping(Object.fromEntries(agents.map((persona) => [persona, { persona, text: "" }])));
      })
      .catch(() => current && setTyping({}));
    return () => {
      current = false;
    };
  }, [live, roomId]);
  return typing;
}

function useHistory(roomId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadLatest = () =>
    api
      .messages(roomId)
      .then((page) => {
        setMessages((old) => {
          // Keep any older pages already loaded; replace the overlapping tail.
          const first = page.messages[0]?.id;
          const keep = first ? old.filter((m) => m.id < first) : old;
          return [...keep, ...page.messages];
        });
        setBefore((b) => b ?? page.next_before);
        setError(null);
        setLoaded(true);
      })
      .catch((e: Error) => setError(e.message));

  const loadEarlier = () =>
    before &&
    api.messages(roomId, before).then((page) => {
      setMessages((old) => [...page.messages, ...old]);
      setBefore(page.next_before);
    });

  useEffect(() => {
    loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);
  // Catch up on anything missed while the socket was down.
  const live = useLiveStatus();
  const wasDown = useRef(false);
  useEffect(() => {
    if (live === "closed") wasDown.current = true;
    else if (live === "open" && wasDown.current) {
      wasDown.current = false;
      loadLatest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  useRefreshOn(
    (e) => e.payload?.room_id === roomId && /^(conversation\.turn|agent\.reply)\./.test(e.type),
    loadLatest,
    [roomId],
  );
  return { messages, before, error, loaded, loadEarlier, loadLatest };
}

type PendingMessage = {
  id: string;
  text: string;
  sentAt: number;
  status: "steer" | "queue";
  targetName?: string;
};

function RoomView({
  roomId,
  taskNames,
  onRoomsChanged,
}: {
  roomId: string;
  taskNames: Map<string, string>;
  onRoomsChanged: () => void;
}) {
  const room = useAsync(() => api.room(roomId), [roomId]);
  const threads = useAsync(() => api.threads(roomId), [roomId]);
  const history = useHistory(roomId);
  const typing = useTyping(roomId);
  const [openThread, setOpenThread] = useState<Thread | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  useEffect(() => {
    if (pending.length === 0) return;
    const historyTexts = new Set(history.messages.filter((m) => m.speaker === "user").map((m) => m.content));
    setPending((old) => old.filter((p) => !historyTexts.has(p.text)));
  }, [history.messages, pending.length]);
  useRefreshOn(
    (e) =>
      (e.type === "thread.created" && e.payload?.parent_room_id === roomId) ||
      (e.type === "conversation.turn.completed" && e.payload?.room_id?.startsWith("thread-")),
    threads.reload,
    [roomId],
  );
  useRefreshOn(
    (e) => (e.type === "conversation.turn.completed" && e.payload?.room_id === roomId) || e.type === "config.changed",
    room.reload,
    [roomId],
  );

  const info = room.data?.room;
  const byAnchor = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const t of threads.data?.threads ?? []) map.set(t.anchor_message_id, t);
    return map;
  }, [threads.data]);
  const target = info ? targetFor(info) : null;

  const startThread = async (message: Message) => {
    const existing = byAnchor.get(message.id);
    if (existing) return setOpenThread(existing);
    const name = message.content.split(/\s+/).slice(0, 6).join(" ");
    const res = await api.createThread(roomId, message.id, name.length > 48 ? name.slice(0, 48) + "…" : name);
    threads.reload();
    setOpenThread(res.thread);
  };

  return (
    <section className="room-view">
      <div className="conversation">
        <header className="room-header">
          <div>
            <h2>
              {info ? (info.kind === "solo" ? "@" : "") + roomLabel(info, taskNames) : roomId}
              {info?.mode && <Badge value={info.mode} tone="muted" />}
              {info?.kind === "archived" && <Badge value={roomId.startsWith("task-") ? "task room" : "archived"} />}
            </h2>
            <div className="participants">
              {info?.participants.map((p) => (
                <span className="chip" key={p.persona_id}>
                  <Avatar name={p.persona_id} />
                  {p.persona_id}
                  {p.role && <em>{p.role}</em>}
                </span>
              ))}
            </div>
          </div>
          <div className="actions">
            <button
              className="ghost"
              aria-expanded={panelTab !== null}
              onClick={() => setPanelTab(panelTab ? null : info && ["main", "solo", "group"].includes(info.kind) ? "settings" : "details")}
            >
              {panelTab ? "Hide settings" : "Settings"}
            </button>
            {roomId.startsWith("task-") && (
              <a className="button ghost" href={href("tasks", roomId.slice(5))}>
                Open task
              </a>
            )}
          </div>
        </header>
        <MessageList
          messages={history.messages}
          loaded={history.loaded}
          hasEarlier={!!history.before}
          onEarlier={history.loadEarlier}
          typing={typing}
          threads={byAnchor}
          onThread={startThread}
          error={history.error}
          pending={pending}
          roomId={roomId}
        />
        {target ? (
          <Composer
            roomId={roomId}
            placeholder={`Message ${info?.kind === "solo" ? "@" + info.participants[0]?.persona_id : info?.name ?? roomId}`}
            participants={info?.participants}
            isReplying={Object.keys(typing).length > 0}
            onSend={async (text, mode) => {
              const tempId = `temp-${Date.now()}`;
              const isSteer = mode === "steer" || (!mode && Object.keys(typing).length > 0);
              const activePersonas = Object.keys(typing);
              if (isSteer) {
                setPending((old) => [
                  ...old,
                  {
                    id: tempId,
                    text,
                    sentAt: Math.floor(Date.now() / 1000),
                    status: "steer",
                    targetName: activePersonas.join(", ") || undefined,
                  },
                ]);
                try {
                  const res = await api.steerRoom(roomId, text);
                  if (res.delivered_to.length > 0) {
                    setPending((old) =>
                      old.map((p) =>
                        p.id === tempId
                          ? { ...p, status: "steer", targetName: res.delivered_to.join(", ") }
                          : p
                      )
                    );
                    setTimeout(() => {
                      setPending((old) => old.filter((p) => p.id !== tempId));
                    }, 8000);
                    return;
                  }
                } catch {
                  // Backend or network fallback
                }
              } else {
                setPending((old) => [
                  ...old,
                  { id: tempId, text, sentAt: Math.floor(Date.now() / 1000), status: "queue" },
                ]);
              }
              return api
                .sendTurn(target, text)
                .then(() => history.loadLatest())
                .catch((err) => {
                  setPending((old) => old.filter((p) => p.id !== tempId));
                  throw err;
                });
            }}
          />
        ) : (
          info && (
            <div className="composer-disabled">
              {roomId.startsWith("task-")
                ? "Agents talk here while they work on a task. It is read-only; steer the task from the Tasks page."
                : "This room is archived and read-only."}
            </div>
          )
        )}
      </div>
      {panelTab && info && !openThread && (
        <RoomPanel
          room={info}
          tab={panelTab}
          onTab={setPanelTab}
          onClose={() => setPanelTab(null)}
          onChanged={() => {
            room.reload();
            onRoomsChanged();
          }}
        />
      )}
      {openThread && (
        <ThreadPanel
          key={openThread.id}
          thread={openThread}
          anchor={history.messages.find((m) => m.id === openThread.anchor_message_id)}
          participants={info?.participants}
          onClose={() => setOpenThread(null)}
        />
      )}
    </section>
  );
}

function MessageList(props: {
  messages: Message[];
  loaded: boolean;
  hasEarlier: boolean;
  onEarlier: () => void;
  typing: Typing;
  threads?: Map<string, Thread>;
  onThread?: (m: Message) => void;
  error: string | null;
  pending?: PendingMessage[];
  roomId?: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  const typingCount = Object.keys(props.typing).length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [props.messages.length, typingCount, props.pending?.length]);

  return (
    <div className="messages">
      <ErrorNote error={props.error} />
      {props.hasEarlier && (
        <button className="ghost load-earlier" onClick={props.onEarlier}>
          Load earlier messages
        </button>
      )}
      {props.loaded && props.messages.length === 0 && typingCount === 0 && (
        <Empty>No messages yet. Say something to start the conversation.</Empty>
      )}
      {props.messages.map((m, i) => {
        const prev = props.messages[i - 1];
        const grouped = prev && prev.speaker === m.speaker && m.created_at - prev.created_at < 120;
        const thread = props.threads?.get(m.id);
        return (
          <div key={m.id} className={grouped ? "msg grouped" : "msg"} data-user={m.speaker === "user"}>
            {!grouped ? <Avatar name={m.speaker} /> : <span className="avatar-gap" />}
            <div className="msg-body">
              {!grouped && (
                <div className="msg-meta">
                  <strong>{m.speaker === "user" ? "You" : m.speaker}</strong>
                  <span className="muted">{time(m.created_at)}</span>
                </div>
              )}
              <div className="msg-text">{m.speaker === "user" ? <LinkedText text={m.content} /> : <Markdown text={m.content} roomId={props.roomId} />}</div>
              {thread && (
                <button className="thread-link" onClick={() => props.onThread?.(m)}>
                  💬 {thread.message_count} {thread.message_count === 1 ? "reply" : "replies"} · {thread.name}
                </button>
              )}
            </div>
            {props.onThread && !thread && (
              <button className="msg-action" title="Reply in thread" onClick={() => props.onThread?.(m)}>
                Reply in thread
              </button>
            )}
          </div>
        );
      })}
      {props.pending?.map((p) => (
        <div key={p.id} className="msg" data-user="true" style={{ opacity: 0.88 }}>
          <Avatar name="user" />
          <div className="msg-body">
            <div className="msg-meta">
              <strong>You</strong>
              <span className="muted">{time(p.sentAt)}</span>
              <span
                className="badge"
                style={{
                  marginLeft: "0.5rem",
                  fontSize: "0.75rem",
                  background: p.status === "steer" ? "var(--accent)" : "var(--accent-subtle)",
                  color: p.status === "steer" ? "var(--bg)" : "var(--accent)",
                }}
              >
                {p.status === "steer"
                  ? `Steer${p.targetName ? ` (${p.targetName})` : ""}`
                  : "Queue"}
              </span>
            </div>
            <div className="msg-text">{p.text}</div>
          </div>
        </div>
      ))}
      {Object.values(props.typing).map((t) => (
        <div key={t.persona} className="msg typing">
          <Avatar name={t.persona} />
          <div className="msg-body">
            <div className="msg-meta">
              <strong>{t.persona}</strong>
            </div>
            <div className="msg-text">
              {t.text ? <Markdown text={t.text} roomId={props.roomId} /> : (
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function Composer({
  roomId,
  onSend,
  placeholder,
  participants = [],
  isReplying = false,
}: {
  roomId?: string;
  onSend: (text: string, mode?: "queue" | "steer") => Promise<unknown>;
  placeholder: string;
  participants?: Participant[];
  isReplying?: boolean;
}) {
  const [attachments, setAttachments] = useState<LibraryArtifact[]>([]);
  const attach = async (files: FileList | null) => {
    if (!files || busy || !roomId) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} exceeds the 8 MiB limit.`);
        const content_base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        const result = await api.createLibraryArtifact({ title: file.name, filename: file.name, description: "Chat attachment", room_id: roomId, content_base64 });
        setAttachments(current => [...current, result.artifact]);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const blurTimeoutRef = useRef<number | null>(null);
  const prevQueryRef = useRef<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [skillCatalog, setSkillCatalog] = useState<{ dirs: string[]; skills: Skill[] } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashItems = useMemo(
    () => (slashDismissed ? [] : completions(text, skillCatalog?.skills ?? [])),
    [text, skillCatalog, slashDismissed],
  );

  const filtered = useMemo(() => {
    if (!mentionMatch || dismissed) return [];
    return filterParticipants(participants, mentionMatch.query);
  }, [participants, mentionMatch, dismissed]);

  useEffect(() => {
    if (mentionMatch?.query !== prevQueryRef.current) {
      setDismissed(false);
      prevQueryRef.current = mentionMatch?.query ?? null;
      setSelectedIndex(0);
    }
  }, [mentionMatch?.query]);

  useEffect(() => {
    if (selectedIndex >= filtered.length && filtered.length > 0) {
      setSelectedIndex(filtered.length - 1);
    }
  }, [filtered.length, selectedIndex]);

  useEffect(() => {
    if (listRef.current && filtered.length > 0) {
      const activeEl = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      activeEl?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, filtered.length]);

  useEffect(() => {
    const row = slashListRef.current?.children[slashIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [slashIndex, slashItems.length]);

  useEffect(() => {
    return () => {
      clearTimeout(blurTimeoutRef.current ?? undefined);
    };
  }, []);

  const insertMention = (participant: Participant) => {
    if (!mentionMatch) return;
    const applied = applyMention(text, cursorPos, mentionMatch, participant.persona_id);
    setText(applied.text);
    setCursorPos(applied.cursor);
    setMentionMatch(null);
    setDismissed(false);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(applied.cursor, applied.cursor);
      }
    });
  };

  const handleTextChange = (val: string, pos: number) => {
    setText(val);
    setCursorPos(pos);
    setMentionMatch(getMentionMatch(val, pos));
    setSlashIndex(0);
    setSlashDismissed(false);
    // `/skill:<name>` rows come from the catalogue, so fetch it the first time a command is typed.
    if (!skillCatalog && val.startsWith("/")) api.skills().then(setSkillCatalog, () => {});
  };

  const acceptSlash = (insert: string) => {
    handleTextChange(insert, insert.length);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(insert.length, insert.length);
    });
  };

  const handleCursorMove = (pos: number) => {
    setCursorPos(pos);
    setMentionMatch(getMentionMatch(text, pos));
  };

  const runCommand = async (name: string, args: string): Promise<{ show?: string; send?: string; mode?: "queue" | "steer" }> => {
    const loadSkills = async (refresh: boolean) => {
      if (refresh || !skillCatalog) {
        const fresh = await api.skills();
        setSkillCatalog(fresh);
        return fresh;
      }
      return skillCatalog;
    };
    if (name.toLowerCase().startsWith(SKILL_PREFIX)) {
      const skill = name.slice(SKILL_PREFIX.length);
      const catalog = await loadSkills(false);
      if (!skill || !catalog.skills.some((s) => s.name === skill)) {
        throw new Error(
          catalog.skills.length === 0
            ? "No skills are configured. Type /skills for how to add them."
            : `Unknown skill "${skill}". Type /skills to list them.`,
        );
      }
      return { send: skillPrompt(skill, args) };
    }
    switch (name.toLowerCase()) {
      case "":
      case "help":
        return { show: helpText() };
      case "skills": {
        const catalog = await loadSkills(true);
        return { show: skillsText(catalog.skills, catalog.dirs) };
      }
      case "tools":
        return { show: toolsText((await api.toolCatalog()).namespaces) };
      case "queue": {
        if (!args.trim()) {
          throw new Error("Usage: /queue <message>");
        }
        return { send: args.trim(), mode: "queue" as const };
      }
      default:
        throw new Error(`Unknown command /${name}. Type /help for the list.`);
    }
  };

  const send = async () => {
    const value = text.trim();
    if ((!value && !attachments.length) || busy) return;
    setBusy(true);
    try {
      const references = attachments.map(a => `Attached artifact: ${a.filename} (library ID: ${a.id}; use library.get to read it)`).join("\n");
      const withAttachments = (msg: string) => [msg, references].filter(Boolean).join("\n\n");
      const parsed = parseSlash(value);
      if (parsed.kind === "command") {
        const result = await runCommand(parsed.name, parsed.args);
        if (result.show !== undefined) setOutput(result.show);
        if (result.send !== undefined) {
          await onSend(withAttachments(result.send), result.mode ?? (isReplying ? "steer" : undefined));
          setOutput(null);
          setAttachments([]);
        }
      } else {
        await onSend(withAttachments(parsed.text), isReplying ? "steer" : undefined);
        setOutput(null);
        setAttachments([]);
      }
      setText("");
      setMentionMatch(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <ErrorNote error={error} />
      {filtered.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label="Mention agent">
          <div className="mention-menu-header">Mention an agent</div>
          <div className="mention-menu-list" ref={listRef}>
            {filtered.map((p, i) => (
              <div
                key={p.persona_id}
                role="option"
                aria-selected={i === selectedIndex}
                className={i === selectedIndex ? "mention-item active" : "mention-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(p);
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <Avatar name={p.persona_id} />
                <div className="mention-item-info">
                  <span className="mention-item-name">{p.persona_id}</span>
                  {p.role && <span className="mention-item-role">{p.role}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {slashItems.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label="Slash commands">
          <div className="mention-menu-header">Commands · Tab completes · Esc closes</div>
          <div className="mention-menu-list" ref={slashListRef}>
            {slashItems.map((item, i) => (
              <div
                key={item.insert}
                role="option"
                aria-selected={i === slashIndex}
                className={i === slashIndex ? "mention-item active" : "mention-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptSlash(item.insert);
                }}
                onMouseEnter={() => setSlashIndex(i)}
              >
                <div className="mention-item-info">
                  <span className="mention-item-name">{item.label}</span>
                  <span className="mention-item-role">{item.detail.length > 90 ? `${item.detail.slice(0, 90)}…` : item.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {output !== null && (
        <div className="slash-output" role="status">
          <button className="ghost icon" onClick={() => setOutput(null)} aria-label="Dismiss command output">
            ✕
          </button>
          <Markdown text={output} />
        </div>
      )}
      <div
        className={`composer-box ${dragging ? "drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          attach(e.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <div className="composer-attachments-bar">
            {attachments.map((a) => (
              <div key={a.id} className="composer-attachment-chip">
                <span className="chip-icon">📎</span>
                <span className="chip-name" title={a.filename}>
                  {a.filename}
                </span>
                <span className="chip-size">{sizeLabel(a.size)}</span>
                <button
                  type="button"
                  className="chip-remove"
                  disabled={busy}
                  aria-label={`Remove ${a.filename} from message`}
                  onClick={() =>
                    setAttachments((current) => current.filter((item) => item.id !== a.id))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={2}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            const el = e.target;
            handleTextChange(el.value, el.selectionStart);
          }}
          onSelect={(e) => handleCursorMove((e.target as HTMLTextAreaElement).selectionStart)}
          onClick={(e) => handleCursorMove((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyUp={(e) => handleCursorMove((e.target as HTMLTextAreaElement).selectionStart)}
          onFocus={(e) => {
            clearTimeout(blurTimeoutRef.current ?? undefined);
            handleCursorMove(e.target.selectionStart);
          }}
          onBlur={() => {
            blurTimeoutRef.current = window.setTimeout(() => setMentionMatch(null), 150);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
              e.preventDefault();
              fileInputRef.current?.click();
              return;
            }
            if (slashItems.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((prev) => (prev + 1) % slashItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((prev) => (prev - 1 + slashItems.length) % slashItems.length);
                return;
              }
              const chosen = slashItems[slashIndex];
              // Enter completes a partial command but runs one that is already complete.
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && chosen && chosen.insert.trim() !== text.trim())) {
                e.preventDefault();
                if (chosen) acceptSlash(chosen.insert);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashDismissed(true);
                return;
              }
            }
            if (filtered.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((prev) => (prev + 1) % filtered.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const chosen = filtered[selectedIndex];
                if (chosen) insertMention(chosen);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-actions-left" ref={menuRef}>
            <button
              type="button"
              className="composer-add-btn"
              data-open={menuOpen}
              aria-label="Add content or tools"
              title="Add content or tools"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              +
            </button>
            {menuOpen && (
              <div className="composer-menu" role="menu">
                <button
                  type="button"
                  className="composer-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="menu-icon">📎</span>
                  <span className="menu-label">Add files or photos</span>
                  <span className="menu-shortcut">Ctrl+U</span>
                </button>
                <a
                  href="#/library"
                  className="composer-menu-item"
                  onClick={() => setMenuOpen(false)}
                >
                  <span className="menu-icon">📚</span>
                  <span className="menu-label">Artifact library</span>
                </a>
                <button
                  type="button"
                  className="composer-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    acceptSlash("/skills");
                  }}
                >
                  <span className="menu-icon">⚡</span>
                  <span className="menu-label">Skills & tools</span>
                  <span className="menu-shortcut">/skills</span>
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              aria-label="Attach files"
              type="file"
              multiple
              disabled={busy}
              style={{ display: "none" }}
              onChange={(e) => {
                attach(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <button
            className="primary"
            disabled={busy || (!text.trim() && !attachments.length)}
            onClick={send}
          >
            {text.trim().toLowerCase().startsWith("/queue")
              ? "Queue"
              : isReplying
              ? "Steer"
              : "Send"}
          </button>
        </div>
      </div>
      <div className="hint">
        {isReplying
          ? "Active reply in progress: Enter steers active reply · /queue <message> queues for next turn"
          : "Enter to send · Shift+Enter for a new line · replies run in the background"}
      </div>
    </div>
  );
}

function ThreadPanel({
  thread,
  anchor,
  participants,
  onClose,
}: {
  thread: Thread;
  anchor?: Message;
  participants?: Participant[];
  onClose: () => void;
}) {
  const history = useHistory(thread.id);
  const typing = useTyping(thread.id);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  useEffect(() => {
    if (pending.length === 0) return;
    const historyTexts = new Set(history.messages.filter((m) => m.speaker === "user").map((m) => m.content));
    setPending((old) => old.filter((p) => !historyTexts.has(p.text)));
  }, [history.messages, pending.length]);
  return (
    <aside className="thread-panel">
      <header>
        <div>
          <div className="eyebrow">Thread</div>
          <h3>{thread.name}</h3>
        </div>
        <button className="ghost icon" onClick={onClose} aria-label="Close thread">
          ✕
        </button>
      </header>
      {anchor && (
        <div className="anchor">
          <div className="msg-meta">
            <strong>{anchor.speaker === "user" ? "You" : anchor.speaker}</strong>
            <span className="muted">{time(anchor.created_at)}</span>
          </div>
          <div className="msg-text">{anchor.speaker === "user" ? <LinkedText text={anchor.content} /> : <Markdown text={anchor.content} roomId={thread.id} />}</div>
        </div>
      )}
      <MessageList
        messages={history.messages}
        loaded={history.loaded}
        hasEarlier={!!history.before}
        onEarlier={history.loadEarlier}
        typing={typing}
        error={history.error}
        pending={pending}
        roomId={thread.id}
      />
      <Composer
        roomId={thread.id}
        placeholder="Reply in thread"
        participants={participants}
        isReplying={Object.keys(typing).length > 0}
        onSend={async (text, mode) => {
          const tempId = `temp-${Date.now()}`;
          const isSteer = mode === "steer" || (!mode && Object.keys(typing).length > 0);
          const activePersonas = Object.keys(typing);
          if (isSteer) {
            setPending((old) => [
              ...old,
              {
                id: tempId,
                text,
                sentAt: Math.floor(Date.now() / 1000),
                status: "steer",
                targetName: activePersonas.join(", ") || undefined,
              },
            ]);
            try {
              const res = await api.steerRoom(thread.id, text);
              if (res.delivered_to.length > 0) {
                setPending((old) =>
                  old.map((p) =>
                    p.id === tempId
                      ? { ...p, status: "steer", targetName: res.delivered_to.join(", ") }
                      : p
                  )
                );
                setTimeout(() => {
                  setPending((old) => old.filter((p) => p.id !== tempId));
                }, 8000);
                return;
              }
            } catch {
              // Backend fallback
            }
          } else {
            setPending((old) => [
              ...old,
              { id: tempId, text, sentAt: Math.floor(Date.now() / 1000), status: "queue" },
            ]);
          }
          return api
            .sendTurn({ type: "thread", id: thread.id }, text)
            .then(() => history.loadLatest())
            .catch((err) => {
              setPending((old) => old.filter((p) => p.id !== tempId));
              throw err;
            });
        }}
      />
    </aside>
  );
}
