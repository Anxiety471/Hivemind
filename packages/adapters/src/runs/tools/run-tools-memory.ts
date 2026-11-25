import { MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import {
  HistoryListInputSchema,
  HistoryReadInputSchema,
  HistorySearchInputSchema,
  isArchiveMemoryPath,
  MEMORY_INDEX_PATH,
} from "@rakazo/contracts";
import { byteLength } from "@rakazo/core";
import { listHistory, readHistory, searchHistory } from "@rakazo/db";
import { redactConnectorPayload } from "../../integrations/connector-safety.js";
import { editMemory } from "../../memory/memory-tools.js";
import { MAX_RECALLED_MEMORIES } from "../../runtime/context/history-compaction.prompt.js";
import { sharedMemorySaveError } from "../../tools/builtin.tool-definition.js";
import type { RunContext } from "../assembly/run-context.js";
import { markReadOutsideContent } from "../assembly/run-context.js";
import { argsError } from "../turn/tool-args.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** Cross-chat history requires a surviving direct human request in this app thread. */
export function historyMyChatsAllowed(
  run: { trigger: string; threadId: string },
  source: { role: string; threadId: string } | null,
  external: boolean,
): boolean {
  return (
    !external &&
    (run.trigger === "user" || run.trigger === "follow_up") &&
    source?.role === "user" &&
    source.threadId === run.threadId
  );
}

/**
 * Models often fill optional fields they do not use with "" or null (botId: "", linkedRunId: "").
 * No history field means anything when blank, so a blank field counts as not given.
 */
export function withoutBlankFields(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([, value]) => value !== null && !(typeof value === "string" && !value.trim()),
    ),
  );
}

async function readHistoryTool(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const { name, args } = call;
  const crossChat =
    name === "search_history"
      ? args.scope === "my_chats"
      : name === "list_history"
        ? args.scope === "my_chats" ||
          (typeof args.threadId === "string" &&
            args.threadId !== (ctx.source.conversationThreadId ?? run.threadId))
        : typeof args.threadId === "string" &&
          args.threadId !== (ctx.source.conversationThreadId ?? run.threadId);
  // Channel or webhook text claimed mid-turn revokes the grant for the rest of the run.
  const allowMyChats =
    crossChat && ctx.source.myChatsAllowed && !(await ctx.trust.receivedOutsideMessage());
  const scope = {
    spaceId: run.spaceId,
    threadId: ctx.source.conversationThreadId ?? run.threadId,
    botId: run.botId,
    channelId: ctx.source.channelId,
    searchBeforeSeq: ctx.source.historySearchBeforeSeq,
    allowMyChats,
    searchAt: run.createdAt,
    ...(run.trigger === "routine" ? { ownerOnly: run.userId } : {}),
  };
  const given = withoutBlankFields(args);
  let response: Awaited<ReturnType<typeof listHistory | typeof searchHistory | typeof readHistory>>;
  if (name === "search_history") {
    const parsed = HistorySearchInputSchema.safeParse(given);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    response = await searchHistory(deps.prisma, scope, parsed.data);
  } else if (name === "list_history") {
    const parsed = HistoryListInputSchema.safeParse(given);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    response = await listHistory(deps.prisma, scope, parsed.data);
  } else {
    const parsed = HistoryReadInputSchema.safeParse(given);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    response = await readHistory(deps.prisma, scope, parsed.data);
  }
  const redacted = redactConnectorPayload(response, ctx.secrets);
  // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
    return call.finish({
      untrusted: true,
      error:
        "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
    });
  }
  // Files the bot can now see are copied before its next computer tool.
  ctx.computer.copyEarlierFiles(
    response.messages.flatMap((message) =>
      (message.attachments ?? []).map((file) => ({
        kind: "file" as const,
        artifactId: file.artifactId,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
      })),
    ),
  );
  return call.finish(redacted);
}

