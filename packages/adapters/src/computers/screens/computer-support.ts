import { createHash } from "node:crypto";
import path from "node:path";
import type { ComputerAction, ComputerObservation, ComputerRef } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";

export function toComputerRef(computer: {
  homeKey: string;
  kind: string;
  providerRef: string | null;
}): ComputerRef {
  if (!computer.providerRef) throw new Error("computer provider reference is missing");
  return {
    id: computer.providerRef,
    botId: computer.homeKey,
    kind: computer.kind,
    providerRef: computer.providerRef,
  };
}

const EMPTY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function computerObservation(
  image: Uint8Array,
  input: Omit<ComputerObservation, "frameId" | "capturedAt" | "image">,
): ComputerObservation {
  return {
    ...input,
    image,
    frameId: createHash("sha256").update(image).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export function placeholderObservation(label = "ready"): ComputerObservation {
  return computerObservation(EMPTY_PNG, {
    mimeType: "image/png",
    width: 1,
    height: 1,
    activeWindow: { id: "placeholder", title: label },
  });
}

export function applyPlaceholderAction(box: { screen: string }, action: ComputerAction): void {
  if (action.kind === "clipboard") box.screen = action.text;
  else if (action.kind === "open") box.screen = `opened ${action.path}`;
  else if (action.kind === "launch") box.screen = `launched ${action.application}`;
  else if (action.kind === "focus") box.screen = `focused ${action.application}`;
  else box.screen = action.kind;
}

export function boundedComputerActions(actions: readonly ComputerAction[]): ComputerAction[] {
  if (actions.length > 24) throw new Error("computer action batch exceeds 24 actions");
  return [...actions];
}

export function clampRounded(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * A path that leaves the folder it must stay in. Not a refusal by itself: the path may be one a
 * provider listed, which is a fault to log. A route that passes a caller's own path answers it.
 */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new WorkspacePathError("Path escapes the computer workspace");
  }
  return segments.join("/");
}

export function workspacePath(root: string, relative: string): string {
  const normalized = normalizeWorkspacePath(relative);
  return normalized ? path.posix.join(root, normalized) : root;
}

/** The workspace path bots see on every computer. */
const VIRTUAL_HOME = "/home/rakazo";

/**
 * The directory a command runs in. Empty, ".", "/", the workspace root and any home alias
 * mean the root; absolute paths under one of them keep their tail; anything else is taken
 * relative to the root. "." and ".." segments throw, so a cwd cannot leave the workspace.
 */
export function workspaceCwd(
  root: string,
  cwd: string | undefined,
  homes: readonly string[] = [],
): string {
  if (!cwd || cwd === "." || cwd === "/") return root;
  for (const prefix of [root, VIRTUAL_HOME, ...homes]) {
    if (cwd === prefix) return root;
    if (cwd.startsWith(`${prefix}/`)) return workspacePath(root, cwd.slice(prefix.length + 1));
  }
  return workspacePath(root, cwd);
}

/** True when a normalized workspace path targets the retired per-bot `bots/<id>` subtree. */
export function isLegacyBotSubtreePath(normalizedPath: string): boolean {
  return normalizedPath === "bots" || normalizedPath.startsWith("bots/");
}

export function resolveBotWorkspacePath(
  scope: ComputerMode,
  _botId: string,
  rawPath: string,
): string {
  const requestedPath = expandHomePrefix(rawPath);
  if (scope !== "team") return requestedPath;
  const explicitRootPath = stripVirtualWorkspaceRoot(requestedPath);
  return normalizeWorkspacePath(explicitRootPath ?? requestedPath);
}

export function resolveBotWorkspaceCwd(
  scope: ComputerMode,
  botId: string,
  requestedCwd: string | undefined,
): string | undefined {
  if (scope !== "team") {
    if (requestedCwd === undefined) return undefined;
    const expanded = expandHomePrefix(requestedCwd);
    if (expanded === requestedCwd) return requestedCwd;
    return stripVirtualWorkspaceRoot(expanded) || undefined;
  }
  if (!requestedCwd || requestedCwd === ".") return undefined;
  const expanded = expandHomePrefix(requestedCwd);
  if (expanded !== requestedCwd) return stripVirtualWorkspaceRoot(expanded) || undefined;
  if (path.posix.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd))
    return requestedCwd;
  return resolveBotWorkspacePath(scope, botId, requestedCwd) || undefined;
}

/** Paths a user may write while controlling a computer: any non-escaping path in the workspace. */
export function resolveBotUploadPath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
): string {
  const stored = resolveBotWorkspacePath(scope, botId, requestedPath);
  return normalizeWorkspacePath(stored);
}

export function displayBotWorkspacePath(
  scope: ComputerMode,
  _botId: string,
  _requestedPath: string,
  storedPath: string,
): string {
  if (scope !== "team") return storedPath;
  return normalizeWorkspacePath(storedPath);
}

// A leading ~ or /home/rakazo means the workspace root, the same as a leading /.
function expandHomePrefix(value: string): string {
  return value.replace(
    /^(?:~|[\\/]home[\\/]rakazo)([\\/]|$)/,
    (_, separator: string) => separator || "/",
  );
}

function stripVirtualWorkspaceRoot(value: string): string | null {
  const portable = value.replace(/\\/g, "/");
  if (portable === "/") return "";
  return portable.startsWith("/") ? portable.slice(1) : null;
}

export { shellQuote } from "@rakazo/core/node/desktop-runtime";
