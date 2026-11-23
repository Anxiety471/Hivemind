import type { BotAvatarSet } from "@rakazo/contracts";
import { splitPeerLabel } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, GroupAvatar } from "@rakazo/ui-web";
import { SquareTerminal } from "lucide-react";

export function CollaborationMarker({
  color,
  avatarSet,
  identity,
  label,
  peerName,
  onClick,
}: {
  color: string;
  avatarSet?: BotAvatarSet;
  identity: string;
  label: string;
  peerName: string;
  onClick: () => void;
}) {
  const parts = splitPeerLabel(label, peerName);
  return (
    <div className="flex min-w-0 max-w-full justify-center">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={label}
        onClick={onClick}
        className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-body-sm text-muted-foreground transition-colors hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {parts.before ? <span className="whitespace-pre-wrap">{parts.before}</span> : null}
        <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
        {parts.name ? (
          <span dir="auto" className="truncate font-medium">
            {parts.name}
          </span>
        ) : null}
        {parts.after ? <span className="whitespace-pre-wrap">{parts.after}</span> : null}
      </button>
    </div>
  );
}

/**
 * A message from an agent outside the Space. It carries the agent's own name and a plain agent
 * glyph, and offers nothing to open: there is no bot behind it.
 */
export function AgentMessageMarker({ label, agentName }: { label: string; agentName: string }) {
  const parts = splitPeerLabel(label, agentName);
  return (
    <div className="flex min-w-0 max-w-full justify-center">
      <span
        data-testid="agent-message-chip"
        role="note"
        aria-label={label}
        className="inline-flex max-w-full items-center gap-1 px-2.5 py-1 text-body-sm text-muted-foreground"
      >
        {parts.before ? <span className="whitespace-pre-wrap">{parts.before}</span> : null}
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center rounded-[5px] bg-muted text-foreground"
        >
          <SquareTerminal className="size-3" />
        </span>
        {parts.name ? (
          <span dir="auto" className="truncate font-medium">
            {parts.name}
          </span>
        ) : null}
        {parts.after ? <span className="whitespace-pre-wrap">{parts.after}</span> : null}
      </span>
    </div>
  );
}

/** The working bot with what it is doing right now, such as its current tool call. */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div role="status" className="flex min-h-10 min-w-0 items-center gap-2.5 px-1">
      <GroupAvatar members={bots} size={28} />
      <span dir="auto" className="min-w-0 truncate text-body-lg text-muted-foreground text-shimmer">
        {label}
      </span>
    </div>
  );
}
