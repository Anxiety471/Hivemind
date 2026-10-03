// Small shared UI pieces: data loading, badges, time formatting.
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useLiveStatus } from "./live";

export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    return load()
      .then((value) => {
        setData(value);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  // The socket coming back means the server is reachable again: retry a failed load.
  const live = useLiveStatus();
  useEffect(() => {
    if (live === "open" && error !== null) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  return { data, error, loading, reload, setData };
}

export function time(seconds: number | null | undefined) {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ago(seconds: number | null | undefined) {
  if (!seconds) return "never";
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function duration(start: number, end: number | null) {
  const secs = Math.max(0, (end ?? Date.now() / 1000) - start);
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

const TONES: Record<string, string> = {
  completed: "ok",
  succeeded: "ok",
  approved: "ok",
  idle: "muted",
  open: "ok",
  feature: "info",
  improvement: "ok",
  bug: "warn",
  dismissed: "muted",
  automatic: "info",
  scheduled: "info",
  manual: "muted",
  running: "info",
  working: "info",
  planning: "info",
  reviewing: "info",
  review: "info",
  ready: "info",
  queued: "warn",
  submitted: "muted",
  waiting: "warn",
  needs_input: "warn",
  blocked: "warn",
  paused: "warn",
  failed: "bad",
  cancelled: "muted",
  interrupted: "bad",
  offline: "muted",
};

export function Badge({ value, tone }: { value: string; tone?: string }) {
  return <span className={`badge tone-${tone ?? TONES[value] ?? "muted"}`}>{value.replace(/_/g, " ")}</span>;
}

export function Avatar({ name }: { name: string }) {
  const user = name === "user";
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={user ? undefined : { background: `hsl(${hue} 55% 42%)` }} data-user={user}>
      {user ? "You" : name.slice(0, 2)}
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="error-note">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      <div className="actions">{children}</div>
    </header>
  );
}

export function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <span className="mono">
          {value} / {max}
        </span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct}%` }} data-high={pct > 80} />
      </div>
    </div>
  );
}

/** Wrap an async action so buttons can show a busy state and surface errors. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
