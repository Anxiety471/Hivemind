import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MarkdownCopy } from "@rakazo/chat-ui/web";
import { MarkdownCopyProvider } from "@rakazo/chat-ui/web";
import type { ReactNode } from "react";
import { useMemo } from "react";

/** Translated strings for the table card and code/diagram copy buttons markdown draws. */
export function MarkdownChrome({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const copy = useMemo<MarkdownCopy>(
    () => ({
      copied: t`Copied`,
      copyCode: t`Copy code`,
      copyDiagramSource: t`Copy diagram source`,
      expandCode: t`Expand code`,
      collapseCode: t`Collapse code`,
      table: t`Table`,
      markdownTable: t`Markdown table`,
      noRows: t`No rows`,
      previousPage: t`Previous page`,
      nextPage: t`Next page`,
      copyRows: t`Copy rows`,
      downloadCsv: t`Download CSV`,
      expandTable: t`Expand table`,
      closeTable: t`Close table`,
      zoomIn: t`Zoom in`,
      zoomOut: t`Zoom out`,
      fitWidth: t`Fit to width`,
      sortCleared: t`Sort cleared`,
      pageOf: (page, count) => t`Page ${page} of ${count}`,
      rowCount: (count) => t`${plural(count, { one: "# row", other: "# rows" })}`,
      rowRange: (from, to, total) => t`${from}–${to} of ${total} rows`,
      columnFallback: (index) => t`column ${index}`,
      columnDuplicate: (header, index) => t`${header}, column ${index}`,
      columnCollision: (label) => t`${label}, empty`,
      sortBy: (column) => t`Sort by ${column}`,
      sortedBy: (column, direction) =>
        direction === "asc"
          ? t`Sorted by ${column}, ascending`
          : t`Sorted by ${column}, descending`,
      resetZoom: (percent) => t`Reset zoom, ${percent}%`,
      openTicket: t`Open ticket`,
      ticketStatus: (status) => {
        switch (status) {
          case "todo":
            return t`To do`;
          case "doing":
            return t`In progress`;
          case "review":
            return t`Review`;
          case "blocked":
            return t`Blocked`;
          case "done":
            return t`Done`;
          case "closed":
            return t`Closed`;
          default:
            return status;
        }
      },
      ticketPriority: (priority) => {
        switch (priority) {
          case "low":
            return t`Low`;
          case "high":
            return t`High`;
          case "urgent":
            return t`Urgent`;
          default:
            return priority;
        }
      },
      pullRequestCount: (count) => t`${plural(count, { one: "# PR", other: "# PRs" })}`,
      pullRequestTitle: (number) => t`Pull request #${number}`,
      pullRequestState: (state) => {
        switch (state) {
          case "open":
            return t`Open`;
          case "merged":
            return t`Merged`;
          case "closed":
            return t`Closed`;
          default:
            return state;
        }
      },
      commitTitle: t`Commit`,
      recommended: t`Recommended`,
      decided: (label) => t`Decided: ${label}`,
    }),
    [t],
  );
  return <MarkdownCopyProvider copy={copy}>{children}</MarkdownCopyProvider>;
}
