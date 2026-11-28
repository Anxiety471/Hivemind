import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatMarkdown, withChatReferences } from "@rakazo/chat-ui/web";
import type { AskItem } from "@rakazo/contracts";
import { formatBatchAskAnswer, resolveAskChoice } from "@rakazo/core";
import { Button, cn, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { useChatReferences } from "../../pages/shell/chat/chat-references";
import { BuiCard } from "../ai/primitives";
import type { AskBlock, AskCardProps } from "./AskCard";
import { OptionRow, optionLetter } from "./OptionRow";

type Draft = { choice?: string; other: string; otherOpen: boolean };

/** What an actionable item is answered with: the picked choice, or the typed Other text. */
function draftAnswer(draft: Draft | undefined): string | undefined {
  if (!draft) return undefined;
  if (draft.otherOpen) return draft.other.trim() || undefined;
  return draft.choice;
}

/** Several independent questions answered together: one send resumes the bot once. */
export function BatchAskCard({
  block,
  canAnswer,
  onAnswer,
}: Pick<AskCardProps, "canAnswer" | "onAnswer"> & { block: AskBlock }) {
  const { referenceContext, openTicket, decideTicket } = useChatReferences();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [accepted, setAccepted] = useState(false);
  const send = useSave<string>({
    save: (answer) => onAnswer(answer),
    onSaved: () => setAccepted(true),
  });
  const submitting = send.pending;
  const error = send.error ? errorText(send.error, t`Could not submit these answers`) : null;
  const answered = block.status === "answered" || accepted;
  const items = block.items ?? [];
  const actionableItems = items.filter((item) => item.actions?.length);
  const drafted = (item: AskItem) => draftAnswer(drafts[item.id]);
  const answers = Object.fromEntries(
    actionableItems.flatMap((item) => {
      const answer = drafted(item);
      return answer ? [[item.id, answer] as const] : [];
    }),
  );
  const answeredCount = Object.keys(answers).length;

  function updateDraft(itemId: string, change: Partial<Draft>) {
    setDrafts((previous) => ({
      ...previous,
      [itemId]: { other: "", otherOpen: false, ...previous[itemId], ...change },
    }));
  }

  function submitAll() {
    if (submitting || answeredCount < actionableItems.length) return;
    send.run(formatBatchAskAnswer(answers));
  }

  const linked = (text: string) => withChatReferences(text, referenceContext);

  return (
    <BuiCard data-testid="batch-ask-card" className="w-full min-w-0 max-w-xl px-5 py-4">
      <div className="text-body-lg leading-[1.5] text-foreground">
        <ChatMarkdown
          referenceContext={referenceContext}
          onOpenTicket={openTicket}
          onDecideTicket={decideTicket}
        >
          {linked(block.text)}
        </ChatMarkdown>
      </div>
      {block.detail ? (
        <div className="mt-2.5 text-body text-muted-foreground">
          <ChatMarkdown
            referenceContext={referenceContext}
            onOpenTicket={openTicket}
            onDecideTicket={decideTicket}
          >
            {linked(block.detail)}
          </ChatMarkdown>
        </div>
      ) : null}
      <ul className="mt-3 divide-y divide-border/60">
        {items.map((item) => {
          const actions = item.actions ?? [];
          const actionable = actions.length > 0;
          const draft = drafts[item.id];
          const stored = item.answer ?? (accepted ? drafted(item) : undefined);
          const chosen = stored ? resolveAskChoice(stored, actions) : undefined;
          const customAnswer = stored && actionable && !chosen ? stored : undefined;
          const ticketRef = item.ticketRef;
          const namedInQuestion =
            !ticketRef || item.question.toLowerCase().includes(ticketRef.toLowerCase());
          return (
            <li key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <div
                  className={cn(
                    "min-w-0 flex-1 text-body-lg leading-[1.5]",
                    actionable ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <ChatMarkdown
                    referenceContext={referenceContext}
                    onOpenTicket={openTicket}
                    onDecideTicket={decideTicket}
                  >
                    {linked(item.question)}
                  </ChatMarkdown>
                </div>
                {ticketRef && openTicket && !namedInQuestion ? (
                  <Button variant="link" size="sm" onClick={() => openTicket(ticketRef)}>
                    {ticketRef}
                  </Button>
                ) : null}
              </div>
              {item.detail ? (
                <div className="mt-1 text-body-sm text-muted-foreground">
                  <ChatMarkdown
                    referenceContext={referenceContext}
                    onOpenTicket={openTicket}
                    onDecideTicket={decideTicket}
                  >
                    {linked(item.detail)}
                  </ChatMarkdown>
                </div>
              ) : null}
              {actionable ? (
                <div className="mt-2 space-y-0.5">
                  {actions.map((action, index) => (
                    <div
                      key={action.id}
                      className={answered && chosen?.id !== action.id ? "opacity-50" : undefined}
                    >
                      <OptionRow
                        letter={optionLetter(index)}
                        selected={answered ? chosen?.id === action.id : draft?.choice === action.id}
                        disabled={answered || !canAnswer || submitting}
                        badge={
                          action.recommended ? (
                            <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-caption font-medium text-foreground">
                              <Trans>Recommended</Trans>
                            </span>
                          ) : undefined
                        }
                        onClick={() =>
                          updateDraft(item.id, { choice: action.id, otherOpen: false })
                        }
                      >
                        <span className="block">{action.label}</span>
                        {action.description ? (
                          <span className="block text-body-sm text-muted-foreground">
                            {action.description}
                          </span>
                        ) : null}
                      </OptionRow>
                    </div>
                  ))}
                  {!answered && canAnswer ? (
                    <>
                      <OptionRow
                        letter={optionLetter(actions.length)}
                        selected={draft?.otherOpen}
                        disabled={submitting}
                        onClick={() =>
                          updateDraft(item.id, {
                            choice: undefined,
                            otherOpen: !draft?.otherOpen,
                          })
                        }
                      >
                        <Trans>Other</Trans>
                      </OptionRow>
                      {draft?.otherOpen ? (
                        <Input
                          size="sm"
                          aria-label={t`Other answer`}
                          placeholder={t`Type your answer…`}
                          value={draft.other}
                          disabled={submitting}
                          onChange={(event) => updateDraft(item.id, { other: event.target.value })}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {customAnswer ? (
                    <blockquote className="mt-2 whitespace-pre-wrap break-words border-s-2 border-border ps-3 text-body-sm text-muted-foreground">
                      {customAnswer}
                    </blockquote>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {actionableItems.length > 0 && !answered && canAnswer ? (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            disabled={submitting || answeredCount < actionableItems.length}
            onClick={submitAll}
          >
            {submitting ? (
              <Trans>Sending…</Trans>
            ) : actionableItems.length === 1 ? (
              <Trans>Send answer</Trans>
            ) : (
              <Trans>
                Send answers ({answeredCount}/{actionableItems.length})
              </Trans>
            )}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-body-sm text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
