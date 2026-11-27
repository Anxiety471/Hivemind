import { Trans, useLingui } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

/** `Open` leaves the card for the job itself, so it is the one primary action in both footers. */
const OPEN_LINK =
  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/75 bg-background/85 px-2.5 py-1 text-label font-medium text-foreground no-underline shadow-2xs transition-colors hover:border-border hover:bg-accent focus-ring";

export function OpenLink({ href }: { href: string }) {
  const { t } = useLingui();
  return (
    <a href={href} target="_blank" rel="noreferrer" data-testid="job-open" className={OPEN_LINK}>
      <Trans>Open</Trans>
      <ExternalLink className="size-3" aria-label={t`(opens in a new tab)`} />
    </a>
  );
}

export function MetaChip({
  icon,
  children,
  title,
  onClick,
  testId,
}: {
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  testId: string;
}) {
  const className = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border/45 bg-muted/45 px-2 py-0.5 text-caption text-muted-foreground",
    onClick
      ? "cursor-pointer transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-ring"
      : undefined,
  );
  const content = (
    <>
      {icon ? (
        <span className="shrink-0 [&_svg]:size-3" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={className}
      title={title}
      onClick={onClick}
      data-testid={testId}
    >
      {content}
    </button>
  ) : (
    <span className={className} title={title} data-testid={testId}>
      {content}
    </span>
  );
}

/** The small dot between a card's values, drawn as an element rather than as text. */
export function Dot() {
  return (
    <span
      className="mx-1.5 inline-block size-1 shrink-0 rounded-full bg-muted-foreground/60 align-middle"
      aria-hidden
    />
  );
}
