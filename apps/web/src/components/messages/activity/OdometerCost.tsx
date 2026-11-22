import { cn } from "@rakazo/ui-web";
import { formatCostUsd } from "../../../lib/chat/checkpoint-graph";

/** Rolling per-digit USD readout that animates only changed numerals cleanly. */
export function OdometerCost({
  costUsd,
  className,
}: {
  costUsd: number | null | undefined;
  className?: string;
}) {
  const formatted = formatCostUsd(costUsd);
  if (!formatted) return null;

  return (
    <span
      className={cn(
        "inline-flex items-baseline font-mono text-label tabular-nums text-muted-foreground",
        className,
      )}
    >
      <span className="sr-only">{formatted}</span>
      <span className="contents" aria-hidden="true">
        {formatted.split("").map((char, slot) => {
          const isDigit = /\d/.test(char);
          return (
            <span
              key={isDigit ? `slot-${slot}-${char}` : `static-${slot}`}
              className={isDigit ? "monitor-digit-enter" : undefined}
            >
              {char}
            </span>
          );
        })}
      </span>
    </span>
  );
}
