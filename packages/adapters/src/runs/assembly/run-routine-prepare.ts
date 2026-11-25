import type { RoutinePrepare } from "@rakazo/contracts";
import { RoutinePrepareSchema } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { readJsonColumn } from "@rakazo/db";
import { isToolPauseResult } from "../../approvals/approval-effect.js";
import { isRunningShellCommand } from "../../computers/sandbox/shell-command-stream.js";
import {
  ROUTINE_PREPARE_NOTE_START,
  routinePrepareNote,
} from "../../routines/routine-prepare.prompt.js";
import { codeCommandBodyScript, findCodeCommand } from "../../tools/code-commands.js";
import { CODE_MODE_SHELL_TIMEOUT_MS } from "../../tools/code-mode.tool-definition.js";
import type { CodeModeRunResult } from "../../tools/code-mode-sandbox.js";
import { runCodeModeScript } from "../../tools/code-mode-sandbox.js";
import { parseConnectorToolArgs } from "../../tools/lazy-tool-catalog.js";
import { completeRun } from "../lifecycle/run-complete.js";
import { codeModeToolExecutionId } from "../lifecycle/run-effects.js";
import { codeModeCallableTools, isCodeModeWrite } from "../tools/run-tool-selection.js";
import { applyTool, isToolError, toolResultErrorText } from "../tools/run-tools.js";
import type { RunContext } from "./run-context.js";
import { markReadOutsideContent } from "./run-context.js";

/** What a prepare command's result does with the run. */
export type RoutinePrepareOutcome =
  | { kind: "skip" }
  | { kind: "post"; text: string }
  | { kind: "note"; note: string };

/**
 * Runs a routine's saved prepare command before its model, once per run: the outcome is saved
 * in the task's prompt, so a resumed or retried run reads the same data instead of running the
 * command again. Returns true when the command finished the run without the model.
 */
export async function prepareRoutineRun(
  ctx: RunContext,
  task: { id: string; prompt: string },
  hasSavedTurn: boolean,
): Promise<boolean> {
  const { deps, run } = ctx;
  if (run.trigger !== "routine" || !run.routineId || hasSavedTurn) return false;
  if (task.prompt.includes(ROUTINE_PREPARE_NOTE_START)) return false;
  const routine = await deps.prisma.routine.findUnique({
    where: { id: run.routineId },
    select: { id: true, prepare: true },
  });
  const prepare = routine
    ? readJsonColumn(
        RoutinePrepareSchema.nullable(),
        routine.prepare,
        { table: "routines", column: "prepare", id: routine.id },
        { fallback: null },
      )
    : null;
  if (!prepare) return false;
  const outcome = await runRoutinePrepare(ctx, prepare);
  if (outcome.kind === "note") {
    const prompt = task.prompt + outcome.note;
    await deps.prisma.task.update({ where: { id: task.id }, data: { prompt } });
    task.prompt = prompt;
    return false;
  }
  const { reply } = ctx.state;
  if (outcome.kind === "post") {
    reply.assembled = outcome.text;
    reply.currentTextSegment = outcome.text;
    reply.textSinceLastStep = outcome.text;
  }
  await completeRun(ctx);
  return true;
}

/**
 * Runs the saved command in its own isolate with the run's read-only tools. Each call goes
 * through applyTool, so rules, refusals and audit apply; one that would ask is refused, as
 * nobody is there to answer.
 */
export async function runRoutinePrepare(
  ctx: RunContext,
  prepare: RoutinePrepare,
): Promise<RoutinePrepareOutcome> {
  const failed = (error: string): RoutinePrepareOutcome => ({
    kind: "note",
    note: routinePrepareNote(prepare.command, { error: redactSecrets(error, ctx.secrets) }),
  });
  const command = await findCodeCommand(ctx.deps.prisma, ctx.run.spaceId, prepare.command);
  if (!command) return failed(`There is no saved command named ${prepare.command}.`);
  if (command.parameters) {
    try {
      parseConnectorToolArgs(command.parameters, prepare.args);
    } catch (error) {
      return failed(`Its arguments are invalid: ${error instanceof Error ? error.message : error}`);
    }
  }
  // Any bot may have written the command, and its tools read outside content.
  await markReadOutsideContent(ctx);
  const readOnly = codeModeCallableTools(ctx.tools.offered).filter(
    (tool) => !isCodeModeWrite(tool) && !ctx.tools.disabled.has(tool.name),
  );
  let ordinal = 0;
  ctx.state.preparing = true;
  let outcome: CodeModeRunResult;
  try {
    outcome = await runCodeModeScript({
      code: codeCommandBodyScript(command.code),
      mode: "command",
      globals: { __args: prepare.args },
      tools: readOnly.map((tool) => tool.name),
      signal: ctx.context.signal,
      call: async (name, args) => {
        const result = await applyTool(
          ctx,
          name,
          args,
          codeModeToolExecutionId("routine-prepare", ordinal++),
          undefined,
          undefined,
          CODE_MODE_SHELL_TIMEOUT_MS,
        );
        if (isToolPauseResult(result) || isRunningShellCommand(result)) {
          throw Object.assign(new Error(`${name} did not finish`), { name: "ToolFailed" });
        }
        if (isToolError(result)) {
          throw Object.assign(new Error(toolResultErrorText(result)), { name: "ToolFailed" });
        }
        return result;
      },
    });
  } finally {
    ctx.state.preparing = false;
  }
  if (outcome.error) return failed(`${outcome.error.name}: ${outcome.error.message}`);
  if (outcome.truncated) return failed("It returned too much.");
  let value: unknown;
  try {
    value = JSON.parse(outcome.output);
  } catch {
    return failed("It returned something that is not JSON.");
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { skip, post } = value as { skip?: unknown; post?: unknown };
    if (skip === true) return { kind: "skip" };
    if (typeof post === "string" && post.trim()) {
      return { kind: "post", text: redactSecrets(post.trim(), ctx.secrets) };
    }
  }
  return {
    kind: "note",
    note: routinePrepareNote(prepare.command, {
      result: redactSecrets(JSON.stringify(value, null, 2), ctx.secrets),
    }),
  };
}
