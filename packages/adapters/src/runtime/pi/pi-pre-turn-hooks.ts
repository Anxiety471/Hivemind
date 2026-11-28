import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { formatPreTurnMemorySearch } from "./pi-pre-turn-memory.prompt.js";

/** Snapshot of the turn about to start, read by pre-turn hooks. */
export interface PiPreTurnContext {
  readonly runId: string;
  readonly prompt: string;
  readonly allowSilentEmpty: boolean;
  readonly optionalReply: boolean;
  readonly isRestored: boolean;
  readonly signal: AbortSignal;
  /** Names of every tool offered to this run: listed tools plus code-mode-callable ones. */
  readonly offeredToolNames: ReadonlySet<string>;
  /** Runs the run's memory searches; absent when the run offers none. */
  readonly preTurnMemorySearch?: AgentRunRequest["preTurnMemorySearch"];
}

/** `undefined` when the hook has nothing to add. */
export type PiPreTurnResult =
  | {
      /** Model-facing user messages, placed before the turn's prompt. */
      readonly contextMessages?: readonly string[];
      readonly logEvent?: string;
      readonly meta?: Record<string, unknown>;
    }
  | undefined;

/** Runs before the first model call of a fresh turn. A throw is logged and skipped. */
export interface PiPreTurnHook {
  readonly name: string;
  run(ctx: PiPreTurnContext): Promise<PiPreTurnResult> | PiPreTurnResult;
}

export const PRE_TURN_MEMORY_TIMEOUT_MS = 2_000;
const MAX_SEMANTIC_QUERY_CHARS = 240;
const MAX_DOC_QUERY_TERMS = 3;
const SPEAKER_PREFIX = /^(?:\s*\[[^\]\n]{1,80}\]:\s*)+/;
const TRIVIAL_ACKS = new Set([
  "ok",
  "yes",
  "no",
  "thanks",
  "thank you",
  "got it",
  "sure",
  "proceed",
  "continue",
  "done",
]);
const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "all",
  "also",
  "and",
  "any",
  "are",
  "but",
  "can",
  "could",
  "did",
  "does",
  "for",
  "from",
  "get",
  "got",
  "had",
  "has",
  "have",
  "her",
  "here",
  "him",
  "his",
  "how",
  "into",
  "just",
  "like",
  "make",
  "more",
  "need",
  "not",
  "now",
  "our",
  "out",
  "please",
  "should",
  "some",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "too",
  "use",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** A term that names something specific: an ID, a code, a proper name, or a path. */
function isSpecificTerm(term: string): boolean {
  return /[\d_/.-]/.test(term) || /[A-Z]/.test(term.slice(1));
}

/**
 * Up to three content words for `search_memory_docs`, which matches a document only when it
 * holds every word. Specific terms (IDs, names, codes) win over common words.
 */
function docSearchTerms(text: string): string {
  const seen = new Set<string>();
  const candidates = text
    .split(" ")
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .map((term) => ({ term }))
    .filter(({ term }) => term.length >= 3 && !STOPWORDS.has(term.toLowerCase()))
    .filter(({ term }) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(isSpecificTerm(b.term)) - Number(isSpecificTerm(a.term)) ||
      b.term.length - a.term.length,
  );
  const picked = new Set(ranked.slice(0, MAX_DOC_QUERY_TERMS));
  return candidates
    .filter((candidate) => picked.has(candidate))
    .map(({ term }) => term)
    .join(" ");
}

/**
 * The queries an automatic memory search runs for a prompt, or null when the prompt is too short
 * or only an acknowledgement and is not worth searching for.
 */
export function extractMemorySearchQuery(
  prompt: string,
): { semanticQuery: string; docQuery: string } | null {
  const text = prompt.replace(SPEAKER_PREFIX, "").replace(/\s+/g, " ").trim();
  if (text.length < 10) return null;
  if (
    TRIVIAL_ACKS.has(
      text
        .toLowerCase()
        .replace(/[^\p{L}\s]/gu, "")
        .trim(),
    )
  )
    return null;
  const semanticQuery = text.slice(0, MAX_SEMANTIC_QUERY_CHARS).trim();
  return { semanticQuery, docQuery: docSearchTerms(semanticQuery) };
}

const MEMORY_TOOL_NAMES = ["recall_memory", "search_memory_docs", "read_memory_doc"] as const;

/**
 * Searches the run's memory before the first model call, so an answer that depends on saved
 * notes does not start from nothing. It fails open: a slow or failed search only skips the note.
 */
export const autoMemorySearchPreTurnHook: PiPreTurnHook = {
  name: "auto_memory_search",
  async run(ctx) {
    if (ctx.isRestored || ctx.allowSilentEmpty || ctx.optionalReply || ctx.signal.aborted) {
      return undefined;
    }
    const search = ctx.preTurnMemorySearch;
    const offered = ctx.offeredToolNames;
    if (!search || (!offered.has("recall_memory") && !offered.has("search_memory_docs"))) {
      return undefined;
    }
    const queries = extractMemorySearchQuery(ctx.prompt);
    if (!queries) return undefined;
    const deadline = deadlineSignal(PRE_TURN_MEMORY_TIMEOUT_MS, ctx.signal);
    try {
      const hits = await withAbort(
        search({ ...queries, signal: deadline }),
        deadline,
        "Pre-turn memory search timed out.",
      );
      const recallHits = hits.recallHits ?? [];
      const docHits = hits.docHits ?? [];
      const availableTools = MEMORY_TOOL_NAMES.filter((name) => offered.has(name));
      return {
        contextMessages: [
          formatPreTurnMemorySearch({
            query: queries.semanticQuery,
            recallHits,
            docHits,
            availableTools,
          }),
        ],
        logEvent: "agent.pre_turn_memory_search",
        meta: { recallHits: recallHits.length, docHits: docHits.length },
      };
    } catch (error) {
      getLogger().warn("agent.pre_turn_hook_error", {
        runId: ctx.runId,
        hook: this.name,
        error,
      });
      return undefined;
    }
  },
};

export const DEFAULT_PI_PRE_TURN_HOOKS: readonly PiPreTurnHook[] = [autoMemorySearchPreTurnHook];

/**
 * Runs the hooks in order and collects their context messages. One failing hook is logged and
 * skipped, so it cannot stop the turn or the hooks after it.
 */
export async function runPreTurnHooks(
  hooks: readonly PiPreTurnHook[],
  ctx: PiPreTurnContext,
): Promise<string[]> {
  const messages: string[] = [];
  for (const hook of hooks) {
    try {
      const result = await hook.run(ctx);
      if (!result) continue;
      if (result.logEvent) {
        getLogger().info(result.logEvent, { runId: ctx.runId, hook: hook.name, ...result.meta });
      }
      for (const message of result.contextMessages ?? []) {
        if (message) messages.push(message);
      }
    } catch (error) {
      getLogger().warn("agent.pre_turn_hook_error", {
        runId: ctx.runId,
        hook: hook.name,
        error,
      });
    }
  }
  return messages;
}
