import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import { normalizeRunError } from "@rakazo/core";
import { translateRunError } from "@rakazo/i18n/run-error";
import { BotAvatar, Button, cn, resolvePersonaColorDef, Spinner } from "@rakazo/ui-web";
import { AlertCircle, Play, RotateCw } from "lucide-react";
import { useMemo } from "react";
import { FALLBACK_BOT_COLOR } from "./chat-shared";

/**
 * Inline failure card rendered inside the transcript message area for retryable model errors so
 * the user can continue from saved progress or retry without resending a new prompt.
 */
export function MessageRunError({
  error,
  resumable = false,
  retrying = false,
  onRetry,
  attachedToMessage = false,
  speaker,
}: {
  error: string;
  resumable?: boolean;
  retrying?: boolean;
  onRetry: () => void;
  attachedToMessage?: boolean;
  speaker?: {
    botId?: string;
    name?: string;
    color?: string;
    avatarSet?: BotAvatarSet;
  };
}) {
  const { t } = useLingui();
  const normalized = useMemo(
    () => normalizeRunError(error, translateRunError, i18n.locale || "en"),
    [error],
  );
  const speakerColorDef = useMemo(
    () => resolvePersonaColorDef(speaker?.botId ?? "bot", speaker?.color),
    [speaker?.botId, speaker?.color],
  );

  return (
    <div className={cn("flex flex-col items-start", attachedToMessage && "mt-2")}>
      {!attachedToMessage && speaker?.name ? (
        <div
          className="mb-1.5 flex items-center gap-2 text-body-sm font-semibold tracking-tight"
          dir="auto"
          style={{ color: speakerColorDef.hex }}
        >
          <BotAvatar
            color={speaker.color ?? FALLBACK_BOT_COLOR}
            avatarSet={speaker.avatarSet}
            identity={speaker.botId}
            size={22}
          />
          {speaker.name}
        </div>
      ) : null}
      <div
        role="alert"
        data-testid="message-run-error"
        className="w-fit max-w-full rounded-2xl border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-body-sm text-foreground"
      >
        <div className="flex items-start gap-2">
          <AlertCircle size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p>{normalized.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                data-testid="message-retry-button"
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying ? (
                  <Spinner aria-label={resumable ? t`Continuing…` : t`Retrying…`} />
                ) : resumable ? (
                  <Play aria-hidden="true" />
                ) : (
                  <RotateCw aria-hidden="true" />
                )}
                {resumable ? <Trans>Continue</Trans> : <Trans>Retry</Trans>}
              </Button>
            </div>
            <details key={error} className="mt-1.5 text-muted-foreground">
              <summary className="w-fit cursor-pointer text-label hover:text-foreground">
                {t`Details`}
              </summary>
              <pre className="mt-1.5 whitespace-pre-wrap break-words text-label text-muted-foreground">
                {normalized.details}
              </pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
