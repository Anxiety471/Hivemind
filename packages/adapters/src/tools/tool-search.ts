/**
 * Shared weighted multi-field search and ranking engine for `code_mode` tools, saved commands,
 * and lazy connector catalogs. Deterministic, dependency-free, and linear in candidate count.
 */

export interface SearchableItem<T> {
  item: T;
  name: string;
  aliases?: readonly string[];
  group?: string;
  params?: readonly string[];
  description?: string;
  paramDescriptions?: readonly string[];
}

export interface SearchOptions {
  limit?: number;
  /** Optional tie-breaker when two items have equal relevance and coverage. */
  tieBreak?: (leftName: string, rightName: string) => number;
}

export interface SearchRankResult<T> {
  hits: T[];
  /** True when at least one hit matched every query token without needing partial fallback. */
  complete: boolean;
  queryTokens: string[];
}

const SYNONYM_CLUSTERS: readonly (readonly string[])[] = [
  ["delete", "remove", "rm", "destroy", "drop"],
  ["create", "add", "new", "make", "insert"],
  ["update", "edit", "modify", "patch", "change", "set"],
  ["list", "ls", "browse", "enumerate"],
  ["search", "find", "query", "lookup", "filter"],
  ["get", "fetch", "read", "retrieve", "show", "view"],
  ["send", "post", "publish", "deliver"],
  ["email", "mail", "gmail", "inbox"],
  ["calendar", "cal", "gcal", "schedule", "meeting"],
  ["message", "msg", "chat", "dm", "reply"],
  ["file", "doc", "document", "drive", "folder", "dir"],
  ["repo", "repository", "git", "github"],
  ["issue", "ticket", "bug", "task"],
  ["secret", "credential", "token", "key", "password", "vault"],
  ["user", "member", "person", "account", "profile"],
  ["db", "database", "sql", "table", "record", "row"],
];

const NO_SINGULAR_SUFFIX = new Set(["ss", "us", "is"]);

