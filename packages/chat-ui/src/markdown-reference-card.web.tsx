import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web";
import type { ReactElement, ReactNode } from "react";
import { useRef, useState } from "react";
import type { ChatMarkdownProps } from "./markdown";
import { defaultMarkdownCopy, useMarkdownCopy } from "./markdown-copy";
import type { ChatReferenceContext, ChatReferencePreview, ChatTicketDecision } from "./references";
import { describeChatReference } from "./references";

function ReferenceCardRow({ children }: { children: ReactNode }) {
  return <div className="rk-chat-ref-card-row">{children}</div>;
}

type DecideTicket = NonNullable<ChatMarkdownProps["onDecideTicket"]>;

/** A ticket's open decision: its question, and one button per option. A click answers it. */
function DecisionChoices({
  ticketId,
  decision,
  onDecideTicket,
}: {
  ticketId: string;
  decision: ChatTicketDecision;
  onDecideTicket: DecideTicket;
}) {
  const copy = useMarkdownCopy();
  const recommended = copy.recommended ?? defaultMarkdownCopy.recommended;
  const [pendingOptionId, setPendingOptionId] = useState<string | undefined>(undefined);
  // A ref, not the state: two clicks before the next render must still count as one answer.
  const answering = useRef(false);
  const choose = async (optionId: string) => {
    if (answering.current) return;
    answering.current = true;
    setPendingOptionId(optionId);
    try {
      await onDecideTicket(ticketId, optionId);
    } finally {
      answering.current = false;
      setPendingOptionId(undefined);
    }
  };
  return (
    <div className="rk-chat-ref-card-decision">
      <p className="rk-chat-ref-card-title" dir="auto">
        {decision.question}
      </p>
      {decision.options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="rk-chat-ref-card-choice"
          data-pending={pendingOptionId === option.id || undefined}
          disabled={pendingOptionId !== undefined}
          onClick={(event) => {
            // The card sits in a row that opens the thread; a choice answers only itself.
            event.stopPropagation();
            void choose(option.id);
          }}
        >
          <span dir="auto">{option.label}</span>
          {option.recommended ? <span className="rk-chat-ref-card-pill">{recommended}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A pull request, commit or ticket preview: what the reference is, and its state on the board. */
function ReferenceCardBody({
  preview,
  onDecideTicket,
}: {
  preview: ChatReferencePreview;
  onDecideTicket: DecideTicket | undefined;
}) {
  const copy = useMarkdownCopy();
  if (preview.kind === "ticket") {
    const priority = preview.priority;
    const showPriority = priority !== undefined && priority !== "normal";
    const decision = preview.decision;
    const answered = decision?.options.find((option) => option.id === decision.answer);
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
        {decision && !decision.answer && preview.ticketId && onDecideTicket ? (
          <DecisionChoices
            ticketId={preview.ticketId}
            decision={decision}
            onDecideTicket={onDecideTicket}
          />
        ) : null}
        {answered ? (
          <p className="rk-chat-ref-card-muted">
            {(copy.decided ?? defaultMarkdownCopy.decided)(answered.label)}
          </p>
        ) : null}
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
  onDecideTicket,
  children,
}: {
  preview: ChatReferencePreview | undefined;
  onDecideTicket?: DecideTicket;
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
        <ReferenceCardBody preview={preview} onDecideTicket={onDecideTicket} />
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
