// Rooms: room list, paged history, threads, and live replies over the WebSocket.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, decodeInstance, targetFor, type Message, type Room, type Thread } from "../api";
import { useLive, useRefreshOn, type LiveEvent } from "../live";
import { href, navigate } from "../nav";
import { listKind, roomLabel, useTaskNames } from "../rooms";
import { Avatar, Badge, Empty, ErrorNote, ago, time, useAsync } from "../ui";

const KIND_ORDER: Record<string, number> = { main: 0, group: 1, solo: 2, task: 3, archived: 4 };
const KIND_LABEL: Record<string, string> = { main: "Main", group: "Groups", solo: "Direct", task: "Task rooms", archived: "Archived" };

export function Chat({ roomId }: { roomId?: string }) {
  const rooms = useAsync(() => api.rooms(), []);
  const taskNames = useTaskNames();
  useRefreshOn((e) => e.type === "conversation.turn.completed" || e.type === "thread.created", rooms.reload, [
    rooms.reload,
  ]);
  const list = rooms.data?.rooms ?? [];
  const active = roomId ?? list[0]?.id;

  const grouped = useMemo(() => {
    const sorted = [...list].sort((a, b) => (KIND_ORDER[listKind(a)] ?? 9) - (KIND_ORDER[listKind(b)] ?? 9));
    const out: [string, Room[]][] = [];
    for (const room of sorted) {
      const last = out[out.length - 1];
      if (last && last[0] === listKind(room)) last[1].push(room);
      else out.push([listKind(room), [room]]);
    }
    return out;
  }, [list]);

  return (
    <div class="chat">
      <aside class="room-list">
        <div class="room-list-head">Rooms</div>
        <ErrorNote error={rooms.error} />
        {grouped.map(([kind, items]) => (
          <div key={kind} class="room-group">
            <div class="room-group-label">{KIND_LABEL[kind] ?? kind}</div>
            {items.map((room) => (
              <a key={room.id} href={href("rooms", room.id)} class={room.id === active ? "room active" : "room"}>
                <span class="room-icon">{room.kind === "main" ? "#" : room.kind === "solo" ? "@" : kind === "task" ? "▸" : "◆"}</span>
                <span class="room-name">{roomLabel(room, taskNames)}</span>
                {room.message_count > 0 && <span class="count">{room.message_count}</span>}
              </a>
            ))}
          </div>
        ))}
      </aside>
      {active ? <RoomView key={active} roomId={active} taskNames={taskNames} /> : <Empty>No rooms yet. Configure personas in hivemind.toml.</Empty>}
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
  useRefreshOn(
    (e) => e.payload?.room_id === roomId && /^(conversation\.turn|agent\.reply)\./.test(e.type),
    loadLatest,
    [roomId],
  );
  return { messages, before, error, loaded, loadEarlier, loadLatest };
}

function RoomView({ roomId, taskNames }: { roomId: string; taskNames: Map<string, string> }) {
  const room = useAsync(() => api.room(roomId), [roomId]);
  const threads = useAsync(() => api.threads(roomId), [roomId]);
  const history = useHistory(roomId);
  const typing = useTyping(roomId);
  const [openThread, setOpenThread] = useState<Thread | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  useRefreshOn(
    (e) =>
      (e.type === "thread.created" && e.payload?.parent_room_id === roomId) ||
      (e.type === "conversation.turn.completed" && e.payload?.room_id?.startsWith("thread-")),
    threads.reload,
    [roomId],
  );
  useRefreshOn((e) => e.type === "conversation.turn.completed" && e.payload?.room_id === roomId, room.reload, [
    roomId,
  ]);

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
    <section class="room-view">
      <div class="conversation">
        <header class="room-header">
          <div>
            <h2>
              {info ? (info.kind === "solo" ? "@" : "") + roomLabel(info, taskNames) : roomId}
              {info?.mode && <Badge value={info.mode} tone="muted" />}
              {info?.kind === "archived" && <Badge value={roomId.startsWith("task-") ? "task room" : "archived"} />}
            </h2>
            <div class="participants">
              {info?.participants.map((p) => (
                <span class="chip" key={p.persona_id}>
                  <Avatar name={p.persona_id} />
                  {p.persona_id}
                  {p.role && <em>{p.role}</em>}
                </span>
              ))}
            </div>
          </div>
          <div class="actions">
            <button class="ghost" onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? "Hide details" : "Room details"}
            </button>
            {roomId.startsWith("task-") && (
              <a class="button ghost" href={href("tasks", roomId.slice(5))}>
                Open task
              </a>
            )}
            <button class="ghost" onClick={() => navigate("sessions", roomId)}>
              Runtime sessions
            </button>
          </div>
        </header>
        {showDetails && info && <RoomDetails room={info} />}
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
            <div class="composer-disabled">
              {roomId.startsWith("task-")
                ? "Agents talk here while they work on a task. It is read-only; steer the task from the Tasks page."
                : "This room is archived and read-only."}
            </div>
          )
        )}
      </div>
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

