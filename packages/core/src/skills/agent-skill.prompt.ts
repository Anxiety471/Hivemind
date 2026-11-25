import type { SkillCatalogEntry } from "./agent-skill.js";

const SKILL_INDEX_MAX_CHARS = 2_500;
const RELEVANT_HINT_DESCRIPTION_MAX_CHARS = 140;

export function skillCatalogLine(entry: Pick<SkillCatalogEntry, "name" | "description">): string {
  return `- ${entry.name}: ${entry.description}`;
}

export function formatSkillsCatalogInstruction(entries: SkillCatalogEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.map(skillCatalogLine).join("\n");
  return [
    "Available skills (reusable how-to recipes, not account-specific routines):",
    lines,
    "When a skill matches the user's request, call skill_read for that name and follow it immediately. Prefer matching skills over improvising multi-step recipes.",
    "Users can force a skill with /Name in the composer. Routines may mention a skill as @Name — that loads the skill at fire time.",
    "Create a skill with skill_create when a multi-step task is worth repeating (or when asked). After creating one, mention /Name so the user can open it.",
    "Only skill_update / skill_delete user-created skills (not builtin or plugin).",
  ].join("\n");
}

function formatBoundedSkillNameList(
  label: string,
  names: readonly string[],
  budgetChars: number,
): string | undefined {
  const uniqueSorted = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (uniqueSorted.length === 0) return undefined;
  const header = `${label} (${uniqueSorted.length}): `;
  const listed: string[] = [];
  let used = header.length;
  for (const name of uniqueSorted) {
    const addition = listed.length === 0 ? name : `, ${name}`;
    if (listed.length > 0 && used + addition.length + 48 > budgetChars) break;
    listed.push(name);
    used += addition.length;
  }
  const omitted = uniqueSorted.length - listed.length;
  const suffix = omitted > 0 ? ` (+${omitted} more — search with skill_mode)` : "";
  return `${header}${listed.join(", ")}${suffix}`;
}

/**
 * Compact, cache-stable skill index and usage instructions for Skill Mode.
 * Lists sorted skill names up to a character budget; bots load full recipes on demand via skill_mode.
 */
export function formatSkillModeCatalogInstruction(
  entries: readonly Pick<SkillCatalogEntry, "name" | "source">[],
  taughtNames: readonly string[] = [],
): string | undefined {
  const agentNames = entries.map((entry) => entry.name);
  const agentLine = formatBoundedSkillNameList(
    "Available skills",
    agentNames,
    taughtNames.length > 0 ? Math.floor(SKILL_INDEX_MAX_CHARS * 0.7) : SKILL_INDEX_MAX_CHARS,
  );
  const taughtLine = formatBoundedSkillNameList(
    "Taught skills",
    taughtNames,
    Math.floor(SKILL_INDEX_MAX_CHARS * 0.3),
  );
  if (!agentLine && !taughtLine) return undefined;
  return [
    agentLine,
    taughtLine,
    "Before starting a multi-step, domain-specific, or unfamiliar workflow, call skill_mode({ query }) to search for matching skills, or skill_mode({ name }) / skill_mode({ names }) to load skills by name (and file for attached reference files). Use skill_mode({ list: true }) to browse descriptions. Prefer matching skills over improvising multi-step recipes.",
    "Users can force a skill with /Name in the composer. Routines may mention a skill as @Name — that loads the skill at fire time.",
    "Create a skill with skill_create when a multi-step task is worth repeating (or when asked). After creating one, mention /Name so the user can open it.",
    "Only skill_update / skill_delete user-created skills (not builtin or plugin).",
  ]
    .filter(Boolean)
    .join("\n");
}

function conciseHintDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length <= RELEVANT_HINT_DESCRIPTION_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, RELEVANT_HINT_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Per-turn hint naming high-confidence skill matches for the current request.
 * Kept outside the static system prompt so prompt caching stays intact.
 */
export function formatRelevantSkillsHint(
  matches: readonly {
    name: string;
    source: string;
    description: string;
    matchedHeading?: string;
  }[],
): string | undefined {
  if (matches.length === 0) return undefined;
  const lines = matches.map((match) => {
    const desc = conciseHintDescription(match.description);
    const heading = match.matchedHeading?.trim()
      ? ` (matched: ${JSON.stringify(match.matchedHeading.trim())})`
      : "";
    return `- ${match.name} [${match.source}]: ${desc}${heading}`;
  });
  return [
    "<relevant_skills>",
    "Matched skills for this request — call skill_mode to load any that apply before acting (skip only if clearly unrelated):",
    ...lines,
    "</relevant_skills>",
  ].join("\n");
}

export function formatForcedSkillPrompt(name: string, content: string, rest?: string): string {
  const parts = [`Use skill: ${name}`, "", content.trim()];
  const trailing = rest?.trim();
  if (trailing) parts.push("", trailing);
  return parts.join("\n");
}
