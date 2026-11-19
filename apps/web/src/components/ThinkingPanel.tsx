import { Trans } from "@lingui/react/macro";
import { formatCompactDuration } from "@rakazo/core";

/**
 * The reasoning a bot did before it answered: "Thought for 2s" over the first few lines it
 * streamed while thinking. It renders one `{ kind: "thinking"; durationMs; lines }` block of
 * the reply, inside the message's one activity panel beside the tool rows.
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
