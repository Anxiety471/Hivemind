import { bestEffort } from "@rakazo/logging";
import {
  codeCommandBodyScript,
  deleteCodeCommand,
  parseCodeCommandInput,
  saveCodeCommand,
  validateCodeCommandParametersSchema,
} from "../../tools/code-commands.js";
import { formatCodeModeLintFindings, lintCodeModeScript } from "../../tools/code-mode-lint.js";
import { checkCodeModeSyntax } from "../../tools/code-mode-sandbox.js";
import { isLazyCatalogControlRoute } from "../../tools/lazy-tool-catalog.js";
import type { ToolHandlers } from "./run-tool-gate.js";
import { codeModeCallableTools } from "./run-tool-selection.js";

/** Saved commands: scripts every bot in the Space can find with `codemode.search` and call as `codemode.cmd.<name>`. */
export const commandTools: ToolHandlers = {
  async command_save(ctx, call) {
    const parsed = parseCodeCommandInput(call.args);
    if ("error" in parsed) return call.finish({ error: parsed.error });
    if (parsed.command.parameters) {
      const schemaError = validateCodeCommandParametersSchema(parsed.command.parameters);
      if (schemaError) return call.finish({ error: `Invalid parameters schema: ${schemaError}` });
    }
    const findings = lintCodeModeScript(parsed.command.code, { mode: "command" });
    if (findings.length > 0) {
      return call.finish({ error: formatCodeModeLintFindings(findings) });
    }
    const syntaxError = await checkCodeModeSyntax(codeCommandBodyScript(parsed.command.code));
    if (syntaxError) {
      return call.finish({ error: `${syntaxError.name}: ${syntaxError.message}` });
    }
    const offered = codeModeCallableTools(ctx.tools.offered);
    const catalogTools =
      offered.some((tool) => isLazyCatalogControlRoute(tool.route)) &&
      ctx.deps.connector?.listCatalogTools
        ? ((await bestEffort(
            "list catalog tools for command validation",
            ctx.deps.connector.listCatalogTools(ctx.context),
          )) ?? [])
        : [];
    const knownTools = [
      ...new Set([...offered.map((tool) => tool.name), ...catalogTools.map((tool) => tool.name)]),
    ];
    const warnings =
      knownTools.length > 0
        ? lintCodeModeScript(parsed.command.code, { mode: "command", tools: knownTools })
            .filter((finding) => finding.rule === "no-unknown-tool")
            .map((finding) => `line ${finding.line}: ${finding.message}`)
        : [];
    const saved = await saveCodeCommand(
      ctx.deps.prisma,
      ctx.run.spaceId,
      parsed.command,
      ctx.run.userId,
    );
    if ("error" in saved) return call.finish({ error: saved.error });
    return call.finish({
      saved: `cmd.${parsed.command.name}`,
      updated: saved.updated,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  },
  async command_delete(ctx, call) {
    const name = typeof call.args.name === "string" ? call.args.name.trim() : "";
    if (!(await deleteCodeCommand(ctx.deps.prisma, ctx.run.spaceId, name))) {
      return call.finish({ error: `There is no saved command named ${name}.` });
    }
    return call.finish({ deleted: `cmd.${name}` });
  },
};
