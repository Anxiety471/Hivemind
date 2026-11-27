import { useLingui } from "@lingui/react/macro";
import { useNow, useTimeout } from "@rakazo/chat-ui/hooks";
import { cn } from "@rakazo/ui-web";
import { useState } from "react";
import { useServerReachable } from "../../lib/query/connection-state";
import "./beautiful-ui.css";

/* Beautiful UI primitives — hand-ported from beautifului.dev
   (github.com/TurboKach/ai-native-react-components, MIT © 2026 Turbo).
   The upstream components are demo showcases; these ports keep their visual
   and motion language (pixel-grid loader, shimmer sweep, pop-in success) and
   expose real props. */

/** A light sweep travelling across a text label; reduced motion keeps it as plain muted text. */
export function Shimmer({ children }: { children: React.ReactNode }) {
  return (
    <span className="animate-[bui-shimmer-text_1.4s_linear_infinite] bg-linear-to-r from-muted-foreground from-35% via-foreground via-50% to-muted-foreground to-65% bg-size-[200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground">
      {children}
    </span>
  );
}

// Chevron wavefront: each 3×3 cell fires by column distance from the center row.
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/** Format wall-clock seconds since `startedAtMs` as `0.0s` / `1m 2.3s`. */
export function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalTenths = Math.round(Math.max(0, nowMs - startedAtMs) / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = (totalTenths % 600) / 10;
  if (minutes === 0) return `${seconds.toFixed(1)}s`;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function useElapsed(startedAtMs?: number): string | null {
  const [mountedAt] = useState(() => Date.now());
  // Twice a second is enough to read seconds; a tenth-of-a-second clock only flutters.
  const now = useNow(500);
  const startedAt = startedAtMs ?? mountedAt;
  // A quick wait shows no clock at all, rather than flashing 0.0s and vanishing.
  return now - startedAt >= 1_000 ? formatElapsed(startedAt, now) : null;
}

/** Pixel-grid loader with shimmering label and a live elapsed timer once the wait is worth timing. */
function DefaultLoadingState({ label, startedAt }: { label: string; startedAt?: number }) {
  const elapsed = useElapsed(startedAt);
  return (
    <>
      <span aria-hidden className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {CHEVRON_DELAYS.map((delay, i) => (
          <span
            key={i}
            className="bui-pixel h-[4px] w-[4px] rounded-[1px] bg-foreground opacity-15"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span className="text-body font-medium">
        <Shimmer>{label}</Shimmer>
      </span>
      {elapsed ? (
        <span className="font-mono text-label tabular-nums text-muted-foreground">{elapsed}</span>
      ) : null}
    </>
  );
}

export function LoadingState({
  indicator,
  label = "working",
  startedAt,
}: {
  indicator?: React.ReactNode;
  label?: string;
  /** Epoch ms when the run started. Falls back to mount time when omitted. */
  startedAt?: number;
}) {
  if (indicator) {
    return (
      <span role="status" className="flex w-fit items-center gap-2.5">
        <span className="sr-only">{label}</span>
        {indicator}
      </span>
    );
  }
  return (
    <span className="flex w-fit items-center gap-2.5">
      <DefaultLoadingState label={label} startedAt={startedAt} />
    </span>
  );
}

/**
 * A calm hint that appears only once a wait has lasted long enough to be worth mentioning, so a
 * fast load says nothing extra. It says the server is being re-reached when that is the reason.
 */
export function SlowHint({
  pending,
  delayMs = 2_500,
  label,
  className,
}: {
  pending: boolean;
  /** How long the wait may last before saying anything. */
  delayMs?: number;
  label?: string;
  className?: string;
}) {
  const { t } = useLingui();
  const reachable = useServerReachable();
  const [slow, setSlow] = useState(false);
  const [waiting, setWaiting] = useState(pending);
  // Each wait starts silent again, so a previous slow load never leaks into a new one.
  if (waiting !== pending) {
    setWaiting(pending);
    setSlow(false);
  }
  useTimeout(() => setSlow(true), pending ? delayMs : null, pending);
  if (!pending || !slow) return null;
  return (
    <span
      role="status"
      className={cn(
        "animate-in fade-in-0 text-body text-muted-foreground duration-300 motion-reduce:animate-none",
        className,
      )}
    >
      <Shimmer>{label ?? (reachable ? t`Still loading…` : t`Reconnecting…`)}</Shimmer>
    </span>
  );
}

/** Pop-in green check with a fading-up label — the approval-card success beat. */
export function SuccessPop({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="bui-pop-in flex h-6 w-6 items-center justify-center rounded-full bg-success text-background">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <span className="bui-fade-up text-body-sm font-medium text-foreground">{label}</span>
    </span>
  );
}

/** Card shell for every card in the chat. */
export function BuiCard({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div {...props} className={cn("rounded-2xl bg-card", className)} />;
}
