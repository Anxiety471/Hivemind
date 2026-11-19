import { Trans } from "@lingui/react/macro";
import { formatCompactDuration } from "@rakazo/core";

/**
 * The reasoning a bot did before it answered: "Thought for 2s" over the first few lines it
 * streamed while thinking.
 *
 * PROPOSED CONTRACT (backend workstream): add
 * `{ kind: "thinking"; durationMs: number; lines: string[] }` as an additive member of
 * `MessageBlock` in `packages/contracts/src/events.ts`, and render it from the block switch in
 * `apps/web/src/pages/shell/message-view.tsx` beside the `steps` branch (above the tool activity
 * card), in a full-width message frame so the card spans the transcript. `lines` is raw
 * thinking-delta capture, truncated to the first few lines; `durationMs` is the thinking
 * segment's wall time.
 */
export function ThinkingPanel({ durationMs, lines }: { durationMs: number; lines: string[] }) {
  const duration = formatCompactDuration(durationMs);
  if (!duration) return null;
  return (
    <div
      data-testid="thinking-panel"
      className="w-full rounded-lg border border-border/35 bg-transparent p-3"
    >
      <div className="text-label text-muted-foreground/95">
        <Trans>Thought for {duration}</Trans>
      </div>
      <div className="mt-2 space-y-1.5 text-body text-muted-foreground">
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </div>
  );
}
