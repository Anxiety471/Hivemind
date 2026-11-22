import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { computerPreviewPlaceholder } from "@rakazo/i18n/computer-preview";
import { Button, Spinner } from "@rakazo/ui-web";
import { HardDrive, Maximize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { ComputersUnavailableHint } from "../../../components/computers/ComputersUnavailableHint";
import { runsOnUserMachine } from "../../../lib/computers/computer-sandbox";
import { screenFrames, screenIframeSandbox } from "../../../lib/computers/computer-screen";
import { DesktopKindEmptyState } from "./computer-view";

type ComputerPanelProps = {
  computer: ComputerStatus | null;
  computerOpen: boolean;
  embeddedScreenUrl: string | null;
  /** Changes to load the screen again in a new frame. */
  screenFrameKey?: string;
  heldScreen?: { url: string; key: string } | null;
  screenFrameRef: (frame: HTMLIFrameElement | null) => void;
  computerScreenError: ReactNode;
  computerBooting: ReactNode;
  booting: boolean;
  showingRecoveryHint: boolean;
  showComputerRecoveryHint: boolean;
  sandboxProvider?: string | null;
  onRecovered: (sandboxProvider: string) => void;
  onRecoveryDismissed: () => void;
  onOpenComputerSettings?: () => void;
  onOpen: () => void;
  cleaningUpDisk?: boolean;
  onCleanUpDisk?: () => void;
  onDismissDiskWarning?: () => void;
};

export function ComputerPanel({
  cleaningUpDisk,
  onCleanUpDisk,
  onDismissDiskWarning,
  ...props
}: ComputerPanelProps) {
  const percent = props.computer?.diskFullPercent;
  const warn = percent !== undefined && onCleanUpDisk && onDismissDiskWarning;
  // The preview keeps its place either way, so the warning never remounts the live screen.
  return (
    <>
      <ComputerPreview {...props} />
      {warn && (
        <div
          data-testid="computer-disk-warning"
          className="mt-2 flex items-center gap-2 rounded-[14px] border border-warning/40 py-1.5 ps-3 pe-1.5 text-body"
        >
          <HardDrive aria-hidden size={15} strokeWidth={1.9} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            <Trans>Computer is {percent}% full</Trans>
          </span>
          <Button variant="secondary" size="sm" disabled={cleaningUpDisk} onClick={onCleanUpDisk}>
            <Trans>Clean up</Trans>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Dismiss`}
            onClick={onDismissDiskWarning}
          >
            <X size={15} aria-hidden />
          </Button>
        </div>
      )}
    </>
  );
}

function ComputerPreview({
  computer,
  computerOpen,
  embeddedScreenUrl,
  screenFrameKey,
  heldScreen,
  screenFrameRef,
  computerScreenError,
  computerBooting,
  booting,
  showingRecoveryHint,
  showComputerRecoveryHint,
  sandboxProvider,
  onRecovered,
  onRecoveryDismissed,
  onOpenComputerSettings,
  onOpen,
}: Omit<ComputerPanelProps, "cleaningUpDisk" | "onCleanUpDisk" | "onDismissDiskWarning">) {
  // A clickable preview invites a boot that costs money, so an idle computer only wakes from its button.
  const idle =
    !computerOpen &&
    !booting &&
    !computerBooting &&
    !computerScreenError &&
    !showComputerRecoveryHint &&
    !runsOnUserMachine(computer) &&
    (!computer || computer.state === "stopped" || computer.state === "suspended");
  if (idle) {
    return (
      <div
        data-testid="computer-preview"
        data-state="idle"
        className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-muted/50 px-4 py-1.5 text-body"
      >
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          <Trans>Asleep</Trans>
        </span>
        <Button variant="secondary" size="sm" data-testid="computer-preview-open" onClick={onOpen}>
          <Trans>Wake</Trans>
        </Button>
      </div>
    );
  }
  const canOpen = !computerScreenError && !showingRecoveryHint;
  const liveScreen =
    !runsOnUserMachine(computer) &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !computerScreenError;
  // Nothing to look at yet: a boot, a connection, or a failure gets one line, not an empty frame.
  if (
    !computerOpen &&
    !runsOnUserMachine(computer) &&
    !liveScreen &&
    !showingRecoveryHint &&
    !computerScreenError
  ) {
    return (
      <div
        data-testid="computer-preview"
        data-state={computer?.state === "running" ? "running" : undefined}
        className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-muted/50 px-4 py-1.5 text-body"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
          {!computerBooting && computer?.state === "running" ? (
            <Spinner aria-hidden className="size-3.5 shrink-0 motion-reduce:animate-none" />
          ) : null}
          <span className="min-w-0 truncate">
            {computerBooting ?? computerPreviewPlaceholder(computer?.state, booting)}
          </span>
        </div>
        {canOpen ? (
          <Button
            variant="secondary"
            size="sm"
            data-testid="computer-preview-open"
            onClick={onOpen}
          >
            <Trans>Open</Trans>
          </Button>
        ) : null}
      </div>
    );
  }
  // The Open pill replaces the status text on hover; fade it so they never overlap.
  const hideOnHover = canOpen
    ? "transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0"
    : "";
  return (
    <div>
      <div
        data-testid="computer-preview"
        data-state={
          computer?.state === "running" && !runsOnUserMachine(computer) ? "running" : undefined
        }
        className={`group relative rounded-xl bg-muted/50 ${
          showingRecoveryHint || computerScreenError ? "" : "aspect-[16/10] overflow-hidden"
        }`}
      >
        {computerOpen ? (
          <div
            className={`grid h-full place-items-center text-body text-muted-foreground/80 ${hideOnHover}`}
          >
            <Trans>Open in full window</Trans>
          </div>
        ) : runsOnUserMachine(computer) ? (
          <DesktopKindEmptyState
            className={`grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80 ${hideOnHover}`}
          />
        ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
          screenFrames(screenFrameKey, embeddedScreenUrl, heldScreen).map((frame) => (
            <iframe
              key={frame.key}
              title={frame.held ? undefined : t`Bot screen preview`}
              aria-hidden={frame.held || undefined}
              tabIndex={-1}
              ref={frame.held ? undefined : screenFrameRef}
              src={frame.url}
              sandbox={screenIframeSandbox(frame.url)}
              className={`h-full w-full border-0 bg-black${frame.held ? " absolute inset-0" : ""}`}
              allow="clipboard-read; clipboard-write"
              style={{ pointerEvents: "none" }}
            />
          ))
        ) : (
          <div
            className={`grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80 ${hideOnHover} ${
              showingRecoveryHint || computerScreenError ? "py-6" : ""
            }`}
          >
            {computerScreenError ??
              (showComputerRecoveryHint ? (
                <ComputersUnavailableHint
                  sandboxProvider={sandboxProvider}
                  onRecovered={onRecovered}
                  onRecoveryDismissed={onRecoveryDismissed}
                  onOpenComputerSettings={onOpenComputerSettings}
                />
              ) : (
                (computerBooting ?? computerPreviewPlaceholder(computer?.state, booting))
              ))}
          </div>
        )}
        {canOpen ? (
          <button
            type="button"
            data-testid="computer-preview-open"
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t`Open`}
            onClick={onOpen}
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-background px-3.5 py-2 text-body text-foreground shadow-md">
              <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
              <Trans>Open</Trans>
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
