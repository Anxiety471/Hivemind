import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Loader2, Send } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { JobBlock } from "./job-card-helpers";
import { liveJob } from "./job-card-helpers";

/** The compact composer that steers a running job or answers one waiting on a person. */
export function JobComposer({
  block,
  pending,
  error,
  onSend,
  onClose,
}: {
  block: JobBlock;
  pending: boolean;
  /** The failure of the last send, shown until the reader sends again or closes the composer. */
  error: string | null;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const live = liveJob(block);
  // The reader asked for the composer, so the caret starts in it: Enter sends, Escape closes.
  useEffect(() => {
    input.current?.focus();
  }, []);
  const submit = () => {
    const text = draft.trim();
    if (!text || pending) return;
    onSend(text);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="job-composer">
      <div className="flex min-w-0 items-end gap-1.5">
        <textarea
          ref={input}
          data-testid="job-composer-input"
          aria-label={t`Instruction for ${block.title}`}
          placeholder={live ? t`Steer ${block.title}…` : t`Send instruction to ${block.title}…`}
          rows={1}
          value={draft}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          className="min-h-8 max-h-28 min-w-0 flex-1 field-sizing-content resize-none rounded-lg border border-input bg-background/80 px-2.5 py-1.5 text-[16px]/5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 md:text-body-sm"
        />
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          data-testid="job-composer-send"
          aria-label={t`Send instruction`}
          disabled={pending || !draft.trim()}
          onClick={submit}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        </Button>
      </div>
      {error ? (
        <p data-testid="job-composer-error" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
