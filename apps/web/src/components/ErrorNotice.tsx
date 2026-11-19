import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ErrorDetails } from "../lib/user-error";

/** Inline failures stay brief; documented recovery instructions open only on request. */
export function ErrorNotice({
  error,
  onRetry,
  children,
}: {
  error: ErrorDetails;
  /** Offered as "Try again"; the button holds while a returned promise settles. */
  onRetry?: () => unknown;
  children?: ReactNode;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    if (!onRetry || retrying) return;
    const pending = onRetry();
    if (!pending || typeof pending !== "object" || !("then" in pending)) return;
    setRetrying(true);
    void Promise.resolve(pending).finally(() => setRetrying(false));
  };
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-body text-destructive">
      <span>{error.message}</span>
      {error.helpUrl ? (
        <a href={error.helpUrl} target="_blank" rel="noopener noreferrer" className="underline">
          <Trans>Troubleshoot</Trans>
        </a>
      ) : null}
      {onRetry ? (
        <Button type="button" variant="secondary" size="sm" disabled={retrying} onClick={retry}>
          <Trans>Try again</Trans>
        </Button>
      ) : null}
      {children}
    </div>
  );
}