/** Memory documents, semantic memory and thread history. */
export const memoryTools: ToolHandlers = {
  async remember(ctx, call) {
    const { deps, runId, bot, thread, context } = ctx;
    const { args } = call;
    // One document per bot keeps the size cap meaningful.
    const path = MEMORY_INDEX_PATH;
    // A concurrent save changes the revision, so re-read and apply the edit again.
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
      const existing = snapshot.documents[0];
      const edit = editMemory(
        existing?.content ?? "",
        String(args.content ?? ""),
        String(args.old_text ?? ""),
      );
      if ("error" in edit) return call.finish(edit);
      const { content } = edit;
      if (content === (existing?.content ?? "")) return call.finish({ ok: true });
      try {
        await deps.memory.commit(
          {
            scope: "bot",
            botId: bot.id,
            path,
            content,
            expectedRevision: existing?.revision ?? 0,
            sourceRunId: runId,
            sourceThreadId: thread.id,
          },
          context,
        );
        return call.finish({ ok: true });
      } catch (error) {
        if (!(error instanceof MemoryRevisionConflictError) || attempt >= 3) throw error;
      }
    }
  },
  async save_shared_memory(ctx, call) {
    const { deps, runId, thread, context } = ctx;
    const { args } = call;
    const invalid = sharedMemorySaveError(args);
    if (invalid) return call.finish({ error: invalid });
    const path = String(args.path ?? "").trim();
    // The save replaces the whole document. Pass the revision just read so a
    // concurrent edit is rejected instead of overwritten.
    const snapshot = await deps.memory.read({ scope: "user", path }, context);
    const expectedRevision = snapshot.documents[0]?.revision ?? 0;
    try {
      const saved = await deps.memory.commit(
        {
          scope: "user",
          path,
          content: String(args.content ?? ""),
          expectedRevision,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      );
      return call.finish({ ok: true, path: saved.path, revision: saved.revision });
    } catch (error) {
      if (error instanceof MemoryRevisionConflictError)
        return call.finish({ error: error.message });
      throw error;
    }
  },
  async recall_memory(ctx, call) {
    const { bot, thread, context } = ctx;
    const { args } = call;
    const response = await ctx.memory.semantic!.recall(
      {
        query: String(args.query ?? ""),
        scope: ctx.memory.scope!,
        botId: bot.id,
        ...(thread.historyCompactedUpToSeq == null
          ? {}
          : { historyGeneration: thread.historyCompactionGeneration }),
        limit: MAX_RECALLED_MEMORIES,
      },
      context,
    );
    // All recalled knowledge is derived data; an omitted provider marker cannot certify it.
    if (response.ok && response.value.length > 0) {
      await markReadOutsideContent(ctx);
    }
    return response;
  },
  async reflect_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic?.reflect) {
      return { error: "This memory provider cannot answer questions from memory." };
    }
    const response = await ctx.memory.semantic.reflect(
      { query: String(args.query ?? ""), botId: bot.id },
      context,
    );
    if (!response.ok) return response;
    const text = response.value.trim();
    // Reflection is provider-generated prose; it cannot attest that its answer is clean.
    if (text) await markReadOutsideContent(ctx);
    return { ok: true, value: text || "No relevant memories." };
  },
  search_history: readHistoryTool,
  read_history: readHistoryTool,
  list_history: readHistoryTool,
  async save_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    return call.finish(
      await ctx.memory.semantic!.save(
        {
          content: String(args.content ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          source: { kind: "durable" },
        },
        context,
      ),
    );
  },
  async forget_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic?.forget) {
      return call.finish({
        error: "This memory provider does not support forgetting individual facts.",
      });
    }
    return call.finish(
      await ctx.memory.semantic.forget(
        {
          id: String(args.id ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          ...(typeof args.entity === "string" && args.entity.trim()
            ? { entity: args.entity.trim() }
            : {}),
          ...(typeof args.reason === "string" && args.reason.trim()
            ? { reason: args.reason.trim() }
            : {}),
        },
        context,
      ),
    );
  },
  async search_memory_docs(ctx, call) {
    const { deps, bot, context } = ctx;
    const { args } = call;
    const scopeArg =
      args.scope === "bot" || args.scope === "user" || args.scope === "all" ? args.scope : "all";
    const archiveOnly = args.archive_only === true;
    const rawLimit = Number(args.limit);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 20) : 10;
    const query = typeof args.query === "string" ? args.query.trim() : "";

    const snapshots = await Promise.all([
      scopeArg === "user"
        ? Promise.resolve({ documents: [] })
        : deps.memory.read({ scope: "bot", botId: bot.id }, context),
      scopeArg === "bot"
        ? Promise.resolve({ documents: [] })
        : deps.memory.read({ scope: "user" }, context),
    ]);
    const combined = [
      ...snapshots[0].documents.map((doc) => ({ ...doc, scope: "bot" as const })),
      ...snapshots[1].documents.map((doc) => ({ ...doc, scope: "user" as const })),
    ]
      .filter((doc) => !archiveOnly || isArchiveMemoryPath(doc.path))
      .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));

    if (!query) {
      const documents = combined.slice(0, limit).map((doc) => ({
        scope: doc.scope,
        path: doc.path,
        revision: doc.revision,
        bytes: byteLength(doc.content),
        updatedAt: doc.updatedAt,
        archived: isArchiveMemoryPath(doc.path),
      }));
      return call.finish(redactConnectorPayload({ documents }, ctx.secrets));
    }

    const loweredQuery = query.toLowerCase();
    const tokens = loweredQuery.split(/\s+/).filter(Boolean);
    const matches = combined
      .filter((doc) => {
        const haystack = `${doc.path}\n${doc.content}`.toLowerCase();
        return tokens.every((token) => haystack.includes(token)) || haystack.includes(loweredQuery);
      })
      .slice(0, limit)
      .map((doc) => ({
        scope: doc.scope,
        path: doc.path,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
        archived: isArchiveMemoryPath(doc.path),
        snippet: memorySnippet(doc.content, tokens, loweredQuery),
      }));
    return call.finish(redactConnectorPayload({ matches }, ctx.secrets));
  },
  async read_memory_doc(ctx, call) {
    const { deps, bot, context } = ctx;
    const { args } = call;
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path || path.startsWith("/") || path.includes("..")) {
      return call.finish({ error: "Invalid memory document path." });
    }
    const rawOffset = Number(args.offset);
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const requestedScope = args.scope === "bot" || args.scope === "user" ? args.scope : undefined;

    let scope: "bot" | "user" | undefined = requestedScope;
    let doc = (
      await deps.memory.read(
        requestedScope === "user" ? { scope: "user", path } : { scope: "bot", botId: bot.id, path },
        context,
      )
    ).documents[0];
    if (!doc && !requestedScope) {
      doc = (await deps.memory.read({ scope: "user", path }, context)).documents[0];
      if (doc) scope = "user";
    } else if (doc && !scope) {
      scope = "bot";
    }
    if (!doc || !scope) {
      return call.finish({
        error: "Memory document not found. Call search_memory_docs to list available paths.",
      });
    }

    const pageChars = 8_000;
    const totalLength = doc.content.length;
    const content = doc.content.slice(offset, offset + pageChars);
    const nextOffset = offset + content.length < totalLength ? offset + content.length : undefined;
    return call.finish(
      redactConnectorPayload(
        {
          scope,
          path: doc.path,
          revision: doc.revision,
          updatedAt: doc.updatedAt,
          content,
          offset,
          totalLength,
          ...(nextOffset === undefined ? {} : { nextOffset }),
        },
        ctx.secrets,
      ),
    );
  },
};

function memorySnippet(content: string, tokens: readonly string[], fullQuery: string): string {
  const lower = content.toLowerCase();
  let idx = lower.indexOf(fullQuery);
  if (idx < 0) {
    for (const token of tokens) {
      const hit = lower.indexOf(token);
      if (hit >= 0) {
        idx = hit;
        break;
      }
    }
  }
  if (idx < 0) return content.slice(0, 240);
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, start + 240);
  return content.slice(start, end);
}
