import {
  codeCommandBodyScript,
  deleteCodeCommand,
  parseCodeCommandInput,
  saveCodeCommand,
} from "../../tools/code-commands.js";
import { formatCodeModeLintFindings, lintCodeModeScript } from "../../tools/code-mode-lint.js";
import { checkCodeModeSyntax } from "../../tools/code-mode-sandbox.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** Saved commands: scripts every bot can find with `codemode.search` and call as `codemode.cmd.<name>`. */
export const commandTools: ToolHandlers = {
  async command_save(ctx, call) {
    const parsed = parseCodeCommandInput(call.args);
    if ("error" in parsed) return call.finish({ error: parsed.error });
    const findings = lintCodeModeScript(parsed.command.code, { mode: "command" });
    if (findings.length > 0) {
      return call.finish({ error: formatCodeModeLintFindings(findings) });
    }
    const syntaxError = await checkCodeModeSyntax(codeCommandBodyScript(parsed.command.code));
    if (syntaxError) {
      return call.finish({ error: `${syntaxError.name}: ${syntaxError.message}` });
    }
    const saved = await saveCodeCommand(ctx.deps.prisma, parsed.command, ctx.run.userId);
    if ("error" in saved) return call.finish({ error: saved.error });
    return call.finish({
      saved: `cmd.${parsed.command.name}`,
      updated: saved.updated,
    });
  },
  async command_delete(ctx, call) {
    const name = typeof call.args.name === "string" ? call.args.name.trim() : "";
    if (!(await deleteCodeCommand(ctx.deps.prisma, name))) {
      return call.finish({ error: `There is no saved command named ${name}.` });
    }
    return call.finish({ deleted: `cmd.${name}` });
  },
};
