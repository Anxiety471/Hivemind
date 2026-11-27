import type { SkillRecord, SkillSource } from "@rakazo/core";
import {
  buildSkillMd,
  findSkillByName,
  formatSkillRunPrompt,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { parsePlaybook } from "../bots/teaching-session.js";
import {
  BOARD_SKILL_NAME,
  BUILTIN_AGENT_SKILLS,
  COMPUTER_SKILL_NAME,
  DOCUMENTS_SKILL_NAME,
  HISTORY_SKILL_NAME,
  ROUTINES_SKILL_NAME,
  SUBAGENTS_SKILL_NAME,
} from "./builtin-skills.prompt.js";
import {
  SKILL_MODE,
  SKILL_MODE_DEFAULT_LIMIT,
  SKILL_MODE_MAX_BATCH_NAMES,
} from "./skill-mode.tool-definition.js";
import type { SearchableSkill, SearchableSkillSource } from "./skill-search.js";
import { searchSkills } from "./skill-search.js";

export const SKILL_TOOL_NAMES = new Set([
  SKILL_MODE,
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
]);

/** Match CreateAgentSkillInput / UpdateAgentSkillInput / parseSkillMd bounds. */
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_DESCRIPTION_CHARS = 2000;

type SkillOwner = {
  spaceId: string;
  userId: string;
};

type AgentSkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
};

function asSource(value: string): SkillSource {
  if (value === "builtin" || value === "plugin" || value === "user") return value;
  return "user";
}

function toRecord(row: AgentSkillRow): SkillRecord & { id: string } {
  const source = asSource(row.source);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source),
  };
}

export function builtinAgentSkillRecords(): Array<SkillRecord & { id: string }> {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
  }));
}

function rejectOversizedContent(content: string): string | undefined {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `Skill content must be at most ${MAX_SKILL_CONTENT_CHARS} characters.`;
  }
  return undefined;
}

function rejectInvalidSkillFields(name: string, description: string): string | undefined {
  if (!name) return "Skill name is required.";
  if (!description) return "Skill description is required.";
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return `Skill name must be at most ${MAX_SKILL_NAME_CHARS} characters.`;
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return `Skill description must be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`;
  }
  return undefined;
}

/**
 * A bot changes only skills that live in its own space alone: writing this space's details into
 * a skill other spaces read would carry them across the boundary.
 */
function onlyInSpace(owner: SkillOwner) {
  return {
    spaceId: owner.spaceId,
    userId: owner.userId,
    allSpaces: false,
    availableIn: { none: {} },
  };
}

const SHARED_SKILL_ERROR =
  "Could not change this skill. A skill available in other spaces can only be changed by the user.";

