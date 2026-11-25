import { redactSecrets } from "@rakazo/core";
import { redactToolArgsForReview } from "../../approvals/auto-review.js";
import { sanitizeSensitiveText } from "../../runtime/pi/pi-runtime-errors.js";
import { formatCodeModeCallsSummary, summarizeCodeModeCalls } from "../../tools/code-mode-lint.js";

/** Max characters kept for a step's one-line target summary. */
export const TOOL_STEP_DETAIL_MAX_CHARS = 160;

/** Tools that handle credentials or sensitive inputs never surface their arguments on steps. */
const SECRET_TOOL_NAME_RE = /secret|password|credential|token|auth/i;

/** Query parameters that commonly carry credentials or signed tokens. */
const SENSITIVE_QUERY_KEY_RE =
  /^(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|auth|authorization|sig|signature|code|session|cookie|key)$/i;

/** Inline `VAR=value` shell assignments whose variable name signals a secret. */
const INLINE_SHELL_SECRET_RE =
  /(^|[\s;&|])([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|CREDENTIAL)[A-Z0-9_]*)=('[^']*'|"[^"]*"|\S+)/gi;

/** Safe generic argument keys for MCP / integration tools when no tool-specific rule matches. */
const GENERIC_DETAIL_KEYS = [
  "url",
  "query",
  "q",
  "path",
  "file",
  "file_path",
  "filePath",
  "title",
  "name",
  "repository",
  "repo",
  "channel",
  "subject",
  "app",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeUrlDetail(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return raw;
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY_RE.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function summarizeShellCommand(raw: string): string | undefined {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const first = lines[0];
  if (!first) return undefined;
  const scrubbed = first
    .replace(INLINE_SHELL_SECRET_RE, "$1$2=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return lines.length > 1 ? `${scrubbed} …` : scrubbed;
}

function finalizeDetail(raw: string | undefined, secrets: string[]): string | undefined {
  if (!raw) return undefined;
  const cleaned = sanitizeSensitiveText(redactSecrets(raw, secrets)).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= TOOL_STEP_DETAIL_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, TOOL_STEP_DETAIL_MAX_CHARS - 1).trimEnd()}…`;
}

function rawDetailForTool(toolName: string, args: Record<string, unknown>): string | undefined {
  const name = toolName.trim().toLowerCase();
  switch (name) {
    case "web_fetch":
    case "browser_navigate":
    case "paid_request": {
      const url = nonEmptyString(args.url);
      return url ? sanitizeUrlDetail(url) : undefined;
    }
    case "web_search":
    case "service_search":
    case "search_history":
    case "search_memory_docs":
    case "browser_snapshot":
      return nonEmptyString(args.query);
    case "read_file":
    case "write_file":
    case "attach_file":
    case "list_files":
    case "drive_list":
    case "drive_read":
    case "drive_save":
    case "drive_create_folder":
    case "drive_move":
    case "drive_update":
    case "save_shared_memory":
    case "read_memory_doc":
      return (
        nonEmptyString(args.path) ??
        nonEmptyString(args.file_path) ??
        nonEmptyString(args.filePath) ??
        nonEmptyString(args.name) ??
        nonEmptyString(args.file_id) ??
        nonEmptyString(args.folder_id) ??
        nonEmptyString(args.query)
      );
    case "open_path": {
      const path = nonEmptyString(args.path);
      return path && /^https?:\/\//i.test(path) ? sanitizeUrlDetail(path) : path;
    }
    case "shell":
    case "user_computer_shell": {
      const command = nonEmptyString(args.command);
      return command ? summarizeShellCommand(command) : undefined;
    }
    case "launch_app":
      return nonEmptyString(args.application);
    case "user_computer_observe":
    case "user_computer_act":
      return nonEmptyString(args.app);
    case "browser_act":
    case "computer_act":
    case "computer_observe":
      // Never surface typed text, credentials, or pixel coordinates from GUI actions.
      return undefined;
    case "service_call":
      return nonEmptyString(args.service);
    case "save_page":
      return nonEmptyString(args.title) ?? nonEmptyString(args.pageId);
    case "render_plot":
      return (
        nonEmptyString(args.data_path) ?? nonEmptyString(args.path) ?? nonEmptyString(args.charts)
      );
    case "skill_read":
    case "skill_create":
    case "skill_update":
    case "skill_delete":
      return nonEmptyString(args.name);
    case "ticket_get":
      return nonEmptyString(args.ref);
    case "ticket_create":
    case "scratchpad_add":
    case "scratchpad_update":
      return nonEmptyString(args.title);
    case "task_sync": {
      const actions = Array.isArray(args.actions) ? args.actions : [];
      const first = actions.find(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
      );
      if (!first) return undefined;
      return nonEmptyString(first.title) ?? nonEmptyString(first.ref);
    }
    case "schedule_create":
    case "schedule_update":
    case "schedule_cancel":
      return nonEmptyString(args.name);
    case "connect_app":
      return nonEmptyString(args.app);
    case "add_mcp_server": {
      const serverName = nonEmptyString(args.name);
      if (serverName) return serverName;
      const endpoint = nonEmptyString(args.endpoint);
      return endpoint ? sanitizeUrlDetail(endpoint) : undefined;
    }
    case "generate_image":
    case "generate_video":
      return nonEmptyString(args.prompt);
    case "cloud_agent_launch": {
      const repo = nonEmptyString(args.repository);
      return repo ? sanitizeUrlDetail(repo) : nonEmptyString(args.prompt);
    }
    case "run_subagent":
      return nonEmptyString(args.name) ?? nonEmptyString(args.task);
    case "code_mode": {
      const code = nonEmptyString(args.code);
      return code ? summarizeCodeModeCalls(code) : undefined;
    }
    case "command_save":
    case "command_delete": {
      const commandName = nonEmptyString(args.name);
      return commandName ? `cmd.${commandName}` : undefined;
    }
    case "find_tool": {
      if (Array.isArray(args.names)) {
        const joined = args.names
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .join(", ");
        if (joined) return joined;
      }
      return nonEmptyString(args.query);
    }
    default: {
      for (const key of GENERIC_DETAIL_KEYS) {
        const value = nonEmptyString(args[key]);
        if (!value) continue;
        return key === "url" ? sanitizeUrlDetail(value) : value;
      }
      return undefined;
    }
  }
}

/**
 * Extracts a short, single-line, redacted summary of what a tool call targeted (such as a URL,
 * file path, search query, or shell command's first line) for the chat activity panel.
 * Returns undefined for secret/credential tools or when no safe summary field is present.
 */
export function summarizeToolCallDetail(
  toolName: string,
  args: unknown,
  secrets: string[] = [],
): string | undefined {
  if (!toolName || SECRET_TOOL_NAME_RE.test(toolName)) return undefined;
  const record = asRecord(args);
  if (!record) return undefined;
  if (toolName === "use_tool") {
    const innerName = nonEmptyString(record.name);
    return innerName ? summarizeToolCallDetail(innerName, record.arguments, secrets) : undefined;
  }
  const redacted = redactToolArgsForReview(record, secrets);
  return finalizeDetail(rawDetailForTool(toolName, redacted), secrets);
}

/**
 * Extracts a concise summary from a finished `code_mode` call's recorded `calls` array so even
 * dynamic loops (`codemode[name]()`) or aliases surface what ran on the step card.
 */
export function summarizeToolCompletionDetail(
  completion: { name: string; result?: unknown },
  secrets: string[] = [],
): string | undefined {
  if (completion.name !== "code_mode") return undefined;
  const result = asRecord(completion.result);
  if (!result) return undefined;
  const details = asRecord(result.details);
  const rawCalls = Array.isArray(result.calls)
    ? result.calls
    : Array.isArray(details?.calls)
      ? details.calls
      : undefined;
  if (!rawCalls) return undefined;
  const calls = rawCalls.filter((item): item is string => typeof item === "string");
  return finalizeDetail(formatCodeModeCallsSummary(calls), secrets);
}
