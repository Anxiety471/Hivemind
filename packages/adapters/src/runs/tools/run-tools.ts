import type { AgentToolExecutionObserver, ConnectorTool } from "@rakazo/adapter-kit";
import { BACKGROUND_HELPER_TRIGGER, redactSecrets, toolResultTaintsRun } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import {
  internalTerminatingResult,
  isTerminatingReplyResult,
  isToolPauseResult,
} from "../../approvals/approval-effect.js";
import { argumentGiven } from "../../bots/update-bot-patch.js";
import { isRunningShellCommand } from "../../computers/sandbox/shell-command-stream.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "../../models/model-vision.js";
import { MODEL_CANNOT_SEE_MESSAGE } from "../../models/model-vision.prompt.js";
import { strategicInitiativeToolAllowed } from "../../routines/strategic-initiative.js";
import type { CodeCommandInput, CodeCommandSummary } from "../../tools/code-commands.js";
import {
  CODE_COMMAND_PREFIX,
  codeCommandBodyScript,
  findCodeCommand,
  findCodeCommands,
  listCodeCommands,
} from "../../tools/code-commands.js";
import {
  CODE_MODE,
  CODE_MODE_MAX_WRITES,
  CODE_MODE_SHELL_TIMEOUT_MS,
} from "../../tools/code-mode.tool-definition.js";
import type { CodeModeDescription } from "../../tools/code-mode-api.js";
import {
  CODE_MODE_DESCRIBE,
  CODE_MODE_DESCRIBE_MAX_NAMES,
  CODE_MODE_SEARCH,
  describeCodeCommand,
  describeCodeModeTool,
  formatToolSignature,
  searchCodeModeTools,
  undescribed,
} from "../../tools/code-mode-api.js";
import { isStaticallyReadOnlyCommand } from "../../tools/code-mode-lint.js";
import {
  CODE_MODE_MAX_CALLS,
  CODE_MODE_OUTPUT_MAX_CHARS,
  CODE_MODE_TIMEOUT_MS,
  runCodeModeScript,
} from "../../tools/code-mode-sandbox.js";
import type { CatalogEntry } from "../../tools/lazy-tool-catalog.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  isLazyCatalogControlRoute,
  loadCatalogEntry,
  parseConnectorToolArgs,
} from "../../tools/lazy-tool-catalog.js";
import type { RunContext } from "../assembly/run-context.js";
import { markReadOutsideContent } from "../assembly/run-context.js";
import { codeModeToolExecutionId } from "../lifecycle/run-effects.js";
import { noteComputerTaskStep } from "../lifecycle/run-progress.js";
import { logToolRefusal } from "../turn/tool-completion-audit.js";
import { refusal } from "../turn/tool-refusal.js";
import type { ToolCall, ToolHandler } from "./run-tool-gate.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  codeModeCallableTools,
  isCodeModeWrite,
  PAGE_BROWSER_TOOL_NAMES,
  SUBAGENT_HIDDEN_TOOLS,
} from "./run-tool-selection.js";
import { commandTools } from "./run-tools-commands.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { driveTools } from "./run-tools-drive.js";
import { emailTools } from "./run-tools-email.js";
import { feedbackTools } from "./run-tools-feedback.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { pageTools } from "./run-tools-pages.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  userComputerAct,
  userComputerList,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(driveTools),
  ...Object.entries(pageTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(commandTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  ["user_computer_list", userComputerList],
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  [CODE_MODE, codeModeTool],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...Object.entries(feedbackTools),
  ...Object.entries(emailTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
  commandTimeoutMs?: number,
) {
  // A bot naming itself in bot_id means its own settings. Dropping it here sends the call down
  // the own path everywhere: preparation, the stored approval, the handler and its taint check.
  if (
    name === "update_bot" &&
    typeof args.bot_id === "string" &&
    args.bot_id.trim() === ctx.bot.id
  ) {
    const { bot_id: _self, ...own } = args;
    args = own;
  }
  return dispatchTool(ctx, name, args, executionId, observer, commandTimeoutMs);
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
  commandTimeoutMs?: number,
) {
  ctx.context.signal.throwIfAborted();
  // A call turned away before its tool runs is logged by its refusal code. `target` is the
  // connector tool a catalog call resolved to.
  const refuse = <T>(refused: T, target?: string): T => {
    const logged = logToolRefusal(
      {
        spaceId: ctx.run.spaceId,
        threadId: ctx.thread.id,
        botId: ctx.bot.id,
        runId: ctx.runId,
        trigger: ctx.run.trigger,
      },
      name,
      refused,
      ctx.secrets,
      target === name ? undefined : target,
    );
    if (logged) {
      ctx.state.toolRefusals ??= new Map();
      ctx.state.toolRefusals.set(executionId, logged);
    }
    return refused;
  };
  if (!strategicInitiativeToolAllowed(name, ctx.run)) {
    return refuse(
      refusal(
        "daily_check_in_tool_not_allowed",
        "Daily check-ins can only ask or message the user.",
      ),
    );
  }
  if (ctx.state.handedOff) {
    return refuse(
      refusal(
        "stage_handed_off",
        "This stage was handed off. End the turn without more tool calls.",
      ),
    );
  }
  if (ctx.tools.disabled.has(name)) {
    return refuse(refusal("tool_disabled", "This tool is disabled for this bot."));
  }
  // Only offered tools reach the model, but a runtime can still emit any name, and a connector
  // tool named like a local one still runs the local handler.
  if (
    ctx.run.trigger === BACKGROUND_HELPER_TRIGGER &&
    (BUILTIN_AGENT_TOOL_NAMES.has(name) || TOOL_HANDLERS.has(name)) &&
    (SUBAGENT_HIDDEN_TOOLS.has(name) || !ctx.tools.builtins.some((tool) => tool.name === name))
  ) {
    return refuse(
      refusal(
        "helper_tool_unavailable",
        `${name} is not available to a subagent. Say in your result what the parent should do.`,
      ),
    );
  }
  if (Object.hasOwn(memoryTools, name) && !ctx.tools.offered.some((tool) => tool.name === name)) {
    return refuse(
      refusal("memory_tool_unavailable", "This memory tool is unavailable in this run."),
    );
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return refuse(
      refusal("page_browser_unavailable", "Page browser is unavailable on this computer."),
    );
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return refuse(refusal("model_cannot_see_images", MODEL_CANNOT_SEE_MESSAGE));
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return refuse(request);
  // A catalog call resolves to a connector tool after the checks above; one named like a local
  // tool (message_agent, cloud_agent_*, ...) would otherwise run that local handler instead.
  if (request.catalogRemapped && toolHandler(request.name) !== connectorTool) {
    return refuse(
      refusal("connector_name_conflict", "Connector tool name conflicts with a built-in tool"),
      request.name,
    );
  }
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refuse(refused, request.name);
  noteComputerTaskStep(ctx.state.reply, request.name);
  const gate = await gateToolCall(ctx, request, observer, commandTimeoutMs);
  if ("result" in gate) {
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (gate.replayed && toolResultTaintsRun(request.name) && !ownProfile) {
      await markReadOutsideContent(ctx);
    }
    return refuse(gate.result, request.name);
  }
  // Only a call that ran can have taken in outside content; one refused above, or whose approval
  // was denied, never did. A call that failed partway still counts.
  const runHandler = async () => {
    try {
      return await toolHandler(gate.call.name)(ctx, gate.call);
    } finally {
      // Editing its own profile returns only what this run wrote; a child's profile is another
      // bot's.
      const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
      if (toolResultTaintsRun(name) && !ownProfile) await markReadOutsideContent(ctx);
    }
  };
  if (!gate.call.applied) return runHandler();
  let outcome: "success" | "failure" = "failure";
  try {
    const result = await runHandler();
    if (!isToolError(result)) outcome = "success";
    return result;
  } finally {
    const route = gate.call.connectorCall.route;
    await auditToolCall(ctx, gate.call.name, outcome, {
      effectId: gate.call.applied.effect.id,
      autoApproved: gate.call.bypassApproval,
      ...(route?.connectionId && {
        connectorId: route.connectorId,
        connectionId: route.connectionId,
      }),
    });
  }
}

/** A failed tool call becomes the error a script catches, never a silent value. */
function toolResultErrorText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "the tool failed";
  if ("error" in result) return String(result.error);
  if (!("content" in result) || !Array.isArray(result.content)) return "the tool failed";
  const text = result.content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
    .trim();
  return text || "the tool failed";
}

/**
 * Runs one model-authored TypeScript snippet against the tools this run offers.
 * Every call goes through applyTool, so approvals, taint, refusals and audit see it exactly as
 * a direct call. A call that pauses (approval, secret) stops the script and becomes this
 * tool's own result, which ends the turn as a direct call would.
 */
async function codeModeTool(ctx: RunContext, call: ToolCall) {
  const code = typeof call.args.code === "string" ? call.args.code : "";
  if (!code.trim()) return call.finish({ error: "code must be the TypeScript to run." });
  const offered = codeModeCallableTools(ctx.tools.offered);
  const callable = new Map(offered.map((tool) => [tool.name, tool] as const));

  // Unify lazy catalogs (>20 MCP, Pipedream, or Installed tools) into code_mode so scripts can
  // search, describe, and call underlying tools directly while preserving catalog approval routing.
  const executeWrapperByConnector = new Map<string, string>();
  for (const tool of offered) {
    if (
      isLazyCatalogControlRoute(tool.route) &&
      tool.route?.toolName === CATALOG_EXECUTE &&
      tool.route.connectorId
    ) {
      executeWrapperByConnector.set(tool.route.connectorId, tool.name);
    }
  }
  const catalogByName = new Map<string, ConnectorTool>();
  const catalogIdByName = new Map<string, string>();
  const catalogEntriesByConnector = new Map<string, CatalogEntry[]>();
  if (executeWrapperByConnector.size > 0 && ctx.deps.connector?.listCatalogTools) {
    const listed =
      (await bestEffort(
        "list catalog tools for code mode",
        ctx.deps.connector.listCatalogTools(ctx.context),
      )) ?? [];
    const expanded = codeModeCallableTools(listed).filter(
      (tool) => !ctx.tools.disabled.has(tool.name),
    );
    for (const entry of catalogEntries(expanded)) {
      const connectorId = entry.tool.route?.connectorId;
      if (!connectorId || !executeWrapperByConnector.has(connectorId)) continue;
      const list = catalogEntriesByConnector.get(connectorId) ?? [];
      list.push(entry);
      catalogEntriesByConnector.set(connectorId, list);
      if (!callable.has(entry.tool.name) && !catalogByName.has(entry.tool.name)) {
        catalogByName.set(entry.tool.name, entry.tool);
        catalogIdByName.set(entry.tool.name, entry.id);
      }
    }
  }
  const searchableTools = [...offered, ...catalogByName.values()];

  // `codemode.search` answers from the offered set without running a tool; a real tool of the
  // same name wins.
  const searches = !callable.has(CODE_MODE_SEARCH);
  const describes = !callable.has(CODE_MODE_DESCRIBE);
  let ordinal = 0;
  let writes = 0;
  let paused: unknown;
  let stillRunning = false;
  // A paused call ends the script: the isolate is interrupted instead of letting a catch
  // swallow the refusal and keep calling tools after the person was asked.
  const stop = new AbortController();
  const toolNames = [
    ...callable.keys(),
    ...catalogByName.keys(),
    ...(searches ? [CODE_MODE_SEARCH] : []),
    ...(describes ? [CODE_MODE_DESCRIBE] : []),
  ];
  const startedAt = Date.now();
  let totalCalls = 0;
  let callLimitExceeded = false;
  let cachedCommands: Promise<CodeCommandSummary[]> | undefined;
  const commandCache = new Map<string, CodeCommandInput | undefined>();

  const loadCommandList = () => {
    cachedCommands ??= listCodeCommands(ctx.deps.prisma, ctx.run.spaceId).catch((error) => {
      cachedCommands = undefined;
      throw error;
    });
    return cachedCommands;
  };

  const loadCommand = async (commandName: string): Promise<CodeCommandInput | undefined> => {
    if (commandCache.has(commandName)) return commandCache.get(commandName);
    const command = await findCodeCommand(ctx.deps.prisma, ctx.run.spaceId, commandName);
    commandCache.set(commandName, command);
    return command;
  };

  const resolveTargetTool = (
    name: string,
    args: Record<string, unknown>,
  ): ConnectorTool | undefined => {
    const direct = callable.get(name);
    if (
      direct &&
      isLazyCatalogControlRoute(direct.route) &&
      direct.route?.toolName === CATALOG_EXECUTE &&
      direct.route.connectorId
    ) {
      const entries = catalogEntriesByConnector.get(direct.route.connectorId);
      if (entries && typeof args.id === "string") {
        try {
          return loadCatalogEntry(entries, args).tool;
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    return direct ?? catalogByName.get(name);
  };

  const isToolNameReadOnly = (toolName: string): boolean => {
    const tool = callable.get(toolName) ?? catalogByName.get(toolName);
    return Boolean(tool && !isCodeModeWrite(tool));
  };

  const canRunConcurrently = (name: string, args: Record<string, unknown>): boolean => {
    if (name.startsWith(CODE_COMMAND_PREFIX)) {
      const cached = commandCache.get(name.slice(CODE_COMMAND_PREFIX.length));
      return Boolean(cached && isStaticallyReadOnlyCommand(cached.code, isToolNameReadOnly));
    }
    if (searches && name === CODE_MODE_SEARCH) return true;
    if (describes && name === CODE_MODE_DESCRIBE) return true;
    const target = resolveTargetTool(name, args);
    return Boolean(target && !isCodeModeWrite(target));
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    insideCommand: boolean,
  ): Promise<unknown> => {
    if (paused || stillRunning) throw new Error("The script has stopped.");
    if (name.startsWith(CODE_COMMAND_PREFIX)) {
      if (insideCommand) {
        throw Object.assign(new Error("A saved command cannot call another command."), {
          name: "CommandNesting",
        });
      }
      return savedCommand(name, args);
    }
    if (totalCalls >= CODE_MODE_MAX_CALLS) {
      callLimitExceeded = true;
      throw Object.assign(
        new Error(`code_mode allows at most ${CODE_MODE_MAX_CALLS} tool calls per script`),
        { name: "CallLimitReached" },
      );
    }
    totalCalls += 1;
    if (searches && name === CODE_MODE_SEARCH) {
      return searchCodeModeTools(
        searchableTools,
        typeof args.query === "string" ? args.query : "",
        await loadCommandList(),
      );
    }
    if (describes && name === CODE_MODE_DESCRIBE) {
      const asked = [
        ...(typeof args.name === "string" ? [args.name] : []),
        ...(Array.isArray(args.names)
          ? args.names.filter((value): value is string => typeof value === "string")
          : []),
      ].slice(0, CODE_MODE_DESCRIBE_MAX_NAMES);
      const missingCommands = asked
        .filter((asking) => asking.startsWith(CODE_COMMAND_PREFIX))
        .map((asking) => asking.slice(CODE_COMMAND_PREFIX.length))
        .filter((commandName) => !commandCache.has(commandName));
      if (missingCommands.length > 0) {
        const fetched = await findCodeCommands(ctx.deps.prisma, ctx.run.spaceId, missingCommands);
        for (const commandName of missingCommands) {
          commandCache.set(commandName, fetched.get(commandName));
        }
      }
      let readCommand = false;
      const described: CodeModeDescription[] = [];
      for (const asking of asked) {
        if (asking.startsWith(CODE_COMMAND_PREFIX)) {
          const command = commandCache.get(asking.slice(CODE_COMMAND_PREFIX.length));
          if (command) {
            readCommand = true;
            described.push(describeCodeCommand(command));
            continue;
          }
        } else {
          const tool = callable.get(asking) ?? catalogByName.get(asking);
          if (tool) {
            described.push(describeCodeModeTool(tool));
            continue;
          }
        }
        described.push(undescribed(asking));
      }
      // Any bot may have written a command's code, so reading it is reading outside content.
      if (readCommand) await markReadOutsideContent(ctx);
      return described;
    }
    const directTool = callable.get(name);
    const catalogTool = catalogByName.get(name);
    if (!directTool && !catalogTool) {
      throw Object.assign(new Error(`${name} is not a tool this run offers`), {
        name: "ToolUnavailable",
      });
    }
    const target = resolveTargetTool(name, args);
    const countsAsWrite = target ? isCodeModeWrite(target) : true;
    if (countsAsWrite && ++writes > CODE_MODE_MAX_WRITES) {
      throw Object.assign(
        new Error(`code_mode allows at most ${CODE_MODE_MAX_WRITES} writes per script`),
        { name: "WriteLimitReached" },
      );
    }
    const dispatchName = catalogTool
      ? executeWrapperByConnector.get(catalogTool.route?.connectorId ?? "")!
      : name;
    const dispatchArgs = catalogTool
      ? { id: catalogIdByName.get(catalogTool.name) ?? catalogTool.name, arguments: args }
      : args;
    const result = await applyTool(
      ctx,
      dispatchName,
      dispatchArgs,
      codeModeToolExecutionId(call.executionId, ordinal++),
      undefined,
      // A command that outlives its quiet window reports back through the turn's observer, as
      // it does for a direct call.
      call.observer,
      CODE_MODE_SHELL_TIMEOUT_MS,
    );
    if (isRunningShellCommand(result)) {
      stillRunning = true;
      stop.abort();
      throw new Error("The command is still running, so the script stopped.");
    }
    if (isToolPauseResult(result)) {
      paused = result;
      stop.abort();
      throw new Error("The call is waiting for the person, so the script stopped.");
    }
    if (isToolError(result)) {
      const message = toolResultErrorText(result);
      const hasLongDescription =
        target !== undefined &&
        String(target.description ?? "")
          .replace(/\s+/g, " ")
          .trim().length > 90;
      const hint =
        target &&
        (/invalid|required|expected|argument|parameter|schema|must be|not defined|syntax|unexpected/i.test(
          message,
        ) ||
          hasLongDescription)
          ? ` Expected: ${formatToolSignature(target)}. Call codemode.describe({ name: ${JSON.stringify(target.name)} }) for full description and schema.`
          : "";
      throw Object.assign(new Error(`${message}${hint}`), { name: "ToolFailed" });
    }
    if (name === "command_save" || name === "command_delete") {
      cachedCommands = undefined;
      commandCache.clear();
    }
    return result;
  };
  // A saved command is another bot's text, so reading what it returns counts as reading outside
  // content. It runs in its own isolate with this script's tools, call budget and clock, and each
  // call it makes is gated and recorded like any other.
  const savedCommand = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const command = await loadCommand(name.slice(CODE_COMMAND_PREFIX.length));
    if (!command) {
      throw Object.assign(
        new Error(`There is no saved command ${name}. Find one with codemode.search.`),
        { name: "ToolUnavailable" },
      );
    }
    if (command.parameters) {
      try {
        parseConnectorToolArgs(command.parameters, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid arguments";
        throw Object.assign(new Error(`InvalidArguments (${name}): ${message}`), {
          name: "InvalidArguments",
        });
      }
    }
    await markReadOutsideContent(ctx);
    const nested = await runCodeModeScript({
      code: codeCommandBodyScript(command.code),
      mode: "command",
      globals: { __args: args },
      tools: toolNames,
      commandPrefix: CODE_COMMAND_PREFIX,
      signal: AbortSignal.any([ctx.context.signal, stop.signal]),
      timeoutMs: Math.max(1, CODE_MODE_TIMEOUT_MS - (Date.now() - startedAt)),
      maxCalls: Math.max(0, CODE_MODE_MAX_CALLS - totalCalls),
      canRunConcurrently,
      call: (toolName, toolArgs) => callTool(toolName, toolArgs, true),
    });
    if (nested.error?.name === "CallLimitReached") callLimitExceeded = true;
    if (paused || stillRunning) throw new Error("The script has stopped.");
    if (nested.error) {
      throw Object.assign(new Error(`${nested.error.name}: ${nested.error.message}`), {
        name: "CommandFailed",
      });
    }
    if (nested.truncated) {
      throw Object.assign(
        new Error(`${name} returned more than ${CODE_MODE_OUTPUT_MAX_CHARS} characters`),
        {
          name: "CommandFailed",
        },
      );
    }
    try {
      return JSON.parse(nested.output);
    } catch {
      throw Object.assign(new Error(`${name} returned something that is not JSON`), {
        name: "CommandFailed",
      });
    }
  };
  const outcome = await runCodeModeScript({
    code,
    tools: toolNames,
    commandPrefix: CODE_COMMAND_PREFIX,
    signal: AbortSignal.any([ctx.context.signal, stop.signal]),
    canRunConcurrently,
    call: (name, args) => callTool(name, args, false),
  });
  if (callLimitExceeded) {
    outcome.error ??= {
      name: "CallLimitReached",
      message: `code_mode allows at most ${CODE_MODE_MAX_CALLS} tool calls per script`,
    };
  }
  if (paused) {
    const prePauseOutput = redactSecrets(outcome.output, ctx.secrets);
    if (
      (prePauseOutput || outcome.calls.length > 0) &&
      typeof paused === "object" &&
      paused !== null &&
      "content" in paused &&
      Array.isArray((paused as { content?: unknown }).content)
    ) {
      const base = paused as {
        kind: "agent_tool_result";
        content: Array<{ type: "text"; text: string }>;
        details: unknown;
        terminate: true;
      };
      const baseDetails =
        typeof base.details === "object" && base.details !== null && !Array.isArray(base.details)
          ? { ...base.details }
          : {};
      return internalTerminatingResult({
        ...base,
        content: [
          ...base.content,
          ...(prePauseOutput
            ? [{ type: "text" as const, text: `Output before pause:\n${prePauseOutput}` }]
            : []),
        ],
        details: {
          ...baseDetails,
          ...(prePauseOutput ? { output: prePauseOutput } : {}),
          ...(outcome.calls.length ? { calls: outcome.calls } : {}),
        },
      });
    }
    return paused;
  }
  if (stillRunning) {
    return call.finish({
      ...(outcome.output ? { output: redactSecrets(outcome.output, ctx.secrets) } : {}),
      error:
        "ShellStillRunning: a command is still running and its final output arrives after this turn. Do not run it again.",
      calls: outcome.calls,
    });
  }
  const output = redactSecrets(outcome.output, ctx.secrets);
  const returnValue =
    outcome.returnValue !== undefined ? redactSecrets(outcome.returnValue, ctx.secrets) : undefined;
  if (outcome.error) {
    return call.finish({
      ...(output ? { output } : {}),
      ...(returnValue !== undefined ? { returnValue } : {}),
      error: redactSecrets(`${outcome.error.name}: ${outcome.error.message}`, ctx.secrets),
      ...(outcome.calls.length ? { calls: outcome.calls } : {}),
    });
  }
  if (output && returnValue !== undefined) {
    return call.finish({
      output,
      returnValue,
      ...(outcome.truncated ? { truncated: true } : {}),
      ...(outcome.calls.length ? { calls: outcome.calls } : {}),
    });
  }
  if (returnValue !== undefined) {
    return call.finish({
      output: returnValue,
      ...(outcome.truncated ? { truncated: true } : {}),
      ...(outcome.calls.length ? { calls: outcome.calls } : {}),
    });
  }
  return call.finish({
    output: output || "(the script printed nothing; use console.log or return a value)",
    ...(outcome.truncated ? { truncated: true } : {}),
    ...(outcome.calls.length ? { calls: outcome.calls } : {}),
  });
}

export function isToolError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("error" in result) return true;
  if ("isError" in result && (result as { isError?: unknown }).isError === true) return true;
  return isTerminatingReplyResult(result);
}