export async function listAgentSkillRecords(
  prisma: PrismaClient,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const rows = await prisma.agentSkill.findMany({
    where: availableInSpace(owner),
    // Reference files are read one at a time through skill_read, never with the catalog.
    omit: { files: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return mergeBuiltinSkills(builtinAgentSkillRecords(), rows.map(toRecord));
}

async function findOwnedSkill(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { skillId?: string; name?: string },
): Promise<(SkillRecord & { id: string }) | null> {
  const skills = await listAgentSkillRecords(prisma, owner);
  if (input.skillId) {
    return skills.find((skill) => skill.id === input.skillId) ?? null;
  }
  if (input.name) return findSkillByName(skills, input.name) ?? null;
  return null;
}

/** The text files stored beside a skill's SKILL.md, keyed by relative path. */
export function skillFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function skillReadFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string; file?: string },
): Promise<Record<string, unknown>> {
  const skill = await findOwnedSkill(prisma, owner, input);
  if (!skill) return { error: "Skill not found." };
  const row = skill.id.startsWith("builtin:")
    ? null
    : await prisma.agentSkill.findFirst({
        where: { id: skill.id, ...availableInSpace(owner) },
        select: { files: true },
      });
  const files = skillFiles(row?.files);
  const paths = Object.keys(files).sort();
  const wanted = input.file?.trim().replace(/^\.\//, "");
  if (wanted) {
    // Only exact stored paths resolve, so no path can reach outside the skill.
    const text = files[wanted];
    if (text === undefined) return { error: `No file "${wanted}" in this skill.`, files: paths };
    return { name: skill.name, file: wanted, content: text };
  }
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    readOnly: skill.readOnly,
    content: skill.content,
    ...(paths.length ? { files: paths } : {}),
  };
}

export async function skillCreateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; description?: string; body?: string; content?: string },
): Promise<Record<string, unknown>> {
  let name = "";
  let description = "";
  let content = "";
  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    name = parsed.name;
    description = parsed.description;
    content = buildSkillMd(parsed);
  } else {
    name = String(input.name ?? "").trim();
    description = String(input.description ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!name || !description) {
      return {
        error: "Provide name and description (and optional body), or full SKILL.md content.",
      };
    }
    const invalid = rejectInvalidSkillFields(name, description);
    if (invalid) return { error: invalid };
    content = buildSkillMd({ name, description, body });
  }

  const oversized = rejectOversizedContent(content);
  if (oversized) return { error: oversized };

  const existing = await findOwnedSkill(prisma, owner, { name });
  if (existing) return { error: `A skill named "${existing.name}" already exists.` };

  try {
    const row = await prisma.agentSkill.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name,
        description,
        content,
        source: "user",
      },
    });
    return {
      ok: true,
      id: row.id,
      name: row.name,
      description: row.description,
      hint: `Created skill. Mention /${row.name} so the user can open it.`,
    };
  } catch {
    return { error: "Could not create skill (name may already exist)." };
  }
}

export async function skillUpdateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: {
    name?: string;
    skillId?: string;
    newName?: string;
    description?: string;
    body?: string;
    content?: string;
  },
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(prisma, owner, {
    skillId: input.skillId,
    name: input.name,
  });
  if (!existing) return { error: "Skill not found." };
  if (existing.readOnly || existing.source !== "user" || existing.id.startsWith("builtin:")) {
    return { error: "Builtin and plugin skills are read-only." };
  }

  let nextContent = existing.content;
  let nextName = existing.name;
  let nextDescription = existing.description;

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    nextName = parsed.name;
    nextDescription = parsed.description;
    nextContent = buildSkillMd(parsed);
  } else {
    const prior = parseSkillMd(existing.content);
    if ("error" in prior) return { error: prior.error };
    // `name` is only a lookup key (see findOwnedSkill above); renames require `newName`.
    nextName = String(input.newName ?? existing.name).trim() || existing.name;
    nextDescription =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    const body = input.body !== undefined ? String(input.body) : prior.body;
    const invalidFields = rejectInvalidSkillFields(nextName, nextDescription);
    if (invalidFields) return { error: invalidFields };
    nextContent = buildSkillMd({
      name: nextName,
      description: nextDescription,
      body,
      frontmatter: prior.frontmatter,
    });
  }

  const invalid = rejectInvalidSkillFields(nextName, nextDescription);
  if (invalid) return { error: invalid };
  const oversized = rejectOversizedContent(nextContent);
  if (oversized) return { error: oversized };

  if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await findOwnedSkill(prisma, owner, { name: nextName });
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  try {
    // Re-scope mutate to owner + user source so a stale id cannot cross tenants.
    const updated = await prisma.agentSkill.updateMany({
      where: { id: existing.id, ...onlyInSpace(owner), source: "user" },
      data: {
        name: nextName,
        description: nextDescription,
        content: nextContent,
      },
    });
    if (updated.count !== 1) return { error: SHARED_SKILL_ERROR };
    return { ok: true, id: existing.id, name: nextName, description: nextDescription };
  } catch {
    return { error: "Could not update skill." };
  }
}

