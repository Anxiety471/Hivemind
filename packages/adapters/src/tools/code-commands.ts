import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import { compileConnectorToolArgsSchema } from "./lazy-tool-catalog.js";

/** A saved command is called as `codemode.cmd.<name>(args)`; the host sees `cmd.<name>`. */
export const CODE_COMMAND_PREFIX = "cmd.";
export const CODE_COMMAND_MAX_CODE_CHARS = 20_000;
/** Search reads every command's name and description, so the table is bounded, not paged. */
export const CODE_COMMAND_MAX_COUNT = 500;
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const ICON_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const DESCRIPTION_MAX_CHARS = 300;
const PARAMETERS_MAX_CHARS = 4_000;

const ParametersSchema = z.record(z.string(), z.json());

export interface CodeCommandSummary {
  name: string;
  description: string;
  /** The Lucide icon the UI shows for it, by kebab-case name; absent for the default. */
  icon?: string;
  /** JSON Schema for `args`; absent when the command takes none. */
  parameters?: z.infer<typeof ParametersSchema>;
}

export interface CodeCommandInput extends CodeCommandSummary {
  code: string;
}

/** Checks a model-supplied command; the message goes back to the model as the tool's error. */
export function parseCodeCommandInput(
  args: Record<string, unknown>,
): { command: CodeCommandInput } | { error: string } {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!NAME_PATTERN.test(name)) {
    return {
      error:
        "name must start with a lowercase letter and use only lowercase letters, digits and underscores (at most 48 characters). Call it as codemode.cmd.<name>.",
    };
  }
  const description = typeof args.description === "string" ? args.description.trim() : "";
  if (!description || description.length > DESCRIPTION_MAX_CHARS) {
    return {
      error: `description must say what the command does, in at most ${DESCRIPTION_MAX_CHARS} characters.`,
    };
  }
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim() || code.length > CODE_COMMAND_MAX_CODE_CHARS) {
    return {
      error: `code must be the TypeScript body of an async function, at most ${CODE_COMMAND_MAX_CODE_CHARS} characters.`,
    };
  }
  let icon: string | undefined;
  if (args.icon !== undefined && args.icon !== null) {
    if (typeof args.icon !== "string" || !ICON_PATTERN.test(args.icon)) {
      return {
        error:
          'icon must be a Lucide icon name in lowercase with hyphens, such as "file-text", or left out.',
      };
    }
    icon = args.icon;
  }
  const base = { name, description, code, ...(icon ? { icon } : {}) };
  if (args.parameters === undefined || args.parameters === null) return { command: base };
  const parameters = ParametersSchema.safeParse(args.parameters);
  if (!parameters.success || JSON.stringify(parameters.data).length > PARAMETERS_MAX_CHARS) {
    return {
      error: `parameters must be a JSON Schema object of at most ${PARAMETERS_MAX_CHARS} characters.`,
    };
  }
  return { command: { ...base, parameters: parameters.data } };
}

function summary(row: {
  name: string;
  description: string;
  icon: string | null;
  parameters: unknown;
}): CodeCommandSummary {
  const parameters = ParametersSchema.safeParse(row.parameters);
  return {
    name: row.name,
    description: row.description,
    ...(row.icon ? { icon: row.icon } : {}),
    ...(parameters.success ? { parameters: parameters.data } : {}),
  };
}

export function validateCodeCommandParametersSchema(
  parameters: Record<string, unknown>,
): string | undefined {
  try {
    compileConnectorToolArgsSchema(parameters);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid JSON Schema in parameters.";
  }
}

export async function listCodeCommands(
  prisma: PrismaClient,
  spaceId: string,
): Promise<CodeCommandSummary[]> {
  const rows = await prisma.codeCommand.findMany({
    where: { spaceId },
    select: { name: true, description: true, icon: true, parameters: true },
    orderBy: { name: "asc" },
    take: CODE_COMMAND_MAX_COUNT,
  });
  return rows.map(summary);
}

export async function findCodeCommand(
  prisma: PrismaClient,
  spaceId: string,
  name: string,
): Promise<CodeCommandInput | undefined> {
  const row = await prisma.codeCommand.findUnique({
    where: { spaceId_name: { spaceId, name } },
    select: { name: true, description: true, icon: true, parameters: true, code: true },
  });
  return row ? { ...summary(row), code: row.code } : undefined;
}

/** Fetches multiple saved commands in a single query, keyed by command name. */
export async function findCodeCommands(
  prisma: PrismaClient,
  spaceId: string,
  names: readonly string[],
): Promise<Map<string, CodeCommandInput>> {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await prisma.codeCommand.findMany({
    where: { spaceId, name: { in: unique } },
    select: { name: true, description: true, icon: true, parameters: true, code: true },
  });
  return new Map(rows.map((row) => [row.name, { ...summary(row), code: row.code }]));
}

/** Creates the command or replaces the one with that name in this Space. */
export async function saveCodeCommand(
  prisma: PrismaClient,
  spaceId: string,
  command: CodeCommandInput,
  userId: string,
): Promise<{ updated: boolean } | { error: string }> {
  const existing = await prisma.codeCommand.findUnique({
    where: { spaceId_name: { spaceId, name: command.name } },
    select: { id: true },
  });
  if (
    !existing &&
    (await prisma.codeCommand.count({ where: { spaceId } })) >= CODE_COMMAND_MAX_COUNT
  ) {
    return {
      error: `There are already ${CODE_COMMAND_MAX_COUNT} saved commands; delete one first.`,
    };
  }
  const data = {
    description: command.description,
    icon: command.icon ?? null,
    parameters: command.parameters,
    code: command.code,
    updatedByUserId: userId,
  };
  await prisma.codeCommand.upsert({
    where: { spaceId_name: { spaceId, name: command.name } },
    create: { spaceId, name: command.name, ...data },
    update: { ...data, parameters: command.parameters ?? Prisma.JsonNull },
  });
  return { updated: Boolean(existing) };
}

export async function deleteCodeCommand(
  prisma: PrismaClient,
  spaceId: string,
  name: string,
): Promise<boolean> {
  const { count } = await prisma.codeCommand.deleteMany({ where: { spaceId, name } });
  return count > 0;
}

/**
 * The script the isolate runs for one call: the command's code is an async function body with
 * `args` in scope, its `console` is silent, and the only thing it prints is what it returns, as
 * JSON, so the caller gets a value and not a log.
 */
export function codeCommandScript(code: string, args: Record<string, unknown>): string {
  return `const __log = console.log;
const __run = async (args, console) => {
${code}
};
__log(JSON.stringify((await __run(${JSON.stringify(args)}, { log() {}, error() {}, warn() {}, info() {} })) ?? null));`;
}

/**
 * Reusable saved-command wrapper that reads `__args` from `globalThis` so the TypeScript source
 * stays identical across invocations and hits the transpilation cache.
 */
export function codeCommandBodyScript(code: string): string {
  return `const __log = console.log;
const __run = async (args, console) => {
${code}
};
__log(JSON.stringify((await __run(globalThis.__args ?? {}, { log() {}, error() {}, warn() {}, info() {} })) ?? null));`;
}
