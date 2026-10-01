// Rooms: room list, paged history, threads, and live replies over the WebSocket.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, decodeInstance, targetFor, type Message, type Room, type Thread } from "../api";
import { useLive, useLiveStatus, useRefreshOn, type LiveEvent } from "../live";
import { href, navigate } from "../nav";
import { listKind, roomLabel, useTaskNames } from "../rooms";
import { RoomPanel, type PanelTab } from "./RoomPanel";
import { Markdown } from "../markdown";
import { Avatar, Badge, Empty, ErrorNote, time, useAsync } from "../ui";

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
            <button className="ghost" aria-expanded={panelTab !== null} onClick={() => setPanelTab(panelTab ? null : "details")}>
              {panelTab ? "Hide panel" : "Room panel"}
            </button>
            {roomId.startsWith("task-") && (
              <a className="button ghost" href={href("tasks", roomId.slice(5))}>
                Open task
              </a>
            )}
            <button className="ghost" onClick={() => navigate("sessions", roomId)}>
              Runtime sessions
            </button>
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
        />
        {target ? (
          <Composer
            placeholder={`Message ${info?.kind === "solo" ? "@" + info.participants[0]?.persona_id : info?.name ?? roomId}`}
            onSend={(text) => api.sendTurn(target, text).then(() => history.loadLatest())}
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
}) {
  const end = useRef<HTMLDivElement>(null);
  const typingCount = Object.keys(props.typing).length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [props.messages.length, typingCount]);

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
              {m.reply_to && (
                <div className="msg-reply-to muted">
                  ↳ replying to {[m.reply_to.speaker, ...(m.also_saw ?? [])].map((n) => (n === "user" ? "You" : n)).join(", ")}
                </div>
              )}
              <div className="msg-text">{m.speaker === "user" ? m.content : <Markdown text={m.content} />}</div>
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
      {Object.values(props.typing).map((t) => (
        <div key={t.persona} className="msg typing">
          <Avatar name={t.persona} />
          <div className="msg-body">
            <div className="msg-meta">
              <strong>{t.persona}</strong>
            </div>
            <div className="msg-text">
              {t.text ? <Markdown text={t.text} /> : (
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

function Composer({ onSend, placeholder }: { onSend: (text: string) => Promise<unknown>; placeholder: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSend(value);
      setText("");
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
      <div className="composer-row">
        <textarea
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      <div className="hint">Enter to send · Shift+Enter for a new line · replies run in the background</div>
    </div>
  );
}

function ThreadPanel({ thread, anchor, onClose }: { thread: Thread; anchor?: Message; onClose: () => void }) {
  const history = useHistory(thread.id);
  const typing = useTyping(thread.id);
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
          <div className="msg-text">{anchor.speaker === "user" ? anchor.content : <Markdown text={anchor.content} />}</div>
        </div>
      )}
      <MessageList
        messages={history.messages}
        loaded={history.loaded}
        hasEarlier={!!history.before}
        onEarlier={history.loadEarlier}
        typing={typing}
        error={history.error}
      />
      <Composer
        placeholder="Reply in thread"
        onSend={(text) => api.sendTurn({ type: "thread", id: thread.id }, text).then(() => history.loadLatest())}
      />
    </aside>
  );
}
