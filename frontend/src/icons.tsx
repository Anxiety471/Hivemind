// Line icons for the shell and Linear-style status glyphs for issues.
import type { ReactNode } from "react";
import type { TaskStatus } from "./api";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      {children}
    </svg>
  );
}

const PATHS: Record<string, ReactNode> = {
  issues: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </>
  ),
  rooms: <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5V11h0a2 2 0 0 1-1.5-2z" />,
  library: (
    <>
      <path d="M3 2.5h3v11H3zM7 2.5h3v11H7z" />
      <path d="m11 3 2.5-.5 1 10.5-2.5.5z" />
    </>
  ),
  agents: (
    <>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 5V2.5M6 9h0M10 9h0" />
    </>
  ),
  groups: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="11.2" cy="6.8" r="1.7" />
      <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5M10.5 10c1.6 0 3 .9 3.5 3" />
    </>
  ),
  workspaces: <path d="M2 4.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />,
  sessions: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  activity: <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />,
  setup: <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4z" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  chevron: <path d="m6 4 4 4-4 4" />,
  list: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  board: (
    <>
      <rect x="2" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="6.25" y="2.5" width="3.5" height="7" rx="1" />
      <rect x="10.5" y="2.5" width="3.5" height="9" rx="1" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  subissue: (
    <>
      <path d="M4 2.5v6a2 2 0 0 0 2 2h4" />
      <path d="m8.5 8.5 2 2-2 2" />
    </>
  ),
  room: <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5V11h0a2 2 0 0 1-1.5-2z" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  play: <path d="m5 3 8 5-8 5z" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  repeat: (
    <>
      <path d="M3 7a4 4 0 0 1 6.8-2.8L11.5 6" />
      <path d="M11.5 3v3h-3M13 9a4 4 0 0 1-6.8 2.8L4.5 10" />
      <path d="M4.5 13v-3h3" />
    </>
  ),
  theme: <path d="M8 2a6 6 0 1 0 6 6A4.5 4.5 0 0 1 8 2z" />,
  hash: <path d="M6 2.5 5 13.5M11 2.5l-1 11M3 6h10.5M2.5 10H13" />,
  at: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 8v1a2 2 0 0 0 3.5 0V8a6 6 0 1 0-2.5 4.9" />
    </>
  ),
  group: <path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z" />,
  task: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m5.6 8.2 1.6 1.6 3.2-3.4" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" />
    </>
  ),
  pin: <path d="M9.5 2 14 6.5l-2 .5-2.5 2.5.5 3-1 1L6.5 11 3 14.5M6.5 11 2 9.5l1-1 3 .5L8.5 6.5 9 4.5z" />,
  mute: (
    <>
      <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5z" />
      <path d="m11 6 3.5 4M14.5 6 11 10" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".9" fill="currentColor" />
    </>
  ),
  edit: <path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />,
  link: <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.6.6M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.6-.6" />,
  file: (
    <>
      <path d="M4 1.5h5L12.5 5v9.5h-8.5z" />
      <path d="M9 1.5V5h3.5" />
    </>
  ),
  up: <path d="m4 10 4-4 4 4" />,
  down: <path d="m4 6 4 4 4-4" />,
  cancel: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m4.2 4.2 7.6 7.6" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return <Svg size={size}>{PATHS[name]}</Svg>;
}

/** The hive mark: a small hexagon. */
export function Logo() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.2 14 4.6v6.8L8 14.8 2 11.4V4.6z" fill="currentColor" />
    </svg>
  );
}

/** Linear-style status glyph: dashed backlog, empty todo, pie-filled progress, check, cross. */
export function StatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  const r = 5.5;
  const c = 7;
  const pie = (fraction: number) => {
    if (fraction <= 0) return null;
    const angle = fraction * 2 * Math.PI;
    const x = c + 3 * Math.sin(angle);
    const y = c - 3 * Math.cos(angle);
    return <path d={`M${c} ${c} L${c} ${c - 3} A3 3 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`} fill="currentColor" />;
  };
  let body: ReactNode;
  switch (status) {
    case "submitted":
      body = <circle cx={c} cy={c} r={r} strokeDasharray="1.6 1.6" />;
      break;
    case "planning":
      body = (
        <>
          <circle cx={c} cy={c} r={r} />
          {pie(0.15)}
        </>
      );
      break;
    case "ready":
      body = <circle cx={c} cy={c} r={r} />;
      break;
    case "running":
      body = (
        <>
          <circle cx={c} cy={c} r={r} />
          {pie(0.5)}
        </>
      );
      break;
    case "review":
      body = (
        <>
          <circle cx={c} cy={c} r={r} />
          {pie(0.75)}
        </>
      );
      break;
    case "completed":
      body = (
        <>
          <circle cx={c} cy={c} r={6} fill="currentColor" stroke="none" />
          <path d="m4.6 7.2 1.7 1.7 3.2-3.4" stroke="var(--panel)" strokeWidth="1.5" />
        </>
      );
      break;
    case "cancelled":
    case "failed":
      body = (
        <>
          <circle cx={c} cy={c} r={6} fill="currentColor" stroke="none" />
          <path d="m5 5 4 4M9 5 5 9" stroke="var(--panel)" strokeWidth="1.5" />
        </>
      );
      break;
    case "blocked":
    case "needs_input":
      body = (
        <>
          <circle cx={c} cy={c} r={6} fill="currentColor" stroke="none" />
          <path d="M7 4v3.6M7 9.8v.1" stroke="var(--panel)" strokeWidth="1.6" />
        </>
      );
      break;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={`status-icon s-${status}`}
      role="img"
      aria-label={status.replace(/_/g, " ")}
    >
      {body}
    </svg>
  );
}
