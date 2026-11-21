import type { ConnectorTool } from "@rakazo/adapter-kit";
import { ticketRef } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { listSchedulesFromTool } from "../tools/schedule-tools.js";
import { listAgentSkillRecords } from "../tools/skill-tools.js";
import { listScratchpadItems } from "./scratchpad-tools.js";
import { TASK_CATALOG_GUIDANCE } from "./task-catalog.prompt.js";

export type TaskCatalogToolDeps = {
  prisma: PrismaClient;
};

type TaskCatalogInput = {
  spaceId: string;
  botId: string;
  userId: string;
  /** In a group run, marks which routines post in the group. */
  groupThreadId?: string;
  tools: readonly Pick<ConnectorTool, "name" | "description" | "readOnly">[];
};

async function listCatalogBoardTasks(
  prisma: PrismaClient,
  input: { spaceId: string; botId: string },
) {
  const board = await prisma.board.findUnique({
    where: { spaceId: input.spaceId },
    select: { id: true, ticketPrefix: true },
  });
  if (!board) return [];
  const rows = await prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      status: { notIn: ["done", "closed"] },
      OR: [
        { assigneeBotId: input.botId },
        { workerBotIds: { has: input.botId } },
        { ownerBotId: input.botId },
      ],
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  return rows.map((row) => ({
    id: row.id,
    ref: ticketRef(board.ticketPrefix, row.number),
    title: row.title,
    status: row.status,
    notes: row.description ?? "",
    source: "board" as const,
  }));
}

export async function taskCatalogFromTool(deps: TaskCatalogToolDeps, input: TaskCatalogInput) {
  const usesBoard = input.tools.some(
    (tool) =>
      tool.name === "board_tickets" || tool.name === "task_sync" || tool.name.startsWith("ticket_"),
  );
  const [tasks, schedules, taughtSkills, skills] = await Promise.all([
    usesBoard
      ? listCatalogBoardTasks(deps.prisma, { spaceId: input.spaceId, botId: input.botId })
      : listScratchpadItems(deps, {
          spaceId: input.spaceId,
          botId: input.botId,
          includeDone: false,
        }).then((items) =>
          items.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            notes: task.notes,
            source: "scratchpad" as const,
          })),
        ),
    listSchedulesFromTool(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      ...(input.groupThreadId ? { groupThreadId: input.groupThreadId } : {}),
    }),
    deps.prisma.taughtSkill.findMany({
      where: {
        spaceId: input.spaceId,
        botId: input.botId,
        status: "saved",
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, name: true, goal: true, status: true },
    }),
    listAgentSkillRecords(deps.prisma, {
      spaceId: input.spaceId,
      userId: input.userId,
    }),
  ]);

  const seenTools = new Set<string>();
  const exposedTools = input.tools.flatMap((tool) => {
    if (seenTools.has(tool.name)) return [];
    seenTools.add(tool.name);
    return [
      {
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly ?? false,
      },
    ];
  });

  return {
    guidance: TASK_CATALOG_GUIDANCE,
    tasks,
    routines: schedules.routines,
    ...(schedules.note ? { routinesNote: schedules.note } : {}),
    taughtSkills: taughtSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      goal: skill.goal,
      status: skill.status,
      source: "taught_skill",
    })),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      readOnly: skill.readOnly,
    })),
    tools: exposedTools,
  };
}
