import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { cn } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useCopied } from "./job-card-helpers";

/** Longest preview of a job's reply that opens on its own, and the most lines it may take. */
const PREVIEW_CHARS = 220;

const PREVIEW_LINES = 3;

/** The job's own words, with code, lists and headings drawn rather than shown as plain text. */
export function OutputBody({
  reply,
  foldable,
  copyable = false,
  label,
}: {
  reply: string;
  foldable: boolean;
  /** Draws a Copy button beside the fold control: the inspector has no footer of its own. */
  copyable?: boolean;
  /** Names what is copied, such as the job's output inside the inspector. */
  label?: string;
}) {
  const { t } = useLingui();
  const longEnough = reply.length > PREVIEW_CHARS || reply.split("\n").length > PREVIEW_LINES;
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopied();
  const canFold = foldable && longEnough;
  const folded = canFold && !open;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={cn("relative min-w-0", folded && "max-h-36 overflow-hidden")}>
        <div
          data-testid="job-output"
          className="min-w-0 text-body-sm leading-relaxed text-foreground/90 wrap-anywhere [&_[data-slot=katex-display]]:overflow-x-auto"
          dir="auto"
        >
          <ChatMarkdown>{reply}</ChatMarkdown>
        </div>
        {folded ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent"
            aria-hidden
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {canFold ? (
          <button
            type="button"
            data-testid="job-reply-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="w-fit text-label text-muted-foreground hover:text-foreground focus-ring"
          >
            {open ? t`Show less` : t`Show more`}
          </button>
        ) : null}
        {copyable ? (
          <button
            type="button"
            data-testid="job-output-copy"
            aria-label={copied ? t`Copied` : (label ?? t`Copy output`)}
            onClick={() => copy(reply)}
            className="inline-flex w-fit items-center gap-1 text-label text-muted-foreground hover:text-foreground focus-ring"
          >
            {copied ? (
              <Check className="size-3" aria-hidden />
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </button>
        ) : null}
      </div>
    </div>
  );
}
