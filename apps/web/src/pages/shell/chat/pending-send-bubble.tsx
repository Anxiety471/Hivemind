import { t } from "@lingui/core/macro";
import { formatFileSize, isModelRequiredSendError } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Clock, FileText, X } from "lucide-react";
import type { WebSendAttempt } from "../../../lib/composer/send-outbox";

/**
 * The user bubble a send shows while the outbox still holds it: the same frame as a sent
 * message, dimmed, with one line under it saying what happens next.
 */
export function PendingSendBubble({
  attempt,
  onRetry,
  onSendAsFile,
  onDiscard,
  onOpenModels,
}: {
  attempt: WebSendAttempt;
  onRetry: (clientNonce: string) => void;
  onSendAsFile: (clientNonce: string) => void;
  onDiscard: (clientNonce: string) => void;
  onOpenModels?: () => void;
}) {
  const payload = attempt.payload;
  // Matches `bubbleFrameWidth("user")` in the transcript, kept here to avoid importing it.
  const frameWidth =
    "max-w-[min(84%,calc(100%_-_8rem),39rem)] [@media(hover:none)]:max-w-[min(84%,39rem)]";
  return (
    <div
      data-testid="pending-send-bubble"
      data-send-state={attempt.state}
      className="flex justify-end"
    >
      <div className={`flex flex-col items-end gap-1.5 min-w-0 ${frameWidth}`}>
        {payload.replyPreview ? (
          <div
            className="max-w-full truncate border-s-2 border-border ps-2 text-body-sm text-muted-foreground"
            dir="auto"
          >
            {payload.replyPreview}
          </div>
        ) : null}
        {payload.attachments.map((attachment) => {
          if (attachment.kind === "file" && attachment.previewUrl) {
            return (
              <img
                key={attachment.id}
                src={attachment.previewUrl}
                alt={attachment.name}
                className="max-h-56 max-w-full rounded-2xl object-cover opacity-80"
              />
            );
          }
          const name = attachment.kind === "drive" ? attachment.driveFile.name : attachment.name;
          const size = attachment.kind === "drive" ? attachment.driveFile.size : attachment.size;
          return (
            <div
              key={attachment.id}
              className="flex max-w-full items-center gap-2 rounded-2xl border border-border bg-muted/60 px-3 py-2 text-body-sm text-foreground opacity-80"
            >
              <FileText size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{name}</span>
              {size > 0 ? (
                <span className="shrink-0 text-label text-muted-foreground">
                  {formatFileSize(size)}
                </span>
              ) : null}
            </div>
          );
        })}
        {payload.displayText ? (
          <div
            dir="auto"
            className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-2xl bg-chat-user px-4 py-2.5 text-body-lg text-chat-user-foreground opacity-80"
          >
            {payload.displayText}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-1.5 text-label">
          {attempt.state === "pending" ? (
            <span className="text-muted-foreground">{t`Sending…`}</span>
          ) : null}
          {attempt.state === "queued" ? (
            <>
              <span
                className="inline-flex items-center gap-1 text-muted-foreground"
                title={attempt.error}
              >
                <Clock size={12} aria-hidden="true" />
                {t`Waiting for connection…`}
              </span>
              <Button
                type="button"
                variant="text"
                size="xs"
                onClick={() => onRetry(attempt.clientNonce)}
              >
                {t`Retry`}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`Cancel message`}
                onClick={() => onDiscard(attempt.clientNonce)}
              >
                <X aria-hidden="true" />
              </Button>
            </>
          ) : null}
          {attempt.state === "failed" ? (
            attempt.imageConfirmation ? (
              <>
                <span className="text-warning">
                  {attempt.error ?? t`Image input is not configured for this model.`}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onSendAsFile(attempt.clientNonce)}
                >
                  {t`Send as file`}
                </Button>
                {onOpenModels ? (
                  <Button type="button" variant="outline" size="xs" onClick={onOpenModels}>
                    {t`Change model`}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Delete unsent message`}
                  onClick={() => onDiscard(attempt.clientNonce)}
                >
                  <X aria-hidden="true" />
                </Button>
              </>
            ) : isModelRequiredSendError(attempt.error) ? (
              <>
                <span className="text-destructive">{t`Not sent`}</span>
                {onOpenModels ? (
                  <Button type="button" variant="text" size="xs" onClick={onOpenModels}>
                    {t`Choose a model`}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Delete unsent message`}
                  onClick={() => onDiscard(attempt.clientNonce)}
                >
                  <X aria-hidden="true" />
                </Button>
              </>
            ) : (
              <>
                <span className="text-destructive" title={attempt.error}>
                  {t`Not sent`}
                </span>
                <Button
                  type="button"
                  variant="text"
                  size="xs"
                  onClick={() => onRetry(attempt.clientNonce)}
                >
                  {t`Retry`}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Delete unsent message`}
                  onClick={() => onDiscard(attempt.clientNonce)}
                >
                  <X aria-hidden="true" />
                </Button>
              </>
            )
          ) : null}
          {attempt.state === "refused" ? (
            <>
              <span className="text-destructive">{attempt.error ?? t`Not sent`}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`Delete unsent message`}
                onClick={() => onDiscard(attempt.clientNonce)}
              >
                <X aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