export async function skillDeleteFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(prisma, owner, input);
  if (!existing) return { error: "Skill not found." };
  if (existing.readOnly || existing.source !== "user" || existing.id.startsWith("builtin:")) {
    return { error: "Builtin and plugin skills are read-only." };
  }
  const deleted = await prisma.agentSkill.deleteMany({
    where: { id: existing.id, ...onlyInSpace(owner), source: "user" },
  });
  if (deleted.count !== 1) return { error: SHARED_SKILL_ERROR };
  return { ok: true, name: existing.name };
}

export type TaughtSkillSummaryRow = {
  id: string;
  name: string;
  goal: string;
  userId: string;
  playbook: unknown;
};

/**
 * Filter built-in/user/plugin skills to the ones whose prerequisites exist in this run.
 * Shared by prompt assembly and `skill_mode` so both see the same skill catalog.
 */
export function filterRunAgentSkills<T extends SkillRecord & { id?: string }>(
  agentSkills: readonly T[],
  offeredToolNames: ReadonlySet<string>,
  nonOwnerChatRun: boolean,
): T[] {
  const boardOffered = offeredToolNames.has("ticket_update");
  const historyOffered = offeredToolNames.has("search_history");
  const routinesOffered =
    offeredToolNames.has("schedule_create") && offeredToolNames.has("command_save");
  const computerOffered =
    offeredToolNames.has("shell") ||
    offeredToolNames.has("browser_navigate") ||
    offeredToolNames.has("computer_observe") ||
    offeredToolNames.has("read_file");
  const subagentsOffered = offeredToolNames.has("run_subagent");
  const base = nonOwnerChatRun ? (builtinAgentSkillRecords() as unknown as T[]) : [...agentSkills];
  return base.filter(
    (skill) =>
      skill.source !== "builtin" ||
      ((boardOffered || skill.name !== BOARD_SKILL_NAME) &&
        (historyOffered || skill.name !== HISTORY_SKILL_NAME) &&
        (routinesOffered || skill.name !== ROUTINES_SKILL_NAME) &&
        (computerOffered || skill.name !== COMPUTER_SKILL_NAME) &&
        (computerOffered || skill.name !== DOCUMENTS_SKILL_NAME) &&
        (subagentsOffered || skill.name !== SUBAGENTS_SKILL_NAME)),
  );
}

/** Taught skills visible to a run, honoring owner/messaging boundaries. */
export function filterRunTaughtSkills<T extends { userId: string }>(
  savedSkills: readonly T[],
  options: { ownerStartedRun: boolean; userId: string; nonOwnerChatRun: boolean },
): T[] {
  if (options.nonOwnerChatRun) return [];
  return savedSkills.filter((skill) => options.ownerStartedRun || skill.userId === options.userId);
}

/** Render a saved taught skill into the markdown playbook format bots follow. */
export function formatTaughtSkillContent(skill: TaughtSkillSummaryRow): {
  name: string;
  whenToUse: string;
  content: string;
} {
  const name = skill.name || skill.goal.slice(0, 80);
  const playbook = parsePlaybook(skill.playbook);
  const whenToUse = playbook.whenToUse || skill.goal;
  return {
    name,
    whenToUse,
    content: formatSkillRunPrompt(name, playbook),
  };
}

/** Convert scoped agent + taught skills into indexable search documents. */
export function buildSearchableSkills(
  agentSkills: readonly (SkillRecord & { id: string })[],
  taughtSkills: readonly TaughtSkillSummaryRow[] = [],
  filePathsById?: ReadonlyMap<string, readonly string[]>,
): SearchableSkill[] {
  const out: SearchableSkill[] = agentSkills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    readOnly: skill.readOnly,
    content: skill.content,
    ...(filePathsById?.get(skill.id)?.length ? { filePaths: filePathsById.get(skill.id) } : {}),
  }));
  const seenNames = new Set(out.map((entry) => entry.name.trim().toLowerCase()));
  for (const taught of taughtSkills) {
    const formatted = formatTaughtSkillContent(taught);
    if (!formatted.name.trim()) continue;
    // If an AgentSkill shares the same name, keep the AgentSkill first; still avoid duplicate exact names.
    if (seenNames.has(formatted.name.trim().toLowerCase())) continue;
    seenNames.add(formatted.name.trim().toLowerCase());
    out.push({
      id: `taught:${taught.id}`,
      name: formatted.name,
      description: formatted.whenToUse || taught.goal,
      source: "taught",
      readOnly: true,
      content: formatted.content,
      whenToUse: formatted.whenToUse,
    });
  }
  return out;
}

