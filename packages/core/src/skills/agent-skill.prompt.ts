import type { SkillCatalogEntry } from "./agent-skill.js";

const SKILL_INDEX_MAX_CHARS = 2_500;
const SKILL_INDEX_DESCRIPTION_MAX_CHARS = 90;
/** Room kept on the last line for names that no longer fit with their description. */
const SKILL_INDEX_TAIL_RESERVE_CHARS = 48;
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

function catalogDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SKILL_INDEX_DESCRIPTION_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, SKILL_INDEX_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * One `- Name: description` line per skill within a character budget. Entries that no longer fit
 * with their description fall back to a trailing comma-separated name list, then to the count of
 * skills left out, so a large catalog still says what exists without crowding out the descriptions.
 */
function formatBoundedSkillCatalog(
  label: string,
  entries: readonly { name: string; description: string }[],
  budgetChars: number,
): string | undefined {
  const sorted = entries
    .map((entry) => ({
      name: entry.name.trim(),
      description: catalogDescription(entry.description),
    }))
    .filter((entry) => entry.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const unique = sorted.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
  if (unique.length === 0) return undefined;

  const header = `${label} (${unique.length}):`;
  const lines = [header];
  let used = header.length;
  let listed = 0;
  for (const entry of unique) {
    const line = `- ${entry.name}${entry.description ? `: ${entry.description}` : ""}`;
    if (listed > 0 && used + line.length + SKILL_INDEX_TAIL_RESERVE_CHARS > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
    listed += 1;
  }
  const names: string[] = [];
  for (const entry of unique.slice(listed)) {
    const addition = names.length === 0 ? entry.name : `, ${entry.name}`;
    if (used + addition.length + SKILL_INDEX_TAIL_RESERVE_CHARS > budgetChars) break;
    names.push(entry.name);
    used += addition.length;
  }
  const omitted = unique.length - listed - names.length;
  const suffix = omitted > 0 ? ` (+${omitted} more — search with skill_mode)` : "";
  if (names.length > 0) lines.push(`${names.join(", ")}${suffix}`);
  else if (suffix) lines.push(suffix.trim());
  return lines.join("\n");
}

/**
 * Compact, cache-stable skill index and usage instructions for Skill Mode.
 * Lists sorted skill descriptions up to a character budget; bots load full recipes on demand via skill_mode.
 */
export function formatSkillModeCatalogInstruction(
  entries: readonly Pick<SkillCatalogEntry, "name" | "source" | "description">[],
  taught: readonly { name: string; whenToUse: string }[] = [],
): string | undefined {
  const agentLine = formatBoundedSkillCatalog(
    "Available skills",
    entries.map((entry) => ({ name: entry.name, description: entry.description })),
    taught.length > 0 ? Math.floor(SKILL_INDEX_MAX_CHARS * 0.7) : SKILL_INDEX_MAX_CHARS,
  );
  const taughtLine = formatBoundedSkillCatalog(
    "Taught skills",
    taught.map((entry) => ({ name: entry.name, description: entry.whenToUse })),
    Math.floor(SKILL_INDEX_MAX_CHARS * 0.3),
  );
  if (!agentLine && !taughtLine) return undefined;
  return [
    agentLine,
    taughtLine,
    "Skills are step-by-step recipes written for this Space. Before your first tool call on a task, check the list above: if a skill's description fits what you were asked, even partly, call skill_mode({ name }) first and follow it. Skip only for plain conversation that needs no tools. Unsure which? skill_mode({ query }) is cheap. skill_mode({ list: true }) browses descriptions.",
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
    "Load these with skill_mode({ name }) before acting unless clearly unrelated:",
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