/** Lightweight deterministic suffix stemmer for English/API identifier tokens. */
export function stemToken(token: string): string {
  const lower = token.toLowerCase();
  if (lower.length >= 5 && lower.endsWith("ies")) {
    return `${lower.slice(0, -3)}y`;
  }
  if (lower.length >= 5 && lower.endsWith("ied")) {
    return `${lower.slice(0, -3)}y`;
  }
  if (lower.length >= 5 && /(?:s|x|z|ch|sh)es$/.test(lower)) {
    return lower.slice(0, -2);
  }
  if (lower.length >= 4 && lower.endsWith("s") && !NO_SINGULAR_SUFFIX.has(lower.slice(-2))) {
    return lower.slice(0, -1);
  }
  if (lower.length >= 6 && lower.endsWith("ing")) {
    const base = lower.slice(0, -3);
    return base.length >= 4 && /([bdglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (lower.length >= 5 && lower.endsWith("ed")) {
    const base = lower.slice(0, -2);
    return base.length >= 4 && /([bdglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  return lower;
}

const SYNONYM_MAP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const cluster of SYNONYM_CLUSTERS) {
    const expanded = new Set<string>();
    for (const word of cluster) {
      expanded.add(word);
      expanded.add(stemToken(word));
    }
    for (const form of expanded) {
      const existing = map.get(form) ?? new Set<string>();
      for (const peer of expanded) existing.add(peer);
      map.set(form, existing);
    }
  }
  return map;
})();

/** Split on camelCase, acronym boundaries, and non-alphanumeric separators. */
export function tokenizeSearchText(text: string): string[] {
  if (!text) return [];
  const splitCamel = text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2");
  return splitCamel
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Bounded Damerau-Levenshtein (optimal string alignment) distance. */
function damerauLevenshtein(a: string, b: string, maxDist: number): number {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
  if (a === b) return 0;

  let prev2: number[] = [];
  let prev1 = Array.from({ length: lenB + 1 }, (_, j) => j);

  for (let i = 1; i <= lenA; i += 1) {
    const curr = new Array<number>(lenB + 1);
    curr[0] = i;
    let rowMin = i;
    const chA = a[i - 1]!;
    for (let j = 1; j <= lenB; j += 1) {
      const chB = b[j - 1]!;
      const cost = chA === chB ? 0 : 1;
      let val = Math.min(curr[j - 1]! + 1, prev1[j]! + 1, prev1[j - 1]! + cost);
      if (i > 1 && j > 1 && chA === b[j - 2] && a[i - 2] === chB) {
        val = Math.min(val, prev2[j - 2]! + cost);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist && i >= lenB) {
      // Continue only if remaining diagonal could still stay under maxDist.
    }
    prev2 = prev1;
    prev1 = curr;
  }
  return prev1[lenB]!;
}

const WEIGHT_NAME = 6.0;
const WEIGHT_GROUP = 4.0;
const WEIGHT_PARAMS = 2.5;
const WEIGHT_DESCRIPTION = 1.5;

const TIER_EXACT = 1.0;
const TIER_STEM = 1.0;
const TIER_PREFIX = 0.8;
const TIER_SYNONYM = 0.55;
const TIER_SUBSTRING = 0.5;
const TIER_FUZZY = 0.45;

interface IndexedToken {
  raw: string;
  stem: string;
}

interface IndexedField {
  tokens: IndexedToken[];
  weight: number;
}

interface IndexedItem<T> {
  source: SearchableItem<T>;
  exactNames: Set<string>;
  fields: IndexedField[];
  allUniqueTokens: Set<string>;
  phraseText: string;
}

function toIndexedTokens(tokens: readonly string[]): IndexedToken[] {
  return tokens.map((raw) => ({ raw, stem: stemToken(raw) }));
}

function indexItem<T>(source: SearchableItem<T>): IndexedItem<T> {
  const nameTokens = tokenizeSearchText(
    [source.name, ...(source.aliases ?? [])].filter(Boolean).join(" "),
  );
  const groupTokens = tokenizeSearchText(source.group ?? "");
  const paramTokens = tokenizeSearchText((source.params ?? []).join(" "));
  const descTokens = tokenizeSearchText(
    [source.description ?? "", ...(source.paramDescriptions ?? [])].filter(Boolean).join(" "),
  );

  const fields: IndexedField[] = [
    { tokens: toIndexedTokens(nameTokens), weight: WEIGHT_NAME },
    { tokens: toIndexedTokens(groupTokens), weight: WEIGHT_GROUP },
    { tokens: toIndexedTokens(paramTokens), weight: WEIGHT_PARAMS },
    { tokens: toIndexedTokens(descTokens), weight: WEIGHT_DESCRIPTION },
  ];

  const allUniqueTokens = new Set<string>();
  for (const field of fields) {
    for (const tok of field.tokens) {
      allUniqueTokens.add(tok.raw);
      allUniqueTokens.add(tok.stem);
    }
  }

  const exactNames = new Set(
    [source.name, ...(source.aliases ?? [])].map((value) => value.toLowerCase()),
  );
  const phraseText = [...nameTokens, ...descTokens].join(" ");
  return { source, exactNames, fields, allUniqueTokens, phraseText };
}

function tokenMatchTier(
  qRaw: string,
  qStem: string,
  qSynonyms: ReadonlySet<string> | undefined,
  candidate: IndexedToken,
  allowFallback: boolean,
): number {
  if (candidate.raw === qRaw) return TIER_EXACT;
  if (
    candidate.stem === qStem ||
    ((qRaw.endsWith("ing") || qRaw.endsWith("ed")) && candidate.raw === `${qStem}e`)
  ) {
    return TIER_STEM;
  }
  if (qRaw.length >= 2 && candidate.raw.startsWith(qRaw)) return TIER_PREFIX;
  if (!allowFallback) return 0;
  if (qSynonyms && (qSynonyms.has(candidate.raw) || qSynonyms.has(candidate.stem))) {
    return TIER_SYNONYM;
  }
  if (qRaw.length >= 3 && candidate.raw.includes(qRaw)) return TIER_SUBSTRING;
  if (qRaw.length >= 4) {
    const maxDist = qRaw.length >= 7 ? 2 : 1;
    if (damerauLevenshtein(qRaw, candidate.raw, maxDist) <= maxDist) {
      return TIER_FUZZY;
    }
  }
  return 0;
}

function scoreItem<T>(
  indexed: IndexedItem<T>,
  trimmedQuery: string,
  queryTokens: readonly {
    raw: string;
    stem: string;
    synonyms?: ReadonlySet<string>;
    idf: number;
  }[],
  allowFallback: boolean,
): { matched: number; score: number; nameMatches: number } {
  if (indexed.exactNames.has(trimmedQuery)) {
    return {
      matched: queryTokens.length,
      score: Number.MAX_SAFE_INTEGER,
      nameMatches: queryTokens.length,
    };
  }

  let matched = 0;
  let score = 0;
  let nameMatches = 0;

  for (const qt of queryTokens) {
    let bestTokenScore = 0;
    let matchedName = false;
    for (const field of indexed.fields) {
      let bestTier = 0;
      for (const candidate of field.tokens) {
        const tier = tokenMatchTier(qt.raw, qt.stem, qt.synonyms, candidate, allowFallback);
        if (tier > bestTier) {
          bestTier = tier;
          if (bestTier === TIER_EXACT) break;
        }
      }
      if (bestTier > 0) {
        if (field.weight === WEIGHT_NAME) matchedName = true;
        const fieldScore = field.weight * bestTier * qt.idf;
        if (fieldScore > bestTokenScore) bestTokenScore = fieldScore;
      }
    }
    if (bestTokenScore > 0) {
      matched += 1;
      score += bestTokenScore;
      if (matchedName) nameMatches += 1;
    }
  }

  if (matched > 1 && queryTokens.length > 1) {
    for (let i = 0; i < queryTokens.length - 1; i += 1) {
      const pair = `${queryTokens[i]!.raw} ${queryTokens[i + 1]!.raw}`;
      if (indexed.phraseText.includes(pair)) score += 0.5;
    }
  }

  return { matched, score, nameMatches };
}

/**
 * Ranks items by exact name, multi-field weighted relevance, BM25-like IDF rarity, stemming,
 * curated synonyms, and fallback substring/typo tolerance.
 */
export function rankSearchItems<T>(
  items: readonly SearchableItem<T>[],
  rawQuery: string,
  options: SearchOptions = {},
): SearchRankResult<T> {
  const trimmedRaw = rawQuery.trim();
  const trimmed = trimmedRaw.toLowerCase();
  const rawTokens = tokenizeSearchText(trimmedRaw);
  const uniqueRawTokens = [...new Set(rawTokens)];
  if (!uniqueRawTokens.length) {
    return { hits: [], complete: false, queryTokens: [] };
  }

  const indexed = items.map(indexItem);
  const totalDocs = indexed.length;

  const queryTokens = uniqueRawTokens.map((raw) => {
    const stem = stemToken(raw);
    const synonyms = SYNONYM_MAP.get(raw) ?? SYNONYM_MAP.get(stem);
    let df = 0;
    for (const doc of indexed) {
      if (doc.allUniqueTokens.has(raw) || doc.allUniqueTokens.has(stem)) df += 1;
    }
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    return { raw, stem, synonyms, idf };
  });

  const evaluate = (allowFallback: boolean) =>
    indexed.map((entry) => ({
      entry,
      ...scoreItem(entry, trimmed, queryTokens, allowFallback),
    }));

  let scored = evaluate(false);
  const strictBestMatched = Math.max(0, ...scored.map((entry) => entry.matched));
  let bestMatched = strictBestMatched;

  // Activate synonyms, inside-word substring, and typo tolerance only when strict matching
  // cannot satisfy every query token.
  if (strictBestMatched < queryTokens.length) {
    scored = evaluate(true);
    bestMatched = Math.max(0, ...scored.map((entry) => entry.matched));
  }

  const tieBreak = options.tieBreak ?? ((a: string, b: string) => a.localeCompare(b));
  const candidates =
    bestMatched === queryTokens.length
      ? scored.filter((entry) => entry.matched === queryTokens.length)
      : scored.filter((entry) => entry.matched > 0);

  candidates.sort(
    (left, right) =>
      right.matched - left.matched ||
      right.score - left.score ||
      right.nameMatches - left.nameMatches ||
      tieBreak(left.entry.source.name, right.entry.source.name),
  );

  const limited = options.limit !== undefined ? candidates.slice(0, options.limit) : candidates;
  return {
    hits: limited.map((entry) => entry.entry.source.item),
    complete: strictBestMatched === queryTokens.length,
    queryTokens: uniqueRawTokens,
  };
}