function RoomDetails({ room }: { room: Room }) {
  const s = room.state;
  return (
    <div class="room-details">
      <div>
        <h4>Goal</h4>
        <p>{s?.goal ?? <span class="muted">No goal set</span>}</p>
      </div>
      <div>
        <h4>Decisions</h4>
        {s?.decisions.length ? <ul>{s.decisions.map((d) => <li>{d}</li>)}</ul> : <p class="muted">None yet</p>}
      </div>
      <div>
        <h4>Open questions</h4>
        {s?.open_questions.length ? (
          <ul>{s.open_questions.map((d) => <li>{d}</li>)}</ul>
        ) : (
          <p class="muted">None</p>
        )}
      </div>
      <div>
        <h4>Summary</h4>
        <p>{room.summary || <span class="muted">No summary yet</span>}</p>
      </div>
      <div class="muted small">
        {room.message_count} messages · updated {ago(room.updated_at)}
      </div>
    </div>
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
    <div class="messages">
      <ErrorNote error={props.error} />
      {props.hasEarlier && (
        <button class="ghost load-earlier" onClick={props.onEarlier}>
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
          <div key={m.id} class={grouped ? "msg grouped" : "msg"} data-user={m.speaker === "user"}>
            {!grouped ? <Avatar name={m.speaker} /> : <span class="avatar-gap" />}
            <div class="msg-body">
              {!grouped && (
                <div class="msg-meta">
                  <strong>{m.speaker === "user" ? "You" : m.speaker}</strong>
                  <span class="muted">{time(m.created_at)}</span>
                </div>
              )}
              <div class="msg-text">{m.content}</div>
              {thread && (
                <button class="thread-link" onClick={() => props.onThread?.(m)}>
                  💬 {thread.message_count} {thread.message_count === 1 ? "reply" : "replies"} · {thread.name}
                </button>
              )}
            </div>
            {props.onThread && !thread && (
              <button class="msg-action" title="Reply in thread" onClick={() => props.onThread?.(m)}>
                Reply in thread
              </button>
            )}
          </div>
        );
      })}
      {Object.values(props.typing).map((t) => (
        <div key={t.persona} class="msg typing">
          <Avatar name={t.persona} />
          <div class="msg-body">
            <div class="msg-meta">
              <strong>{t.persona}</strong>
              <span class="muted">replying</span>
            </div>
            <div class="msg-text">
              {t.text || (
                <span class="dots">
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
    <div class="composer">
      <ErrorNote error={error} />
      <div class="composer-row">
        <textarea
          rows={1}
          value={text}
          placeholder={placeholder}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button class="primary" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      <div class="hint">Enter to send · Shift+Enter for a new line · replies run in the background</div>
    </div>
  );
}

function ThreadPanel({ thread, anchor, onClose }: { thread: Thread; anchor?: Message; onClose: () => void }) {
  const history = useHistory(thread.id);
  const typing = useTyping(thread.id);
  return (
    <aside class="thread-panel">
      <header>
        <div>
          <div class="eyebrow">Thread</div>
          <h3>{thread.name}</h3>
        </div>
        <button class="ghost icon" onClick={onClose} aria-label="Close thread">
          ✕
        </button>
      </header>
      {anchor && (
        <div class="anchor">
          <div class="msg-meta">
            <strong>{anchor.speaker === "user" ? "You" : anchor.speaker}</strong>
            <span class="muted">{time(anchor.created_at)}</span>
          </div>
          <div class="msg-text">{anchor.content}</div>
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
