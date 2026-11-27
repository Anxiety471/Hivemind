import { ChatMarkdown, LinkifiedText, withChatReferences } from "@rakazo/chat-ui/native";
import { splitMentionText } from "@rakazo/core";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { useContext, useMemo } from "react";
import type { MobileMessage } from "../../lib/api/mobile-types";
import { useChatReferences } from "../../lib/board/chat-references";
import {
  MessageMentionsContext,
  OpenPageContext,
  UserMentionsContext,
} from "../../lib/messages/message-mentions";
import { UserMention } from "./user-mention";

export function MessageCaption({
  role,
  received,
  text,
  tokens,
  colorScheme,
  streaming,
}: {
  role: MobileMessage["role"];
  /** Another person's message sits on the received surface. */
  received?: boolean;
  text: string;
  tokens: ColorTokens;
  colorScheme: ResolvedAppearance;
  streaming: boolean;
}) {
  const renderMention = useContext(MessageMentionsContext);
  const userMentions = useContext(UserMentionsContext);
  const openPage = useContext(OpenPageContext);
  const { referenceContext, openTicket } = useChatReferences();
  // Bot prose links its tickets, pull requests and commit SHAs; user text resolves them while drawn.
  const linkedText = useMemo(
    () => withChatReferences(text, referenceContext),
    [text, referenceContext],
  );
  // User messages keep literal Markdown; only explicit URLs, email addresses and page links link.
  // Links stay the bubble's text colour (underlined): link blue is too faint on chatUser.
  return role === "user" ? (
    <LinkifiedText
      color={received ? tokens.foreground : tokens.chatUserForeground}
      linkColor={received ? tokens.foreground : tokens.chatUserForeground}
      palette={tokens}
      renderText={
        userMentions
          ? (run) =>
              splitMentionText(run, userMentions.targets).map((part, index) =>
                part.target ? (
                  <UserMention
                    key={index}
                    target={part.target}
                    label={part.text.slice(1)}
                    color={tokens.chatUserForeground}
                    onOpenBot={userMentions.onOpenBot}
                  />
                ) : (
                  part.text
                ),
              )
          : undefined
      }
      onOpenPage={openPage}
      onOpenTicket={openTicket}
      referenceContext={referenceContext}
    >
      {text}
    </LinkifiedText>
  ) : (
    <ChatMarkdown
      palette={tokens}
      colorScheme={colorScheme}
      streaming={streaming}
      renderMention={renderMention}
      onOpenPage={openPage}
      onOpenTicket={openTicket}
    >
      {linkedText}
    </ChatMarkdown>
  );
}
