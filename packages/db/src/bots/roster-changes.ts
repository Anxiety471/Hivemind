import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { abortableDelay } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "../database/client.js";
import { retryWhileDatabaseUnavailable } from "../database/database-outage.js";
import { runAsSystem } from "../database/row-security.js";
import { ChangeLatch, threadTopic } from "../threads/event-stream.js";

/** Who may see a roster change: every member of these Spaces, and these people. */
export type RosterChange = { spaceIds?: readonly string[]; userIds?: readonly string[] };

/** What a member's sidebar shows: their Spaces, and the chats in them. */
export type RosterScope = { spaceIds: readonly string[]; threadIds: readonly string[] };

/** A streaming reply changes its chat often; the sidebar refetches at most this often. */
export const ROSTER_SIGNAL_SPACING_MS = 10_000;
const IDLE_WAIT_MS = 60_000;

const spaceTopic = (spaceId: string) => `roster-space:${spaceId}`;
const userTopic = (userId: string) => `roster-user:${userId}`;

/**
 * Events in a chat that stream while a bot works but change nothing the sidebar shows. Its
 * preview, unread mark and run status move with messages and run transitions, not with the
 * progress, reasoning, tool, computer and effect events that dominate a run.
 */
const QUIET_THREAD_EVENTS: Record<string, true> = {
  "agent.tool.called": true,
  "agent.tool.completed": true,
  "computer.command": true,
  "computer.status": true,
  "computer.takeover.granted": true,
  "computer.takeover.released": true,
  "computer.takeover.requested": true,
  "effect.recorded": true,
  "effect.reconciled": true,
  heartbeat: true,
  "run.checkpointed": true,
  "run.steering.claimed": true,
  "thread.artifact": true,
  "thread.cloud_agent": true,
  "thread.computer": true,
  "thread.progress": true,
  "thread.subagent": true,
  "thread.thinking": true,
  "usage.recorded": true,
};

/**
 * Whether waking for this event can change the member's sidebar. A publisher that names no type
 * may have changed anything, so it wakes as before.
 */
export function threadEventChangesRoster(type: string | undefined): boolean {
  return type === undefined || !Object.hasOwn(QUIET_THREAD_EVENTS, type);
}

/** The event type a thread signal names, if it names one. */
function signalledType(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { type?: unknown } | null;
    return typeof parsed?.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

const PUBLISH_RETRY_MS = 15_000;

/**
 * Apps re-read the roster only on these signals, so a publish rides out a short database outage in
 * the background, without holding up the change. Past that it gives up; apps catch up when their
 * stream reopens.
 */
export function publishRosterChange(
  realtime: RealtimeFanout | undefined,
  change: RosterChange,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  if (!realtime) return Promise.resolve();
  const topics = [
    ...(change.spaceIds ?? []).map(spaceTopic),
    ...(change.userIds ?? []).map(userTopic),
  ];
  for (const topic of topics)
    void retryWhileDatabaseUnavailable(() => realtime.publish(topic, ""), {
      source: "roster signal",
      waitMs: PUBLISH_RETRY_MS,
      ...options,
    }).catch((error: unknown) => getLogger().warn("roster signal not published", { error }));
  return Promise.resolve();
}

export function loadRosterScope(prisma: PrismaClient, userId: string): Promise<RosterScope> {
  return runAsSystem("roster signals across the member's Spaces", async () => {
    const memberships = await prisma.spaceMember.findMany({
      where: { userId },
      select: { spaceId: true },
    });
    const spaceIds = memberships.map((membership) => membership.spaceId);
    const threads = await prisma.thread.findMany({
      where: { spaceId: { in: spaceIds }, helperBotId: null },
      select: { id: true },
    });
    return { spaceIds, threadIds: threads.map((thread) => thread.id) };
  });
}

/**
 * Signals once when following starts, then whenever the member's sidebar may have changed: a
 * roster change published for them or one of their Spaces, or an event that changes a chat's
 * preview, unread mark or run status. A run's progress, reasoning, tool, computer and effect
 * events wake nobody: they change none of those, and a bot working all day would otherwise
 * re-read the whole roster every spacing. Signals carry no content. The scope is re-read after
 * each wake so new chats and Spaces join, and signals are spaced so a burst becomes one.
 */
export async function* followRosterChanges(
  realtime: RealtimeFanout,
  userId: string,
  loadScope: () => Promise<RosterScope>,
  signal?: AbortSignal,
  spacingMs = ROSTER_SIGNAL_SPACING_MS,
): AsyncGenerator<void> {
  const latch = new ChangeLatch();
  const subscriptions = new Map<string, () => Promise<void>>();
  const watch = async () => {
    const scope = await loadScope();
    const topics = new Set([
      userTopic(userId),
      ...scope.spaceIds.map(spaceTopic),
      ...scope.threadIds.map(threadTopic),
    ]);
    for (const [topic, unsubscribe] of subscriptions) {
      if (topics.has(topic)) continue;
      subscriptions.delete(topic);
      await unsubscribe();
    }
    for (const topic of topics) {
      if (subscriptions.has(topic)) continue;
      subscriptions.set(
        topic,
        await realtime.subscribe(topic, (payload) => {
          if (threadEventChangesRoster(signalledType(payload))) latch.notify();
        }),
      );
    }
  };
  try {
    await watch();
    let seen = latch.generation;
    // The first signal tells the client push works, and covers what it missed while away.
    yield;
    while (!signal?.aborted) {
      await latch.waitForChange(seen, IDLE_WAIT_MS, signal);
      if (signal?.aborted) return;
      if (latch.generation === seen) {
        // An idle check also picks up chats a missed roster signal never told this stream about.
        await watch().catch(() => undefined);
        continue;
      }
      seen = latch.generation;
      // A failed re-read keeps the chats already watched; the next wake tries again.
      await watch().catch(() => undefined);
      yield;
      await abortableDelay(spacingMs, signal);
    }
  } finally {
    await Promise.all([...subscriptions.values()].map((unsubscribe) => unsubscribe()));
  }
}
