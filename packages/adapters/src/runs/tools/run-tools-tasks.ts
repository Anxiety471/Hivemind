import {
  desktopGuardApplies,
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "../../providers/computer/desktop/desktop-command-guard.js";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "../../tasks/scratchpad-tools.js";
import { taskCatalogFromTool } from "../../tasks/task-catalog.js";
import type { TaskSyncAction } from "../../tasks/task-detect.js";
import { syncTasksViaGoOrLocal } from "../../tasks/task-detect.js";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
  validateBlockedTicketMention,
} from "../../tasks/ticket-tools.js";
import {
  cancelScheduleFromTool,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  isScheduleValueProvided,
  listSchedulesFromTool,
  scheduleCreateError,
  scheduleCreateFields,
  scheduleTimingArgs,
  updateScheduleFromTool,
} from "../../tools/schedule-tools.js";
import {
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "../../tools/skill-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** A command watch may not run what the desktop guard keeps the bot from running itself. */
function commandWatchGuardError(ctx: RunContext, watch: unknown): string | undefined {
  const command = commandWatchFromTool(watch);
  const refusal = command === undefined ? undefined : protectedComputerLifecycleRefusal(command);
  return desktopGuardApplies(ctx.computer) && refusal
    ? desktopProtectionGuardMessage(refusal, command ?? "")
    : undefined;
}

/**
 * What `schedule_create` refuses before saving anything. Checked before the approval gate,
 * so a routine that cannot be saved returns its error and shows no card; the handler checks again.
 */
export async function scheduleCreateRefusal(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<{ error: string } | undefined> {
  const { deps, run, bot, thread } = ctx;
  const error =
    commandWatchGuardError(ctx, args.watch) ??
    (await scheduleCreateError(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      threadId: thread.id,
      ...scheduleCreateFields(args),
    }));
  return error ? { error } : undefined;
}

/** The task catalog, scratchpad, ticket board, schedules and skills. */
export const taskTools: ToolHandlers = {
  async task_catalog(ctx) {
    const { deps, run, bot, thread } = ctx;
    return taskCatalogFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      ...(thread.groupId ? { groupThreadId: thread.id } : {}),
      tools: ctx.tools.offered,
    });
  },
  async scratchpad_list(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return listScratchpadItemsFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      includeDone: Boolean(args.includeDone),
    });
  },
  async scratchpad_add(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const created = await addScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      title: String(args.title ?? ""),
      status: args.status ? String(args.status) : undefined,
      notes: args.notes !== undefined ? String(args.notes) : undefined,
    });
    return call.finish(created);
  },
  async scratchpad_update(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const updated = await updateScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
      title: args.title !== undefined ? String(args.title) : undefined,
      status: args.status !== undefined ? String(args.status) : undefined,
      notes: args.notes !== undefined ? String(args.notes) : undefined,
    });
    return call.finish(updated);
  },
  async scratchpad_complete(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const completed = await completeScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
    });
    return call.finish(completed);
  },
  async scratchpad_remove(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const removed = await removeScratchpadItemFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      itemId: String(args.itemId ?? ""),
    });
    return call.finish(removed);
  },
  async board_tickets(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    const ownerUserId =
      args.ownerUserId !== undefined
        ? String(args.ownerUserId) === "me"
          ? run.userId
          : String(args.ownerUserId)
        : undefined;
    return call.finish(
      await listBoardTickets(deps, {
        spaceId: run.spaceId,
        status: args.status !== undefined ? String(args.status) : undefined,
        ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
        ownerUserId,
        workerBotId: args.workerBotId !== undefined ? String(args.workerBotId) : undefined,
        cursor: args.cursor !== undefined ? String(args.cursor) : undefined,
      }),
    );
  },
  async ticket_get(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await getTicket(deps, {
        spaceId: run.spaceId,
        ref: String(args.ref ?? ""),
      }),
    );
  },
  async ticket_create(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const ownerUserId =
      args.ownerUserId !== undefined
        ? String(args.ownerUserId) === "me"
          ? run.userId
          : String(args.ownerUserId)
        : undefined;
    const workerBotIds = Array.isArray(args.workerBotIds)
      ? args.workerBotIds.filter((item): item is string => typeof item === "string")
      : undefined;
    return call.finish(
      await createTicket(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        title: String(args.title ?? ""),
        description: args.description !== undefined ? String(args.description) : undefined,
        priority: args.priority !== undefined ? String(args.priority) : undefined,
        ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
        ownerUserId,
        workerBotIds,
      }),
    );
  },
  async ticket_update(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    const ownerUserId =
      args.ownerUserId !== undefined
        ? String(args.ownerUserId) === "me"
          ? run.userId
          : String(args.ownerUserId)
        : undefined;
    const workerBotIds = Array.isArray(args.workerBotIds)
      ? args.workerBotIds.filter((item): item is string => typeof item === "string")
      : undefined;
    return call.finish(
      await updateTicket(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        id: String(args.id ?? ""),
        title: args.title !== undefined ? String(args.title) : undefined,
        description: args.description !== undefined ? String(args.description) : undefined,
        priority: args.priority !== undefined ? String(args.priority) : undefined,
        status: args.status !== undefined ? String(args.status) : undefined,
        ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
        ownerUserId,
        workerBotIds,
      }),
    );
  },
  async ticket_comment(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args } = call;
    return call.finish(
      await commentTicket(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        id: String(args.id ?? ""),
        body: String(args.body ?? ""),
      }),
    );
  },
  async task_sync(ctx, call) {
    const { deps, run, bot } = ctx;
    const rawActions = Array.isArray(call.args.actions) ? call.args.actions : [];
    const actions: TaskSyncAction[] = [];
    for (const entry of rawActions) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const op = item.op === "create" || item.op === "update" ? item.op : null;
      if (!op) continue;
      const ownerUserId =
        typeof item.ownerUserId === "string"
          ? item.ownerUserId === "me"
            ? run.userId
            : item.ownerUserId
          : undefined;
      const workerBotIds = Array.isArray(item.workerBotIds)
        ? item.workerBotIds.filter((id): id is string => typeof id === "string")
        : undefined;
      actions.push({
        op,
        ...(typeof item.ticketId === "string" ? { ticketId: item.ticketId } : {}),
        ...(typeof item.ref === "string" ? { ref: item.ref } : {}),
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}),
        ...(typeof item.priority === "string" ? { priority: item.priority } : {}),
        ...(typeof item.ownerBotId === "string" ? { ownerBotId: item.ownerBotId } : {}),
        ...(ownerUserId !== undefined ? { ownerUserId } : {}),
        ...(workerBotIds !== undefined ? { workerBotIds } : {}),
      });
    }
    for (const action of actions) {
      if (action.status === "blocked") {
        const mentionError = await validateBlockedTicketMention(deps, {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          ticketId: action.ticketId,
          description: action.description,
        });
        if (mentionError) return call.finish({ error: mentionError });
      }
    }
    return call.finish(
      await syncTasksViaGoOrLocal(deps, {
        runId: run.id,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: bot.id,
        actions,
      }),
    );
  },
  async schedule_create(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    const refusal = commandWatchGuardError(ctx, args.watch);
    if (refusal) return call.finish({ error: refusal });
    const created = await createScheduleFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      userId: run.userId,
      threadId: thread.id,
      ...scheduleCreateFields(args),
    });
    return call.finish(created);
  },
  async schedule_update(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    return call.finish(
      await updateScheduleFromTool(deps, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        threadId: thread.id,
        ...(thread.groupId ? { scopeThreadId: thread.id } : {}),
        routineId: String(args.routineId ?? ""),
        name: isScheduleValueProvided(args.name) ? String(args.name) : undefined,
        prompt: isScheduleValueProvided(args.prompt) ? String(args.prompt) : undefined,
        inChat: typeof args.inChat === "boolean" ? args.inChat : undefined,
        active: typeof args.active === "boolean" ? args.active : undefined,
        timezone: isScheduleValueProvided(args.timezone) ? String(args.timezone) : undefined,
        schedule: compactScheduleInput(scheduleTimingArgs(args)),
        on: isScheduleValueProvided(args.on) ? args.on : undefined,
      }),
    );
  },
  async schedule_list(ctx) {
    const { deps, run, bot, thread } = ctx;
    return listSchedulesFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      ...(thread.groupId ? { groupThreadId: thread.id } : {}),
    });
  },
  async schedule_cancel(ctx, call) {
    const { deps, run, bot, thread } = ctx;
    const { args } = call;
    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: run.spaceId,
      botId: bot.id,
      ...(thread.groupId ? { threadId: thread.id } : {}),
      routineId: args.routineId ? String(args.routineId) : undefined,
      name: args.name ? String(args.name) : undefined,
    });
    return call.finish(cancelled);
  },
  async skill_read(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return skillReadFromTool(
      deps.prisma,
      {
        spaceId: run.spaceId,
        userId: run.userId,
      },
      {
        name: args.name ? String(args.name) : undefined,
        skillId: args.skillId ? String(args.skillId) : undefined,
        file: args.file ? String(args.file) : undefined,
      },
    );
  },
  async skill_create(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillCreateFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          description: args.description ? String(args.description) : undefined,
          body: args.body ? String(args.body) : undefined,
          content: args.content ? String(args.content) : undefined,
        },
      ),
    );
  },
  async skill_update(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillUpdateFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          skillId: args.skillId ? String(args.skillId) : undefined,
          newName: args.newName ? String(args.newName) : undefined,
          description: args.description !== undefined ? String(args.description) : undefined,
          body: args.body !== undefined ? String(args.body) : undefined,
          content: args.content ? String(args.content) : undefined,
        },
      ),
    );
  },
  async skill_delete(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    return call.finish(
      await skillDeleteFromTool(
        deps.prisma,
        {
          spaceId: run.spaceId,
          userId: run.userId,
        },
        {
          name: args.name ? String(args.name) : undefined,
          skillId: args.skillId ? String(args.skillId) : undefined,
        },
      ),
    );
  },
};
