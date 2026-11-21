import { isRunWaitingOnUser, isRunWorking, STOPPED_HELPER_RESULT } from "@rakazo/core";

/** How a helper's card reads, plus the stopped case its run reports as cancelled. */
export type HelperThreadStatus = "running" | "completed" | "failed" | "stopped";

/** A helper card's own thread: what the viewer needs before its first read answers. */
export type HelperThreadTarget = {
  /** The saved card message that started the helper, which names its thread. */
  messageId: string;
  name: string;
  task: string;
  status: HelperThreadStatus;
};

/**
 * The message a card can open its helper's thread with. A live card from the current turn has
 * only a synthetic id and no thread, so it stays unopenable.
 */
export function helperCardMessageId(message: { id: string; botId?: string }): string | undefined {
  return message.botId && !message.id.startsWith("subagent:") ? message.id : undefined;
}

/** The target a saved helper card opens, from the block the transcript holds. */
export function helperThreadTarget(
  messageId: string,
  block: { name: string; task?: string; status: string; result?: string },
): HelperThreadTarget {
  const stopped = block.status === "failed" && block.result === STOPPED_HELPER_RESULT;
  return {
    messageId,
    name: block.name,
    task: block.task ?? "",
    status: stopped
      ? "stopped"
      : block.status === "completed"
        ? "completed"
        : block.status === "failed"
          ? "failed"
          : "running",
  };
}

/** The pushed route's params: strings only, and no empty task. */
export function helperThreadParams(target: HelperThreadTarget): Record<string, string> {
  return {
    messageId: target.messageId,
    name: target.name,
    status: target.status,
    ...(target.task ? { task: target.task } : {}),
  };
}

function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** Reads a helper viewer's route params. Without a card message there is nothing to open. */
export function helperThreadTargetFromParams(params: {
  messageId?: string | string[];
  name?: string | string[];
  task?: string | string[];
  status?: string | string[];
}): HelperThreadTarget | undefined {
  const messageId = param(params.messageId);
  if (!messageId) return undefined;
  const status = param(params.status);
  return {
    messageId,
    name: param(params.name),
    task: param(params.task),
    status:
      status === "completed" || status === "failed" || status === "stopped" ? status : "running",
  };
}

/**
 * The status a snapshot proves. A finished helper's snapshot no longer carries its run, so no
 * active run means it is done; the card's failure or stop still names how it ended.
 */
export function helperThreadStatus(
  snapshot: { run: { status: string } | null; activeRuns?: { status: string }[] } | null,
  fallback: HelperThreadStatus,
): HelperThreadStatus {
  if (!snapshot) return fallback;
  const runs = snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []);
  if (runs.some((run) => isRunWorking(run.status) || isRunWaitingOnUser(run.status)))
    return "running";
  if (fallback === "stopped" || snapshot.run?.status === "cancelled") return "stopped";
  if (fallback === "failed" || snapshot.run?.status === "failed") return "failed";
  return "completed";
}

/** The status a live event proves. */
export function helperThreadStatusAfterEvent(
  current: HelperThreadStatus,
  event: { type: string },
): HelperThreadStatus {
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.failed") return "failed";
  if (event.type === "run.cancelled") return "stopped";
  if (
    event.type === "run.started" ||
    event.type === "thread.progress" ||
    event.type === "thread.thinking" ||
    event.type === "thread.subagent" ||
    event.type === "agent.tool.called" ||
    event.type === "agent.tool.completed" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.released"
  )
    return "running";
  return current;
}
