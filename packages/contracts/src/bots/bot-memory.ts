import * as z from "zod";
import { Id, MemoryScope } from "../ids.js";

/** The heading seeded when a bot is created, before it has learned anything. */
export function initialBotMemory(name: string): string {
  return `# ${name}\n\n`;
}

export function isEmptyBotMemory(doc: Pick<MemoryDocument, "path" | "content">): boolean {
  if (!doc.content.trim()) return true;
  if (doc.path !== MEMORY_INDEX_PATH) return false;
  // Match the seed's complete shape, including its trailing blank line. The bot
  // may have been renamed since creation, so its current name is not a baseline.
  const heading = doc.content.split("\n")[0] ?? "";
  return heading.startsWith("# ") && doc.content === initialBotMemory(heading.slice(2));
}

export const MemoryScopeSchema = z.enum(["isolated", "shared"]);

export const MemoryDocumentSchema = z.object({
  id: Id,
  scope: MemoryScope,
  botId: Id.nullable(),
  path: z.string(),
  content: z.string(),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

/** Which of a bot's memory documents reach the prompt, and what did not fit. */
export const MemoryPromptDocumentUseSchema = z.object({
  scope: MemoryScope,
  path: z.string(),
  revision: z.number().int(),
  totalBytes: z.number().int().nonnegative(),
  includedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type MemoryPromptDocumentUse = z.infer<typeof MemoryPromptDocumentUseSchema>;

export const MemoryPromptBudgetSchema = z.object({
  limitBytes: z.number().int().positive(),
  usedBytes: z.number().int().nonnegative(),
  documents: z.array(MemoryPromptDocumentUseSchema),
  omitted: z.array(MemoryPromptDocumentUseSchema),
});
export type MemoryPromptBudget = z.infer<typeof MemoryPromptBudgetSchema>;

/** The memory roamer's default interval, in minutes. */
export const MEMORY_ROAMER_DEFAULT_INTERVAL = 360;

/** One bot or Space that did not finish the last roamer pass. */
export const MemoryRoamerFailureSchema = z.object({
  kind: z.enum(["bot", "shared"]),
  id: z.string(),
  name: z.string(),
  error: z.string(),
});
export type MemoryRoamerFailure = z.infer<typeof MemoryRoamerFailureSchema>;

export const MemoryRoamerFailuresSchema = z.array(MemoryRoamerFailureSchema).max(50);

/** One document change in a roamer run. */
export const MemoryRoamerChangeSchema = z.object({
  scope: z.enum(["bot", "user"]),
  path: z.string(),
  action: z.string(),
  beforeBytes: z.number().int().nonnegative(),
  afterBytes: z.number().int().nonnegative(),
  created: z.boolean().optional(),
});

/** One bot or Space's result in the latest roamer run. */
export const MemoryRoamerTargetSchema = z.object({
  kind: z.enum(["bot", "shared"]),
  id: z.string(),
  name: z.string(),
  status: z.enum(["ok", "failed"]),
  error: z.string().optional(),
  model: z.string().optional(),
  changes: z.array(MemoryRoamerChangeSchema),
  checkedAt: z.string(),
});
export type MemoryRoamerTarget = z.infer<typeof MemoryRoamerTargetSchema>;

export const MemoryRoamerReportSchema = z.array(MemoryRoamerTargetSchema).max(200);

/** What the background roamer is doing, and how its last pass went. */
export const MemoryRoamerSettingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(10_080),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastChanges: z.number().int().nonnegative(),
  lastModel: z.string().nullable(),
  lastFailures: MemoryRoamerFailuresSchema,
  lastReport: MemoryRoamerReportSchema,
  retryAt: z.string().nullable(),
  retryAttempt: z.number().int().nonnegative(),
});
export type MemoryRoamerSettings = z.infer<typeof MemoryRoamerSettingsSchema>;

/** Every bot and Space keeps its MEMORY.md index; other memory documents can be deleted. */
export const MEMORY_INDEX_PATH = "MEMORY.md";
/** What a bot may write to its memory. People can still write more by hand. */
export const BOT_MEMORY_MAX_BYTES = 4 * 1024;
export function isDeletableMemoryDocument(path: string): boolean {
  return path !== MEMORY_INDEX_PATH;
}
