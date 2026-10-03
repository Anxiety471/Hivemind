// Pure helpers behind the Issues view: Linear-style status groups, short
// identifiers, and the parent → child tree that tasks form.
import type { PlanTask, TaskStatus } from "./api";

export type StatusGroup = {
  key: string;
  label: string;
  statuses: TaskStatus[];
};

/** Board columns and list sections, in display order. */
export const STATUS_GROUPS: StatusGroup[] = [
  { key: "attention", label: "Needs attention", statuses: ["needs_input", "blocked", "failed"] },
  { key: "review", label: "In Review", statuses: ["review"] },
  { key: "progress", label: "In Progress", statuses: ["running"] },
  { key: "todo", label: "Todo", statuses: ["planning", "ready"] },
  { key: "backlog", label: "Backlog", statuses: ["submitted"] },
  { key: "done", label: "Done", statuses: ["completed"] },
  { key: "canceled", label: "Canceled", statuses: ["cancelled"] },
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  submitted: "Backlog",
  planning: "Planning",
  ready: "Todo",
  running: "In Progress",
  review: "In Review",
  completed: "Done",
  blocked: "Blocked",
  needs_input: "Needs input",
  failed: "Failed",
  cancelled: "Canceled",
};

export function groupOf(status: TaskStatus): StatusGroup {
  return STATUS_GROUPS.find((g) => g.statuses.includes(status)) ?? STATUS_GROUPS[STATUS_GROUPS.length - 1];
}

export const isClosed = (status: TaskStatus) => status === "completed" || status === "cancelled" || status === "failed";

/** A short, stable, human-friendly identifier such as `HM-4K2Q`. */
export function issueKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `HM-${hash.toString(36).toUpperCase().padStart(4, "0").slice(-4)}`;
}

type Node = { id: string; parent_id: string | null };

/** Children by parent id, each list in the order given. */
export function childrenIndex<T extends Node>(tasks: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const task of tasks) {
    if (!task.parent_id) continue;
    const list = index.get(task.parent_id);
    if (list) list.push(task);
    else index.set(task.parent_id, [task]);
  }
  return index;
}

/** Every task below `id`, at any depth. */
export function descendants<T extends Node>(id: string, index: Map<string, T[]>): T[] {
  const out: T[] = [];
  const stack = [...(index.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const next = stack.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next);
    stack.push(...(index.get(next.id) ?? []));
  }
  return out;
}

/** Completed / total sub-issues below `id`, at any depth. */
export function subProgress<T extends Node & { status: TaskStatus }>(id: string, index: Map<string, T[]>) {
  const all = descendants(id, index).filter((t) => t.status !== "cancelled");
  return { done: all.filter((t) => t.status === "completed").length, total: all.length };
}

/** Ancestors of `id`, root first. */
export function ancestry<T extends Node>(id: string, byId: Map<string, T>): T[] {
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(id)?.parent_id ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) break;
    chain.unshift(parent);
    current = parent.parent_id;
  }
  return chain;
}

/** Case-insensitive match against title, key, and people. */
export function matches(
  task: { id: string; objective: string; owner: string | null; reviewer: string | null; coordinator?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [task.objective, issueKey(task.id), task.id, task.owner ?? "", task.reviewer ?? "", task.coordinator ?? ""].some(
    (field) => field.toLowerCase().includes(q),
  );
}

/** One drafted sub-issue in the new-issue modal: a title and how far it is indented. */
export type DraftRow = { title: string; depth: number };

/** Deepest indent the modal offers (the root is 0, its sub-issues are depth 0 rows). */
export const MAX_DRAFT_DEPTH = 4;

/** Indent or outdent row `index`: never deeper than one below the row above it. */
export function indentRow(rows: DraftRow[], index: number, delta: 1 | -1): DraftRow[] {
  const above = index > 0 ? rows[index - 1].depth : -1;
  const depth = Math.max(0, Math.min(rows[index].depth + delta, above + 1, MAX_DRAFT_DEPTH));
  const shift = depth - rows[index].depth;
  if (!shift) return rows;
  // Children move with their parent.
  const out = rows.map((r) => ({ ...r }));
  out[index].depth = depth;
  for (let i = index + 1; i < out.length && rows[i].depth > rows[index].depth; i++) {
    out[i].depth = Math.max(0, Math.min(out[i].depth + shift, MAX_DRAFT_DEPTH));
  }
  return out;
}

/**
 * Turn drafted rows into a plan whose `parent` keys nest each row under the
 * nearest shallower row above it. Blank rows are dropped and their children
 * move up rather than losing their place.
 */
export function draftPlan(rows: DraftRow[]): PlanTask[] {
  const plan: PlanTask[] = [];
  const stack: { depth: number; key: string }[] = [];
  for (const row of rows) {
    const title = row.title.trim();
    if (!title) continue;
    while (stack.length && stack[stack.length - 1].depth >= row.depth) stack.pop();
    const key = `sub-${plan.length + 1}`;
    const parent = stack[stack.length - 1]?.key;
    plan.push({ key, objective: title, acceptance: [title], ...(parent ? { parent } : {}) });
    stack.push({ depth: row.depth, key });
  }
  return plan;
}
