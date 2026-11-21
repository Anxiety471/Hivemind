import { deadlineSignal } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { taskDetectBaseUrl } from "./task-detect.js";

const TASK_QUEUE_HTTP_TIMEOUT_MS = 3_000;

/**
 * Enqueues a ticket worker wake onto the Go Redis task queue (with retries and
 * dead-letter handling). Returns true when Go accepted it, or false when the
 * internal endpoint is not configured or unreachable so the caller falls back
 * to the local Postgres wake path.
 */
export async function dispatchTicketWakeViaGo(input: {
  spaceId: string;
  ticketId: string;
  botId: string;
  note?: string;
}): Promise<boolean> {
  const baseUrl = taskDetectBaseUrl();
  if (!baseUrl) return false;
  try {
    const response = await fetch(`${baseUrl}/internal/task-queue/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: deadlineSignal(TASK_QUEUE_HTTP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    getLogger().warn("task.queue dispatch unavailable, falling back locally", {
      "ticket.id": input.ticketId,
      "bot.id": input.botId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
