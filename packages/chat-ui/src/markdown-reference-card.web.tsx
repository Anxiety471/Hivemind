import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web";
import type { ReactElement, ReactNode } from "react";
import { useMarkdownCopy } from "./markdown-copy";
import type { ChatReferenceContext, ChatReferencePreview } from "./references";
import { describeChatReference } from "./references";

function ReferenceCardRow({ children }: { children: ReactNode }) {
  return <div className="rk-chat-ref-card-row">{children}</div>;
}

/** A pull request, commit or ticket preview: what the reference is, and its state on the board. */
function ReferenceCardBody({ preview }: { preview: ChatReferencePreview }) {
  const copy = useMarkdownCopy();
  if (preview.kind === "ticket") {
    const priority = preview.priority;
    const showPriority = priority !== undefined && priority !== "normal";
    return (
      <>
        <ReferenceCardRow>
          <span className="rk-chat-ref-card-mono">{preview.ref}</span>
          {preview.status ? (
            <span className="rk-chat-ref-card-pill">{copy.ticketStatus(preview.status)}</span>
          ) : null}
          {showPriority ? (
            <span className="rk-chat-ref-card-pill">{copy.ticketPriority(priority)}</span>
          ) : null}
        </ReferenceCardRow>
        {preview.title ? (
          <p className="rk-chat-ref-card-title" dir="auto">
            {preview.title}
          </p>
        ) : (
          <p className="rk-chat-ref-card-muted">{copy.openTicket}</p>
        )}
        {preview.repoLabel || preview.assigneeName || preview.pullRequestCount > 0 ? (
          <ReferenceCardRow>
            {preview.repoLabel ? (
              <span className="rk-chat-ref-card-mono rk-chat-ref-card-muted">
                {preview.repoLabel}
              </span>
            ) : null}
            {preview.assigneeName ? (
              <span className="rk-chat-ref-card-muted">{preview.assigneeName}</span>
            ) : null}
            {preview.pullRequestCount > 0 ? (
              <span className="rk-chat-ref-card-muted">
                {copy.pullRequestCount(preview.pullRequestCount)}
              </span>
            ) : null}
          </ReferenceCardRow>
        ) : null}
      </>
    );
  }
  if (preview.kind === "pull_request") {
    return (
      <>
        <ReferenceCardRow>
          <span>{copy.pullRequestTitle(preview.number)}</span>
          {preview.state ? (
            <span className="rk-chat-ref-card-pill">{copy.pullRequestState(preview.state)}</span>
          ) : null}
        </ReferenceCardRow>
        <ReferenceCardRow>
          <span className="rk-chat-ref-card-mono">{preview.repoLabel}</span>
          <span className="rk-chat-ref-card-muted">{preview.host}</span>
        </ReferenceCardRow>
        {preview.ticketRef ? (
          <ReferenceCardRow>
            <span className="rk-chat-ref-card-mono">{preview.ticketRef}</span>
            {preview.ticketTitle ? (
              <span className="rk-chat-ref-card-title" dir="auto">
                {preview.ticketTitle}
              </span>
            ) : null}
          </ReferenceCardRow>
        ) : null}
      </>
    );
  }
  return (
    <>
      <ReferenceCardRow>
        <span>{copy.commitTitle}</span>
        <span className="rk-chat-ref-card-mono">{preview.shortSha}</span>
        {preview.branch ? <span className="rk-chat-ref-card-pill">{preview.branch}</span> : null}
      </ReferenceCardRow>
      {preview.sha.length > preview.shortSha.length ? (
        <p className="rk-chat-ref-card-mono rk-chat-ref-card-muted rk-chat-ref-card-sha">
          {preview.sha}
        </p>
      ) : null}
      <ReferenceCardRow>
        <span className="rk-chat-ref-card-mono">{preview.repoLabel}</span>
        <span className="rk-chat-ref-card-muted">{preview.host}</span>
      </ReferenceCardRow>
      {preview.jobTitle ? (
        <p className="rk-chat-ref-card-title" dir="auto">
          {preview.jobTitle}
        </p>
      ) : null}
    </>
  );
}

/** Shows a reference's preview card when its hover or focus opens the trigger; plain otherwise. */
export function ReferenceHoverCard({
  preview,
  children,
}: {
  preview: ChatReferencePreview | undefined;
  children: ReactElement;
}) {
  if (!preview) return children;
  return (
    <Tooltip>
      <TooltipTrigger delay={250} render={children} />
      <TooltipContent
        arrow={false}
        side="top"
        sideOffset={6}
        className="rk-chat-ref-card"
        data-testid="chat-ref-hover-card"
        data-ref-kind={preview.kind}
      >
        <ReferenceCardBody preview={preview} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Wraps a link with its preview card when it names a pull request or commit; other links are unchanged. */
export function LinkPreview({
  href,
  referenceContext,
  children,
}: {
  href: string;
  referenceContext: ChatReferenceContext | undefined;
  children: ReactElement;
}) {
  return (
    <ReferenceHoverCard preview={describeChatReference(href, referenceContext)}>
      {children}
    </ReferenceHoverCard>
  );
}
