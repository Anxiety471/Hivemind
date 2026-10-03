import type { HostToolExposure } from "./api.ts";

export const HOST_CATEGORY_ORDER: HostToolExposure["category"][] = [
  "memory",
  "workspace",
  "wakeup",
  "skills",
  "artifacts",
  "coordination",
];

export const HOST_CATEGORY_TITLES: Record<HostToolExposure["category"], string> = {
  memory: "Memory",
  workspace: "Workspace",
  wakeup: "Wakeup",
  skills: "Skills",
  artifacts: "Library",
  coordination: "Coordination",
};

export type HostToolGroup = {
  category: string;
  title: string;
  tools: HostToolExposure[];
};

/** Groups host tools into ordered categories (Memory, Workspace, Wakeup, Skills, Library, Coordination). */
export function groupHostTools(hostTools: HostToolExposure[]): HostToolGroup[] {
  const groups: HostToolGroup[] = HOST_CATEGORY_ORDER.map((cat) => ({
    category: cat,
    title: HOST_CATEGORY_TITLES[cat] ?? cat,
    tools: hostTools.filter((t) => t.category === cat),
  })).filter((g) => g.tools.length > 0);

  const otherTools = hostTools.filter((t) => !HOST_CATEGORY_ORDER.includes(t.category));
  if (otherTools.length > 0) {
    groups.push({
      category: "other",
      title: "Other",
      tools: otherTools,
    });
  }

  return groups;
}

/** Formats the slash command invocation for a skill. */
export function formatSkillCommand(skill: { name: string; argument_hint?: string }): string {
  const hint = skill.argument_hint?.trim();
  return hint ? `/skill:${skill.name} ${hint}` : `/skill:${skill.name}`;
}

/** Describes the security status badge tone and label. */
export function authStatusBadge(restricted: boolean): { label: string; tone: "warn" | "ok" } {
  return restricted
    ? { label: "Restricted (deny-by-default)", tone: "warn" }
    : { label: "Unrestricted", tone: "ok" };
}

/** Describes the sandbox control badge tone and label. */
export function sandboxStatus(
  control: "file_editing" | "shell_execution" | "web_access",
  allowed: boolean,
): { label: string; tone: "ok" | "muted" } {
  switch (control) {
    case "file_editing":
      return allowed
        ? { label: "Allowed", tone: "ok" }
        : { label: "Denied (read-only)", tone: "muted" };
    case "shell_execution":
      return allowed
        ? { label: "Allowed", tone: "ok" }
        : { label: "Denied", tone: "muted" };
    case "web_access":
      return allowed
        ? { label: "Enabled", tone: "ok" }
        : { label: "Disabled", tone: "muted" };
  }
}

/** Describes the workspace badge tone and label. */
export function workspaceBadge(isShared: boolean): { label: string; tone: "info" | "muted" } {
  return isShared
    ? { label: "Group-shared workspace", tone: "info" }
    : { label: "Agent-private workspace", tone: "muted" };
}