async function loadSkillFileMap(
  prisma: PrismaClient,
  owner: SkillOwner,
  skillIds: readonly string[],
): Promise<Map<string, Record<string, string>>> {
  const map = new Map<string, Record<string, string>>();
  const nonBuiltinIds = skillIds.filter(
    (id) => !id.startsWith("builtin:") && !id.startsWith("taught:"),
  );
  if (nonBuiltinIds.length === 0) return map;
  const rows = await prisma.agentSkill.findMany({
    where: { id: { in: nonBuiltinIds }, ...availableInSpace(owner) },
    select: { id: true, files: true },
  });
  for (const row of rows as Array<{ id?: string; files?: unknown }>) {
    if (!row.id) continue;
    const files = skillFiles(row.files);
    if (Object.keys(files).length > 0) map.set(row.id, files);
  }
  return map;
}

async function loadAllFilePathsById(
  prisma: PrismaClient,
  owner: SkillOwner,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const rows = await prisma.agentSkill.findMany({
    where: availableInSpace(owner),
    select: { id: true, files: true },
  });
  for (const row of rows as Array<{ id?: string; files?: unknown }>) {
    if (!row.id) continue;
    const paths = Object.keys(skillFiles(row.files)).sort();
    if (paths.length > 0) map.set(row.id, paths);
  }
  return map;
}

function asSearchSource(value: unknown): SearchableSkillSource | undefined {
  if (value === "builtin" || value === "user" || value === "plugin" || value === "taught") {
    return value;
  }
  return undefined;
}

