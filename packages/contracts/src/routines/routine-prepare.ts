import * as z from "zod";

/** A saved command's name: scripts call it as `codemode.cmd.<name>`. */
export const CODE_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
/** Search reads every command's name and description, so a Space's table is bounded, not paged. */
export const CODE_COMMAND_MAX_COUNT = 500;

/**
 * A saved command a routine runs before its model, with read-only tools only. What it returns
 * decides the run: `{ skip: true }` ends it without a model call, `{ post: "text" }` posts the
 * text as the bot's reply without a model call, and anything else is handed to the model with
 * the routine's instructions.
 */
export const RoutinePrepareSchema = z.object({
  command: z.string().regex(CODE_COMMAND_NAME_PATTERN),
  args: z.record(z.string(), z.json()).default({}),
});
export type RoutinePrepare = z.infer<typeof RoutinePrepareSchema>;

/** A saved command as the routine editor lists it. */
export const RoutineCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** A Lucide icon name; null for the default. */
  icon: z.string().nullable(),
  /** JSON Schema for its args; null when it takes none. */
  parameters: z.record(z.string(), z.json()).nullable(),
});
export type RoutineCommand = z.infer<typeof RoutineCommandSchema>;
