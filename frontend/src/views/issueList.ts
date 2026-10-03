import type { Task } from "../api.ts";

export type IssueView = "active" | "backlog" | "all" | "closed";
export const issueViews: { id: IssueView; label: string }[] = [
  { id: "active", label: "Active issues" },
  { id: "backlog", label: "Backlog" },
  { id: "all", label: "All issues" },
  { id: "closed", label: "Closed issues" },
];
export const issueGroups = ["In Review", "In Progress", "Todo", "Blocked", "Backlog", "Done", "Failed", "Cancelled"] as const;
export type IssueGroup = typeof issueGroups[number];
export const terminalIssue = (task: Task) => ["completed", "failed", "cancelled"].includes(task.status);

// These are views of the scheduler lifecycle, not an independently editable status.
export function issueGroup(task: Task): IssueGroup {
  if (task.status === "completed") return "Done";
  if (task.status === "failed") return "Failed";
  if (task.status === "cancelled") return "Cancelled";
  if (task.paused) return "Backlog";
  if (task.status === "review") return "In Review";
  if (["planning", "running"].includes(task.status)) return "In Progress";
  if (["blocked", "needs_input"].includes(task.status)) return "Blocked";
  return "Todo";
}

export function inIssueView(task: Task, view: IssueView) {
  if (view === "all") return true;
  if (view === "closed") return terminalIssue(task);
  if (view === "backlog") return !terminalIssue(task) && task.paused;
  return !terminalIssue(task) && !task.paused;
}

export function compareIssues(a: Task, b: Task) {
  const rank = { urgent: 3, high: 2, normal: 1, low: 0 };
  return rank[b.issue.priority] - rank[a.issue.priority] || b.updated_at - a.updated_at || b.issue.number - a.issue.number;
}
