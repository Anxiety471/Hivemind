import { ORPCError, ValidationError } from "@orpc/server";
import {
  ConnectorAuthUnavailableError,
  SandboxAllowanceUsedError,
  SandboxDamagedError,
  SandboxDiskTooLargeError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  VoiceAccountError,
} from "@rakazo/adapter-kit";
import { ComputerRecoveryRequiredError } from "@rakazo/adapters";
import { ConnectionSetupError } from "@rakazo/contracts";
import { ClientError, isRetryableError, retry, retryDelayMs } from "@rakazo/core";
import { IsolationError, isDatabaseUnavailable, ProviderTransactionBusyError } from "@rakazo/db";
import { enrichLogContext, getLogger } from "@rakazo/logging";

/**
 * Procedures whose answer a transient failure can repeat: reads that change nothing, so a second
 * try reaches the same state. Anything not listed runs once, because a retried write would happen
 * twice. Computer calls stay out: their provider failure already tells the client when to ask
 * again. New reads are safe to add; a mutation never is.
 */
const RETRYABLE_RPC_PROCEDURES: ReadonlySet<string> = new Set([
  "bootstrap",
  "me",
  "agentSecrets.list",
  "aiConsent.status",
  "approvalRules.list",
  "artifacts.get",
  "artifacts.getById",
  "artifacts.list",
  "artifacts.listSpace",
  "artifacts.listVersions",
  "audit.events",
  "availability.items",
  "billing.computerUsage",
  "billing.status",
  "boards.get",
  "boards.list",
  "botSections.list",
  "botSecrets.list",
  "bots.emailAddress",
  "bots.emailAddresses",
  "bots.get",
  "bots.importSetupState",
  "bots.list",
  "bots.listArchived",
  "bots.templates",
  "capabilities.list",
  "cloudComputers.list",
  "computerProvider.account.get",
  "computerProvider.get",
  "connections.catalog",
  "connections.list",
  "connections.tools",
  "deployment.get",
  "files.changes",
  "files.folderTree",
  "files.get",
  "files.list",
  "groups.get",
  "groups.list",
  "groups.listArchived",
  "integrationSetup.get",
  "links.favicon",
  "marketplace.catalog",
  "marketplace.review",
  "marketplace.submissions",
  "mcp.assignments.all",
  "mcp.assignments.list",
  "mcp.servers.agents",
  "mcp.servers.list",
  "memory.budget",
  "memory.list",
  "memory.providerConfig",
  "memory.providers",
  "memory.roamer",
  "memory.systemPrompt",
  "messaging.channels.list",
  "messaging.connections.list",
  "messaging.installations.list",
  "messaging.status",
  "models.backups",
  "models.credentials",
  "models.forRole",
  "models.list",
  "organizations.invitations.preview",
  "organizations.list",
  "organizations.members.list",
  "pages.get",
  "pages.list",
  "paymentWallet.status",
  "routines.commands",
  "routines.history",
  "routines.list",
  "routines.listForMentions",
  "runs.list",
  "scratchpad.list",
  "security.events",
  "skills.get",
  "skills.list",
  "skills.snapshot",
  "spaceSettings.overrides",
  "spaces.invites.preview",
  "spaces.list",
  "spaces.members.list",
  "spendingLimit.get",
  "spendingLimit.payments",
  "threads.get",
  "threads.head",
  "threads.helperGet",
  "threads.messages",
  "tickets.comments",
  "tickets.get",
  "tickets.list",
  "trustedLinkSites.list",
  "updater.status",
  "usage.breakdown",
  "usage.limits",
  "usage.list",
  "usage.summary",
  "vault.activity",
  "vault.list",
  "voice.catalog",
  "voice.credentials",
  "voice.status",
  "voice.voices",
]);

/** Whether an RPC path only reads, so a transient failure can run it again. */
export function isRetryableProcedure(path: readonly string[]): boolean {
  return RETRYABLE_RPC_PROCEDURES.has(path.join("."));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Failures a retry cannot fix: someone's own input, a permission, a missing resource, or a
 * refusal that repeats exactly. They are refused even when a broad check would call them
 * retryable, so a client's mistake is never asked twice.
 */
function isPermanentRpcError(error: unknown): boolean {
  if (error instanceof ORPCError)
    return error.status < 500 && error.status !== 408 && error.status !== 429;
  return (
    error instanceof ClientError ||
    error instanceof IsolationError ||
    error instanceof ValidationError ||
    error instanceof ConnectionSetupError ||
    error instanceof ConnectorAuthUnavailableError ||
    error instanceof VoiceAccountError ||
    error instanceof SandboxAllowanceUsedError ||
    error instanceof ComputerRecoveryRequiredError ||
    error instanceof SandboxDamagedError ||
    error instanceof SandboxDiskTooLargeError ||
    isAbortError(error)
  );
}

/**
 * Whether a failed procedure may answer a moment later: an upstream or database was briefly
 * unavailable, or a provider transaction was busy. A refusal the caller caused never is.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (
    error instanceof ProviderTransactionBusyError ||
    error instanceof SandboxUnavailableError ||
    error instanceof SandboxUnresponsiveError ||
    error instanceof SandboxRateLimitError
  )
    return true;
  if (isPermanentRpcError(error)) return false;
  if (isDatabaseUnavailable(error)) return true;
  return isRetryableError(error);
}

/** One try plus two retries: a blip clears, and a real outage still fails within a second. */
const RPC_RETRY_ATTEMPTS = 3;
const RPC_RETRY_BASE_MS = 200;
/** Past this wait the answer is better returned to the client than held on the socket. */
const RPC_RETRY_INTERACTIVE_CAP_MS = 2_000;

function rpcRetryDelayMs(attempt: number, error: unknown): number {
  return retryDelayMs(error, RPC_RETRY_BASE_MS * 2 ** attempt);
}

export interface TransientRpcRetryOptions<T> {
  path: readonly string[];
  /** The request's signal: a client that disconnects ends the wait at once. */
  signal?: AbortSignal;
  run: () => Promise<T>;
}

/**
 * Runs a read-only procedure, retrying a transient failure twice. A failure that asks for a
 * longer wait than the interactive cap is returned as it is, so its `Retry-After` reaches the
 * client instead of the socket waiting it out here.
 */
export function retryTransientRpc<T>(options: TransientRpcRetryOptions<T>): Promise<T> {
  const { path, signal, run } = options;
  if (!isRetryableProcedure(path)) return run();
  return retry(run, {
    attempts: RPC_RETRY_ATTEMPTS,
    signal,
    delayMs: rpcRetryDelayMs,
    retryable: (error) =>
      isTransientRpcError(error) && rpcRetryDelayMs(0, error) <= RPC_RETRY_INTERACTIVE_CAP_MS,
    onRetry: (error, attempt, delayMs) => {
      enrichLogContext({ "rpc.retries": attempt + 1 });
      getLogger().warn(`rpc ${path.join("/")} retrying after a transient failure`, {
        "rpc.retry": attempt + 1,
        "rpc.retry.delay_ms": delayMs,
        "error.name": error instanceof Error ? error.name : typeof error,
      });
    },
  });
}