export async function skillModeFromTool(
  prisma: PrismaClient,
  scope: SkillOwner & {
    botId?: string;
    ownerStartedRun?: boolean;
    nonOwnerChatRun?: boolean;
    offeredToolNames?: ReadonlySet<string>;
  },
  input: {
    query?: string;
    name?: string;
    names?: readonly string[];
    file?: string;
    list?: boolean;
    source?: string;
    limit?: number;
  },
): Promise<Record<string, unknown>> {
  const nonOwnerChatRun = Boolean(scope.nonOwnerChatRun);
  const ownerStartedRun = scope.ownerStartedRun ?? true;
  const rawAgentSkills = nonOwnerChatRun
    ? builtinAgentSkillRecords()
    : await listAgentSkillRecords(prisma, scope);
  const agentSkills = scope.offeredToolNames
    ? filterRunAgentSkills(rawAgentSkills, scope.offeredToolNames, nonOwnerChatRun)
    : rawAgentSkills;

  const rawTaughtSkills =
    !nonOwnerChatRun && scope.botId && prisma.taughtSkill?.findMany
      ? await prisma.taughtSkill.findMany({
          where: { botId: scope.botId, spaceId: scope.spaceId, status: "saved" },
        })
      : [];
  const taughtSkills = filterRunTaughtSkills(rawTaughtSkills, {
    ownerStartedRun,
    userId: scope.userId,
    nonOwnerChatRun,
  });

  const filePathsById = !nonOwnerChatRun
    ? await loadAllFilePathsById(prisma, scope).catch(() => new Map<string, string[]>())
    : undefined;
  const searchable = buildSearchableSkills(agentSkills, taughtSkills, filePathsById);
  const sourceFilter = asSearchSource(input.source);

  const batchNames = Array.isArray(input.names)
    ? input.names
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, SKILL_MODE_MAX_BATCH_NAMES)
    : [];

  if (batchNames.length > 0) {
    const found: SearchableSkill[] = [];
    const notFound: string[] = [];
    for (const target of batchNames) {
      const matched = findSkillByName(searchable, target);
      if (matched) found.push(matched);
      else notFound.push(target);
    }
    const filesMap = await loadSkillFileMap(
      prisma,
      scope,
      found.map((skill) => skill.id),
    );
    const loadedNames = found.map((skill) => skill.name);
    return {
      skills: found.map((skill) => {
        const paths = Object.keys(filesMap.get(skill.id) ?? {}).sort();
        return {
          name: skill.name,
          description: skill.description,
          source: skill.source,
          readOnly: skill.readOnly,
          content: skill.content,
          ...(paths.length > 0 ? { files: paths } : {}),
        };
      }),
      loaded: loadedNames,
      ...(notFound.length > 0 ? { notFound } : {}),
    };
  }

  const singleName = input.name?.trim();
  if (singleName) {
    const skill = findSkillByName(searchable, singleName);
    if (!skill) {
      const suggestions = searchSkills(searchable, singleName, { limit: 3 }).hits.map((hit) => ({
        name: hit.skill.name,
        source: hit.skill.source,
        description: hit.skill.description,
      }));
      return {
        error: `Skill "${singleName}" not found.`,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      };
    }
    const filesMap = await loadSkillFileMap(prisma, scope, [skill.id]);
    const files = filesMap.get(skill.id) ?? {};
    const paths = Object.keys(files).sort();
    const wanted = input.file?.trim().replace(/^\.\//, "");
    if (wanted) {
      const text = files[wanted];
      if (text === undefined) {
        return { error: `No file "${wanted}" in this skill.`, files: paths };
      }
      return {
        name: skill.name,
        source: skill.source,
        file: wanted,
        content: text,
        loaded: [skill.name],
      };
    }
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      readOnly: skill.readOnly,
      content: skill.content,
      ...(paths.length > 0 ? { files: paths } : {}),
      loaded: [skill.name],
    };
  }

  const query = input.query?.trim();
  if (query) {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? input.limit
        : SKILL_MODE_DEFAULT_LIMIT;
    const result = searchSkills(searchable, query, {
      limit,
      ...(sourceFilter ? { source: sourceFilter } : {}),
    });
    const autoSkill = result.autoExpand?.skill;
    const filesMap = autoSkill ? await loadSkillFileMap(prisma, scope, [autoSkill.id]) : undefined;
    const autoPaths = autoSkill ? Object.keys(filesMap?.get(autoSkill.id) ?? {}).sort() : [];
    return {
      query,
      totalSkills: sourceFilter
        ? searchable.filter((skill) => skill.source === sourceFilter).length
        : searchable.length,
      results: result.hits.map((hit) => ({
        name: hit.skill.name,
        source: hit.skill.source,
        description: hit.skill.description,
        score: hit.score,
        matchedIn: hit.matchedIn,
        ...(hit.matchedHeading ? { matchedHeading: hit.matchedHeading } : {}),
        ...(hit.snippet ? { snippet: hit.snippet } : {}),
        ...(hit.skill.filePaths?.length ? { files: hit.skill.filePaths } : {}),
      })),
      ...(autoSkill
        ? {
            autoLoaded: {
              name: autoSkill.name,
              description: autoSkill.description,
              source: autoSkill.source,
              readOnly: autoSkill.readOnly,
              content: autoSkill.content,
              ...(autoPaths.length > 0 ? { files: autoPaths } : {}),
            },
            loaded: [autoSkill.name],
          }
        : {}),
      ...(result.hits.length === 0
        ? { hint: "No matching skills found. Try broader keywords or skill_mode({ list: true })." }
        : {}),
    };
  }

  const listed = sourceFilter
    ? searchable.filter((skill) => skill.source === sourceFilter)
    : searchable;
  return {
    totalSkills: listed.length,
    skills: listed.map((skill) => ({
      name: skill.name,
      source: skill.source,
      description: skill.description,
      ...(skill.filePaths?.length ? { files: skill.filePaths } : {}),
    })),
  };
}
