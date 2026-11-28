import { MEMORY_REVISION_CONFLICT_ERROR, MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { memoryTools, preTurnMemorySearch, withoutBlankFields } from "./run-tools-memory.js";

describe("history tool arguments", () => {
  it("treats blank and null optional fields as not given", () => {
    expect(
      HistorySearchInputSchema.parse(
        withoutBlankFields({ queries: ["Aurora"], botId: "", before: " ", query: null }),
      ),
    ).toEqual({ queries: ["Aurora"] });
    expect(
      HistoryReadInputSchema.parse(
        withoutBlankFields({
          messageId: "cmw3l7emsa1sfb5bml8d0doe0",
          linkedRunId: "",
          threadId: "",
        }),
      ),
    ).toEqual({ messageId: "cmw3l7emsa1sfb5bml8d0doe0" });
  });
});

it.each(["isolated", "shared"])(
  "applies outside-input protections to explicit recall in %s scope",
  async (scope) => {
    const response = { ok: true, value: [{ memory: "A shared preference", score: 1 }] };
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { historyCompactedUpToSeq: null },
      context: {},
      state: { tainted: false },
      memory: { scope, semantic: { recall: vi.fn(async () => response) } },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    expect(
      await memoryTools.recall_memory!(ctx as never, { args: { query: "preference" } } as never),
    ).toEqual(response);
    expect(ctx.state.tainted).toBe(true);
  },
);

it.each(["Provider-generated context", ""])(
  "records reflection exposure only for a nonempty answer: %j",
  async (text) => {
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      context: {},
      state: { tainted: false },
      memory: { semantic: { reflect: vi.fn(async () => ({ ok: true, value: text })) } },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    await memoryTools.reflect_memory!(ctx as never, { args: { query: "Question" } } as never);
    expect(ctx.state.tainted).toBe(Boolean(text));
  },
);

describe("saving shared memory over a newer revision", () => {
  const save = (failure: Error) => {
    const finish = vi.fn((result: unknown) => result);
    const ctx = {
      runId: "run-1",
      thread: { id: "thread-1" },
      context: {},
      deps: {
        memory: {
          read: vi.fn(async () => ({ documents: [{ revision: 1 }] })),
          commit: vi.fn().mockRejectedValue(failure),
        },
      },
    };
    return memoryTools.save_shared_memory!(
      ctx as never,
      { args: { path: "team.md", content: "new" }, finish } as never,
    );
  };

  it("tells the bot to read again", async () => {
    await expect(save(new MemoryRevisionConflictError())).resolves.toEqual({
      error: MEMORY_REVISION_CONFLICT_ERROR,
    });
  });

  it("lets another failure through, even one quoting the conflict", async () => {
    const failure = new Error(MEMORY_REVISION_CONFLICT_ERROR);
    await expect(save(failure)).rejects.toBe(failure);
  });
});

describe("cold memory document tools", () => {
  const makeCtx = () => ({
    bot: { id: "bot-1" },
    context: {},
    secrets: ["super-secret-token"],
    deps: {
      memory: {
        read: vi.fn(async ({ scope, path }: { scope: "bot" | "user"; path?: string }) => {
          const all =
            scope === "bot"
              ? [
                  {
                    id: "b1",
                    path: "MEMORY.md",
                    content: "# Bot\n\n- active task",
                    revision: 2,
                    updatedAt: "2026-11-25T10:00:00.000Z",
                  },
                  {
                    id: "b2",
                    path: "archive/2026-11.md",
                    content: "- [2026-11-10] Migrated billing using super-secret-token",
                    revision: 3,
                    updatedAt: "2026-11-20T10:00:00.000Z",
                  },
                ]
              : [
                  {
                    id: "u1",
                    path: "USER.md",
                    content: "# User\n\n- Name: Sam",
                    revision: 1,
                    updatedAt: "2026-11-24T10:00:00.000Z",
                  },
                  {
                    id: "u2",
                    path: "archive/2026-10.md",
                    content: `- [2026-10-01] Old Space event\n${"x".repeat(8_050)}`,
                    revision: 1,
                    updatedAt: "2026-10-01T10:00:00.000Z",
                  },
                ];
          return { documents: path ? all.filter((doc) => doc.path === path) : all };
        }),
      },
    },
  });

  it("lists and searches memory documents with archive filtering and secret redaction", async () => {
    const finish = vi.fn((result: unknown) => result);
    const ctx = makeCtx();

    const listed = (await memoryTools.search_memory_docs!(
      ctx as never,
      { args: { archive_only: true }, finish } as never,
    )) as { documents: Array<{ path: string; archived: boolean }> };
    expect(listed.documents.map((d) => d.path)).toEqual([
      "archive/2026-11.md",
      "archive/2026-10.md",
    ]);
    expect(listed.documents.every((d) => d.archived)).toBe(true);

    const found = (await memoryTools.search_memory_docs!(
      ctx as never,
      { args: { query: "billing migrated" }, finish } as never,
    )) as { matches: Array<{ path: string; snippet: string }> };
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]?.path).toBe("archive/2026-11.md");
    expect(found.matches[0]?.snippet).not.toContain("super-secret-token");
  });

  it("reads memory documents by path with scope fallback and paging", async () => {
    const finish = vi.fn((result: unknown) => result);
    const ctx = makeCtx();

    const first = (await memoryTools.read_memory_doc!(
      ctx as never,
      { args: { path: "archive/2026-10.md" }, finish } as never,
    )) as { scope: string; content: string; nextOffset?: number };
    expect(first.scope).toBe("user");
    expect(first.content.length).toBe(8_000);
    expect(first.nextOffset).toBe(8_000);

    const second = (await memoryTools.read_memory_doc!(
      ctx as never,
      {
        args: { path: "archive/2026-10.md", scope: "user", offset: first.nextOffset },
        finish,
      } as never,
    )) as { content: string; nextOffset?: number };
    expect(second.content.length).toBeGreaterThan(0);
    expect(second.nextOffset).toBeUndefined();

    const missing = await memoryTools.read_memory_doc!(
      ctx as never,
      { args: { path: "archive/missing.md" }, finish } as never,
    );
    expect(missing).toEqual({
      error: "Memory document not found. Call search_memory_docs to list available paths.",
    });
  });
});

