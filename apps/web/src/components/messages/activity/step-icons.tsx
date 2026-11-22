import { Trans } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";
import {
  FileText,
  GitBranch,
  Globe,
  Mail,
  MessageSquare,
  Monitor,
  NotebookPen,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { StepCategory } from "../../../lib/chat/checkpoint-graph";

export function StepCategoryIcon({
  category,
  className = "h-3.5 w-3.5",
}: {
  category: StepCategory;
  className?: string;
}) {
  switch (category) {
    case "terminal":
      return <Terminal className={className} aria-hidden="true" />;
    case "files":
      return <FileText className={className} aria-hidden="true" />;
    case "search":
      return <Search className={className} aria-hidden="true" />;
    case "git":
      return <GitBranch className={className} aria-hidden="true" />;
    case "docs":
      return <NotebookPen className={className} aria-hidden="true" />;
    case "web":
      return <Globe className={className} aria-hidden="true" />;
    case "mail":
      return <Mail className={className} aria-hidden="true" />;
    case "chat":
      return <MessageSquare className={className} aria-hidden="true" />;
    case "computer":
      return <Monitor className={className} aria-hidden="true" />;
    case "tool":
      return <Wrench className={className} aria-hidden="true" />;
  }
}

export function StepIconPlate({
  category,
  tone = "neutral",
  size = "md",
}: {
  category: StepCategory;
  tone?: "neutral" | "working" | "waiting" | "failed" | "done";
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border transition-colors",
        size === "sm" ? "h-5 w-5" : "h-6 w-6",
        tone === "working" && "border-status-working/30 bg-status-working/10 text-status-working",
        tone === "waiting" && "border-warning/35 bg-warning/15 text-warning",
        tone === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "done" && "border-success/30 bg-success/10 text-success",
        tone === "neutral" && "border-border/80 bg-background text-muted-foreground",
      )}
    >
      <StepCategoryIcon category={category} className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
    </span>
  );
}

export function StepCategoryName({ category }: { category: StepCategory }) {
  switch (category) {
    case "terminal":
      return <Trans>Terminal</Trans>;
    case "files":
      return <Trans>Files</Trans>;
    case "search":
      return <Trans>Search</Trans>;
    case "git":
      return <Trans>Source</Trans>;
    case "docs":
      return <Trans>Notes</Trans>;
    case "web":
      return <Trans>Web</Trans>;
    case "mail":
      return <Trans>Mail</Trans>;
    case "chat":
      return <Trans>Messages</Trans>;
    case "computer":
      return <Trans>Computer</Trans>;
    case "tool":
      return <Trans>Tool</Trans>;
  }
}