describe("pre-turn memory search", () => {
  const makeCtx = (
    offered: string[],
    recall = vi.fn(
      async (): Promise<{ ok: boolean; value?: unknown; error?: string }> => ({
        ok: true,
        value: [],
      }),
    ),
  ) => ({
    bot: { id: "bot-1" },
    thread: { historyCompactedUpToSeq: null },
    context: {},
    secrets: ["super-secret-token"],
    tools: { offered: offered.map((name) => ({ name })) },
    state: { tainted: false },
    memory: { scope: "bot", semantic: { recall } },
    deps: {
      memory: {
        read: vi.fn(async ({ scope }: { scope: "bot" | "user" }) => ({
          documents:
            scope === "bot"
              ? [
                  {
                    id: "b1",
                    path: "notes/billing.md",
                    content: "Billing migrated with super-secret-token",
                    revision: 1,
                    updatedAt: "2026-11-20T10:00:00.000Z",
                  },
                ]
              : [],
        })),
      },
    },
  });

  it("returns redacted recall and document hits and marks the run as reading outside content", async () => {
    const recall = vi.fn(async () => ({
      ok: true,
      value: [{ memory: "Key is super-secret-token", score: 1, id: "m1", provenance: "chat" }],
    }));
    const ctx = makeCtx(["recall_memory", "search_memory_docs"], recall);

    const result = await preTurnMemorySearch(ctx as never, {
      semanticQuery: "billing key",
      docQuery: "billing",
    });

    expect(result).toEqual({
      recallHits: [{ memory: "Key is [redacted]", id: "m1", provenance: "chat" }],
      docHits: [{ scope: "bot", path: "notes/billing.md", snippet: expect.any(String) }],
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ query: "billing key" }), {});
    expect(ctx.state.tainted).toBe(true);
  });

  it("stops the provider call when the caller's signal aborts", async () => {
    const recall = vi.fn(async () => ({ ok: true, value: [] }));
    const ctx = {
      ...makeCtx(["recall_memory"], recall),
      context: { signal: new AbortController().signal },
    };
    const controller = new AbortController();

    const search = preTurnMemorySearch(ctx as never, {
      semanticQuery: "billing key",
      docQuery: "",
      signal: controller.signal,
    });
    controller.abort();
    await search;

    const [, passed] = recall.mock.calls[0] as unknown as [unknown, { signal: AbortSignal }];
    expect(passed.signal.aborted).toBe(true);
  });

  it("searches only the tools the run offers", async () => {
    const ctx = makeCtx(["search_memory_docs"]);

    const result = await preTurnMemorySearch(ctx as never, {
      semanticQuery: "billing key",
      docQuery: "billing",
    });

    expect(result.recallHits).toBeUndefined();
    expect(ctx.memory.semantic.recall).not.toHaveBeenCalled();
    expect(result.docHits).toHaveLength(1);
  });

  it("reports the search that failed as missing and keeps the one that ran", async () => {
    const ctx = makeCtx(
      ["recall_memory", "search_memory_docs"],
      vi.fn(async () => ({ ok: false, error: "provider down" })),
    );

    const result = await preTurnMemorySearch(ctx as never, {
      semanticQuery: "billing key",
      docQuery: "billing",
    });

    expect(result.recallHits).toBeUndefined();
    expect(result.docHits).toHaveLength(1);
  });

  it("rejects when every search it ran failed", async () => {
    const ctx = makeCtx(
      ["recall_memory"],
      vi.fn(async () => ({ ok: false, error: "provider down" })),
    );

    await expect(
      preTurnMemorySearch(ctx as never, { semanticQuery: "billing key", docQuery: "" }),
    ).rejects.toThrow("provider down");
  });
});
