import { parseSkillMd } from "@rakazo/core";
import { stemToken } from "./tool-search.js";

export type SearchableSkillSource = "builtin" | "user" | "plugin" | "taught";

export interface SearchableSkill {
  id: string;
  name: string;
  description: string;
  source: SearchableSkillSource;
  readOnly: boolean;
  /** Full SKILL.md content (for AgentSkill) or formatted playbook text (for taught skill). */
  content: string;
  /** Optional relative paths of attached reference files (AgentSkill.files keys). */
  filePaths?: readonly string[];
  /** Optional extra metadata (e.g. taught skill goal/whenToUse). */
  whenToUse?: string;
}

export interface SkillSearchHit {
  skill: SearchableSkill;
  score: number;
  exactNameMatch: boolean;
  matchedTerms: number;
  matchedIn: readonly SkillMatchField[];
  matchedHeading?: string;
  snippet?: string;
}

export interface SkillSearchResult {
  hits: SkillSearchHit[];
  autoExpand?: SkillSearchHit;
  queryTokens: string[];
}

export interface SkillPromptHint {
  id: string;
  name: string;
  source: SearchableSkillSource;
  description: string;
  matchedHeading?: string;
  score: number;
}

export type SkillMatchField = "name" | "triggers" | "description" | "headings" | "files" | "body";

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_AUTO_EXPAND_CHARS = 24_000;
const AUTO_EXPAND_MIN_SCORE = 3.2;
const AUTO_EXPAND_LEAD_RATIO = 1.8;
const PROMPT_HINT_MIN_SCORE = 3.6;
const PROMPT_HINT_RELATIVE_FLOOR = 0.55;
const BM25_K1 = 1.2;

const FIELD_WEIGHTS: Record<SkillMatchField, { weight: number; b: number }> = {
  name: { weight: 6.0, b: 0.25 },
  triggers: { weight: 4.5, b: 0.3 },
  description: { weight: 3.0, b: 0.4 },
  headings: { weight: 2.5, b: 0.4 },
  files: { weight: 2.0, b: 0.3 },
  body: { weight: 1.0, b: 0.75 },
};

const TIER_EXACT = 1.0;
const TIER_STEM = 0.95;
const TIER_PREFIX = 0.8;
const TIER_SYNONYM = 0.55;
const TIER_FUZZY = 0.45;

const CONVERSATIONAL_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "about",
  "into",
  "from",
  "by",
  "as",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "they",
  "their",
  "can",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "do",
  "does",
  "did",
  "done",
  "please",
  "pls",
  "help",
  "want",
  "need",
  "just",
  "make",
  "get",
  "got",
  "have",
  "has",
  "had",
  "and",
  "or",
  "but",
  "not",
  "no",
  "yes",
  "if",
  "so",
  "then",
  "than",
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "which",
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank",
  "ok",
  "okay",
  "use",
  "using",
]);

const SKILL_SYNONYM_CLUSTERS: readonly (readonly string[])[] = [
  ["pr", "pull", "review", "diff", "interrogate", "audit", "critique", "inspect"],
  ["deploy", "ship", "release", "publish", "rollout", "restart", "prod", "production"],
  [
    "kanban",
    "board",
    "ticket",
    "tickets",
    "task",
    "tasks",
    "todo",
    "backlog",
    "blocker",
    "followup",
  ],
  ["history", "earlier", "previous", "past", "older", "before", "scrollback", "transcript"],
  [
    "routine",
    "routines",
    "schedule",
    "cron",
    "recurring",
    "periodic",
    "timer",
    "interval",
    "automate",
    "automation",
  ],
  [
    "computer",
    "desktop",
    "browser",
    "website",
    "webpage",
    "chrome",
    "click",
    "terminal",
    "shell",
    "command",
    "bash",
    "container",
    "docker",
    "screenshot",
  ],
  [
    "secret",
    "secrets",
    "credential",
    "credentials",
    "password",
    "login",
    "signin",
    "otp",
    "2fa",
    "token",
    "key",
    "vault",
  ],
  [
    "subagent",
    "subagents",
    "delegate",
    "delegation",
    "parallel",
    "background",
    "helper",
    "worker",
    "fanout",
  ],
  [
    "docs",
    "documentation",
    "guide",
    "manual",
    "rakazo",
    "selfhost",
    "hosting",
    "billing",
    "credits",
  ],
  ["memory", "notes", "recall", "remember", "shared"],
  ["email", "mail", "gmail", "inbox"],
  ["file", "doc", "document", "drive", "folder", "dir"],
  ["db", "database", "sql", "postgres", "prisma", "table", "record", "row"],
  ["bug", "issue", "error", "fix", "debug", "triage"],
  ["verify", "verification", "validate", "check"],
  ["create", "add", "new", "insert"],
  ["delete", "remove", "rm", "destroy", "drop"],
  ["update", "edit", "modify", "patch", "change"],
  ["search", "find", "query", "lookup", "filter"],
];

const SKILL_SYNONYM_MAP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const cluster of SKILL_SYNONYM_CLUSTERS) {
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

const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;
const HEADING_RE = /^#{1,4}\s+(.+)$/gm;

function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function appendCjkGrams(segment: string, out: string[]): void {
  const chars = [...segment];
  if (chars.length === 1) {
    out.push(chars[0]!);
    return;
  }
  for (let i = 0; i < chars.length - 1; i += 1) {
    out.push(`${chars[i]!}${chars[i + 1]!}`);
  }
}

/**
 * Tokenize prose, code identifiers (camelCase, snake_case, kebab-case), paths, and CJK runs.
 */
export function tokenizeSkillText(text: string): string[] {
  if (!text) return [];
  const splitCamel = text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2");
  const rawParts = splitCamel
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const tokens: string[] = [];
  for (const part of rawParts) {
    CJK_RUN_RE.lastIndex = 0;
    if (!CJK_RUN_RE.test(part)) {
      tokens.push(part);
      continue;
    }
    let lastIndex = 0;
    CJK_RUN_RE.lastIndex = 0;
    for (const match of part.matchAll(CJK_RUN_RE)) {
      const idx = match.index ?? 0;
      if (idx > lastIndex) {
        tokens.push(part.slice(lastIndex, idx));
      }
      appendCjkGrams(match[0], tokens);
      lastIndex = idx + match[0].length;
    }
    if (lastIndex < part.length) {
      tokens.push(part.slice(lastIndex));
    }
  }
  return tokens;
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
    const chA = a[i - 1]!;
    for (let j = 1; j <= lenB; j += 1) {
      const chB = b[j - 1]!;
      const cost = chA === chB ? 0 : 1;
      let val = Math.min(curr[j - 1]! + 1, prev1[j]! + 1, prev1[j - 1]! + cost);
      if (i > 1 && j > 1 && chA === b[j - 2] && a[i - 2] === chB) {
        val = Math.min(val, prev2[j - 2]! + cost);
      }
      curr[j] = val;
    }
    prev2 = prev1;
    prev1 = curr;
  }
  return prev1[lenB]!;
}

interface IndexedToken {
  raw: string;
  stem: string;
}

function toIndexedTokens(tokens: readonly string[]): IndexedToken[] {
  return tokens.map((raw) => ({ raw, stem: stemToken(raw) }));
}

function stringListFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
    );
  }
  return [];
}

function extractSkillSections(skill: SearchableSkill): {
  aliases: string[];
  triggerPhrases: string[];
  headings: string[];
  headingSections: string[];
  cleanBody: string;
  bodyLines: string[];
} {
  const parsed = parseSkillMd(skill.content);
  const frontmatter = "error" in parsed ? {} : parsed.frontmatter;
  const rawBody = "error" in parsed ? skill.content : parsed.body;

  const aliases = stringListFromUnknown(frontmatter.aliases);
  const triggerPhrases = [
    ...stringListFromUnknown(frontmatter.tags),
    ...stringListFromUnknown(frontmatter.triggers),
    ...stringListFromUnknown(frontmatter.keywords),
    ...stringListFromUnknown(frontmatter.whenToUse),
    ...stringListFromUnknown(frontmatter["when-to-use"]),
    ...stringListFromUnknown(frontmatter.category),
    ...(skill.whenToUse?.trim() ? [skill.whenToUse.trim()] : []),
  ];

  // Strip raw URLs and markdown fence markers so noisy URL hashes don't distort body length/IDF.
  const cleanBody = rawBody.replace(/```[^\n]*\n?/g, "\n").replace(/https?:\/\/\S+/gi, " ");
  const rawLines = cleanBody.split(/\r?\n/);

  const headings: string[] = [];
  const headingSections: string[] = [];
  let currentSectionLines: string[] = [];
  for (const rawLine of rawLines) {
    HEADING_RE.lastIndex = 0;
    const match = HEADING_RE.exec(rawLine.trim());
    if (match?.[1]) {
      if (headings.length > 0) {
        headingSections.push(currentSectionLines.join(" "));
      }
      headings.push(match[1].trim());
      currentSectionLines = [];
      continue;
    }
    if (headings.length > 0 && rawLine.trim()) {
      currentSectionLines.push(rawLine.trim());
    }
  }
  if (headings.length > 0) {
    headingSections.push(currentSectionLines.join(" "));
  }

  const bodyLines = rawLines.map((line) => line.trim()).filter(Boolean);

  return { aliases, triggerPhrases, headings, headingSections, cleanBody, bodyLines };
}

interface IndexedSkill {
  skill: SearchableSkill;
  normalizedNames: Set<string>;
  normalizedTriggers: Set<string>;
  headings: string[];
  headingTokens: IndexedToken[][];
  headingSectionTokens: IndexedToken[][];
  bodyLines: string[];
  fields: Record<SkillMatchField, IndexedToken[]>;
  allTokens: Set<string>;
  highSignalPhrase: string;
  bodyPhrase: string;
}

function indexSkill(skill: SearchableSkill): IndexedSkill {
  const { aliases, triggerPhrases, headings, headingSections, cleanBody, bodyLines } =
    extractSkillSections(skill);
  const nameRawTokens = tokenizeSkillText([skill.name, ...aliases].join(" "));
  const triggerRawTokens = tokenizeSkillText(triggerPhrases.join(" "));
  const descRawTokens = tokenizeSkillText(skill.description);
  const headingLinesTokens = headings.map((heading) => tokenizeSkillText(heading));
  const headingSectionRawTokens = headingSections.map((section) => tokenizeSkillText(section));
  const headingRawTokens = headingLinesTokens.flat();
  const fileRawTokens = tokenizeSkillText((skill.filePaths ?? []).join(" "));
  const bodyRawTokens = tokenizeSkillText(cleanBody);

  const fields: Record<SkillMatchField, IndexedToken[]> = {
    name: toIndexedTokens(nameRawTokens),
    triggers: toIndexedTokens(triggerRawTokens),
    description: toIndexedTokens(descRawTokens),
    headings: toIndexedTokens(headingRawTokens),
    files: toIndexedTokens(fileRawTokens),
    body: toIndexedTokens(bodyRawTokens),
  };

  const allTokens = new Set<string>();
  for (const tokens of Object.values(fields)) {
    for (const token of tokens) {
      allTokens.add(token.raw);
      allTokens.add(token.stem);
    }
  }

  const normalizedNames = new Set([skill.name, ...aliases].map(normalizePhrase).filter(Boolean));
  const normalizedTriggers = new Set(triggerPhrases.map(normalizePhrase).filter(Boolean));

  return {
    skill,
    normalizedNames,
    normalizedTriggers,
    headings,
    headingTokens: headingLinesTokens.map(toIndexedTokens),
    headingSectionTokens: headingSectionRawTokens.map(toIndexedTokens),
    bodyLines,
    fields,
    allTokens,
    highSignalPhrase: [
      ...nameRawTokens,
      ...triggerRawTokens,
      ...descRawTokens,
      ...headingRawTokens,
    ].join(" "),
    bodyPhrase: bodyRawTokens.join(" "),
  };
}

interface QueryToken {
  raw: string;
  stem: string;
  synonyms?: ReadonlySet<string>;
  idf: number;
}

function normalizeQueryPhrases(rawQuery: string): string {
  return rawQuery
    .replace(/\bpull\s+requests?\b/gi, "pr")
    .replace(/\bfollow[\s-]+ups?\b/gi, "followup")
    .replace(/\bto[\s-]+dos?\b/gi, "todo")
    .replace(/\bself[\s-]+host(?:ing|ed)?\b/gi, "selfhost");
}

function buildQueryTokens(
  rawQuery: string,
  indexedCorpus: readonly IndexedSkill[],
  dropStopwords: boolean,
): { tokens: QueryToken[]; rawTokens: string[]; normalizedQuery: string } {
  const canonicalQuery = normalizeQueryPhrases(rawQuery);
  const normalizedQuery = normalizePhrase(canonicalQuery);
  const allRaw = tokenizeSkillText(canonicalQuery);
  const nonStop = dropStopwords
    ? allRaw.filter((token) => !CONVERSATIONAL_STOPWORDS.has(token))
    : allRaw;
  const chosen = nonStop.length > 0 ? nonStop : allRaw;
  const uniqueRaw = [...new Set(chosen)];
  const totalDocs = indexedCorpus.length;

  const tokens = uniqueRaw.map((raw) => {
    const stem = stemToken(raw);
    const synonyms = SKILL_SYNONYM_MAP.get(raw) ?? SKILL_SYNONYM_MAP.get(stem);
    let df = 0;
    for (const doc of indexedCorpus) {
      if (doc.allTokens.has(raw) || doc.allTokens.has(stem)) df += 1;
    }
    const rawIdf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const idf = Math.max(0.75, rawIdf);
    return { raw, stem, synonyms, idf };
  });

  return { tokens, rawTokens: uniqueRaw, normalizedQuery };
}

function tokenMatchTier(q: QueryToken, candidate: IndexedToken, allowFallback: boolean): number {
  if (candidate.raw === q.raw) return TIER_EXACT;
  if (
    candidate.stem === q.stem ||
    ((q.raw.endsWith("ing") || q.raw.endsWith("ed")) && candidate.raw === `${q.stem}e`)
  ) {
    return TIER_STEM;
  }
  if (q.raw.length >= 3 && candidate.raw.startsWith(q.raw)) return TIER_PREFIX;
  if (!allowFallback) return 0;
  if (q.synonyms && (q.synonyms.has(candidate.raw) || q.synonyms.has(candidate.stem))) {
    return TIER_SYNONYM;
  }
  if (q.raw.length >= 4) {
    const maxDist = q.raw.length >= 7 ? 2 : 1;
    if (damerauLevenshtein(q.raw, candidate.raw, maxDist) <= maxDist) {
      return TIER_FUZZY;
    }
  }
  return 0;
}

function fieldTermFrequency(
  q: QueryToken,
  fieldTokens: readonly IndexedToken[],
  allowFallback: boolean,
): number {
  let tf = 0;
  for (const token of fieldTokens) {
    const tier = tokenMatchTier(q, token, allowFallback);
    if (tier > 0) tf += tier;
  }
  return tf;
}

function computeAvgFieldLengths(corpus: readonly IndexedSkill[]): Record<SkillMatchField, number> {
  const sums: Record<SkillMatchField, number> = {
    name: 0,
    triggers: 0,
    description: 0,
    headings: 0,
    files: 0,
    body: 0,
  };
  for (const doc of corpus) {
    for (const field of Object.keys(sums) as SkillMatchField[]) {
      sums[field] += doc.fields[field].length;
    }
  }
  const divisor = Math.max(1, corpus.length);
  return {
    name: Math.max(1, sums.name / divisor),
    triggers: Math.max(1, sums.triggers / divisor),
    description: Math.max(1, sums.description / divisor),
    headings: Math.max(1, sums.headings / divisor),
    files: Math.max(1, sums.files / divisor),
    body: Math.max(1, sums.body / divisor),
  };
}

function containsWholePhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  return ` ${haystack} `.includes(` ${needle} `);
}

function bestMatchedHeading(
  doc: IndexedSkill,
  queryTokens: readonly QueryToken[],
): string | undefined {
  let bestHeading: string | undefined;
  let bestScore = 0;
  for (let index = 0; index < doc.headings.length; index += 1) {
    const hTokens = doc.headingTokens[index] ?? [];
    const sTokens = doc.headingSectionTokens[index] ?? [];
    let hits = 0;
    let score = 0;
    for (const q of queryTokens) {
      let bestHeadingTier = 0;
      for (const token of hTokens) {
        const tier = tokenMatchTier(q, token, true);
        if (tier > bestHeadingTier) bestHeadingTier = tier;
      }
      let bestSectionTier = 0;
      for (const token of sTokens) {
        const tier = tokenMatchTier(q, token, true);
        if (tier > bestSectionTier) bestSectionTier = tier;
      }
      if (bestHeadingTier > 0 || bestSectionTier > 0) hits += 1;
      score += bestHeadingTier * 1.5 * q.idf + bestSectionTier * 1.2 * q.idf;
    }
    if (hits > 0 && score > bestScore) {
      bestScore = score;
      bestHeading = doc.headings[index];
    }
  }
  return bestHeading;
}

function bestBodySnippet(
  doc: IndexedSkill,
  queryTokens: readonly QueryToken[],
  allowFallback: boolean,
): string | undefined {
  let bestLine: string | undefined;
  let bestScore = 0;
  for (const line of doc.bodyLines) {
    if (line.startsWith("---")) continue;
    const lineTokens = toIndexedTokens(tokenizeSkillText(line));
    let score = 0;
    for (const q of queryTokens) {
      let bestTier = 0;
      for (const token of lineTokens) {
        const tier = tokenMatchTier(q, token, allowFallback);
        if (tier > bestTier) bestTier = tier;
      }
      score += bestTier * q.idf;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }
  if (!bestLine) return undefined;
  const collapsed = bestLine
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= 160) return collapsed;
  return `${collapsed.slice(0, 159).trimEnd()}…`;
}

function scoreSkill(
  doc: IndexedSkill,
  normalizedQuery: string,
  queryTokens: readonly QueryToken[],
  avgdl: Record<SkillMatchField, number>,
  allowFallback: boolean,
): {
  score: number;
  exactNameMatch: boolean;
  exactTriggerPhrase: boolean;
  matchedTerms: number;
  nonBodyMatchedTerms: number;
  matchedIn: SkillMatchField[];
  matchedHeading?: string;
  snippet?: string;
} {
  const exactNameMatch = doc.normalizedNames.has(normalizedQuery);
  const nameInQuery = [...doc.normalizedNames].some(
    (name) => name.length >= 4 && containsWholePhrase(normalizedQuery, name),
  );
  const exactTriggerPhrase = [...doc.normalizedTriggers].some(
    (trigger) => trigger.length >= 3 && containsWholePhrase(normalizedQuery, trigger),
  );

  let rawScore = 0;
  let matchedTerms = 0;
  let nonBodyMatchedTerms = 0;
  const matchedFields = new Set<SkillMatchField>();

  for (const q of queryTokens) {
    let pseudoTf = 0;
    let matchedNonBody = false;
    let matchedAny = false;
    for (const field of Object.keys(FIELD_WEIGHTS) as SkillMatchField[]) {
      const tokens = doc.fields[field];
      if (tokens.length === 0) continue;
      const tf = fieldTermFrequency(q, tokens, allowFallback);
      if (tf <= 0) continue;
      matchedAny = true;
      matchedFields.add(field);
      if (field !== "body") matchedNonBody = true;
      const { weight, b } = FIELD_WEIGHTS[field];
      const norm = 1 - b + b * (tokens.length / avgdl[field]);
      pseudoTf += (weight * tf) / Math.max(0.25, norm);
    }
    if (matchedAny) {
      matchedTerms += 1;
      if (matchedNonBody) nonBodyMatchedTerms += 1;
      rawScore += q.idf * (((BM25_K1 + 1) * pseudoTf) / (BM25_K1 + pseudoTf));
    }
  }

  // Phrase / proximity boost for consecutive query terms.
  if (matchedTerms > 1 && queryTokens.length > 1) {
    for (let i = 0; i < queryTokens.length - 1; i += 1) {
      const pair = `${queryTokens[i]!.raw} ${queryTokens[i + 1]!.raw}`;
      if (doc.highSignalPhrase.includes(pair)) rawScore += 1.2;
      else if (doc.bodyPhrase.includes(pair)) rawScore += 0.5;
    }
  }

  const coverage = queryTokens.length > 0 ? 0.55 + 0.45 * (matchedTerms / queryTokens.length) : 0;
  let score = rawScore * coverage;

  if (exactNameMatch) score += 20;
  else if (nameInQuery) score += 8;
  if (exactTriggerPhrase) score += 6;

  const orderedFields = (
    ["name", "triggers", "description", "headings", "files", "body"] as const
  ).filter((field) => matchedFields.has(field));
  const matchedHeading =
    doc.headings.length > 0 && score > 0 ? bestMatchedHeading(doc, queryTokens) : undefined;
  const snippet = score > 0 ? bestBodySnippet(doc, queryTokens, allowFallback) : undefined;

  return {
    score,
    exactNameMatch: exactNameMatch || nameInQuery,
    exactTriggerPhrase,
    matchedTerms,
    nonBodyMatchedTerms,
    matchedIn: orderedFields,
    matchedHeading,
    snippet,
  };
}

function evaluateCorpus(skills: readonly SearchableSkill[], query: string, dropStopwords: boolean) {
  const indexed = skills.map(indexSkill);
  const avgdl = computeAvgFieldLengths(indexed);
  const {
    tokens: queryTokens,
    rawTokens,
    normalizedQuery,
  } = buildQueryTokens(query, indexed, dropStopwords);
  if (queryTokens.length === 0) {
    return { indexed, queryTokens, rawTokens, scored: [] };
  }

  let scored = indexed.map((doc) => ({
    doc,
    ...scoreSkill(doc, normalizedQuery, queryTokens, avgdl, false),
  }));
  const bestStrictMatches = Math.max(0, ...scored.map((entry) => entry.matchedTerms));
  if (bestStrictMatches < queryTokens.length) {
    scored = indexed.map((doc) => ({
      doc,
      ...scoreSkill(doc, normalizedQuery, queryTokens, avgdl, true),
    }));
  }

  scored.sort(
    (left, right) =>
      Number(right.exactNameMatch) - Number(left.exactNameMatch) ||
      right.matchedTerms - left.matchedTerms ||
      right.score - left.score ||
      left.doc.skill.name.localeCompare(right.doc.skill.name),
  );

  return { indexed, queryTokens, rawTokens, scored };
}

/**
 * Search Agent Skills and Taught Skills for `skill_mode({ query })`.
 * Recall-oriented: returns ranked hits with matched headings/snippets and auto-expands
 * the top hit when it is an exact name match or clearly leads the runner-up.
 */
export function searchSkills(
  skills: readonly SearchableSkill[],
  query: string,
  options: { limit?: number; source?: SearchableSkillSource } = {},
): SkillSearchResult {
  const scoped = options.source
    ? skills.filter((skill) => skill.source === options.source)
    : skills;
  const limit = Math.max(1, Math.min(20, options.limit ?? DEFAULT_SEARCH_LIMIT));
  if (!query.trim() || scoped.length === 0) {
    return { hits: [], queryTokens: [] };
  }

  const { rawTokens, scored } = evaluateCorpus(scoped, query, true);
  const hits: SkillSearchHit[] = scored
    .filter((entry) => entry.score > 0 && entry.matchedTerms > 0)
    .slice(0, limit)
    .map((entry) => ({
      skill: entry.doc.skill,
      score: Number(entry.score.toFixed(3)),
      exactNameMatch: entry.exactNameMatch,
      matchedTerms: entry.matchedTerms,
      matchedIn: entry.matchedIn,
      ...(entry.matchedHeading ? { matchedHeading: entry.matchedHeading } : {}),
      ...(entry.snippet ? { snippet: entry.snippet } : {}),
    }));

  const top = hits[0];
  const second = hits[1];
  const canAutoExpand =
    top !== undefined &&
    top.skill.content.length <= MAX_AUTO_EXPAND_CHARS &&
    (top.exactNameMatch ||
      (top.score >= AUTO_EXPAND_MIN_SCORE &&
        (second === undefined || top.score >= second.score * AUTO_EXPAND_LEAD_RATIO)));

  return {
    hits,
    ...(canAutoExpand ? { autoExpand: top } : {}),
    queryTokens: rawTokens,
  };
}

/**
 * Precision-oriented pre-turn matcher for injecting `<relevant_skills>` hints from a raw
 * user prompt without polluting casual chat or triggering on single weak body mentions.
 */
export function matchRelevantSkillsForPrompt(
  prompt: string,
  skills: readonly SearchableSkill[],
  options: { maxHints?: number; excludeNames?: readonly string[] } = {},
): SkillPromptHint[] {
  if (!prompt.trim() || skills.length === 0) return [];
  const excluded = new Set(
    (options.excludeNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const eligible =
    excluded.size > 0
      ? skills.filter((skill) => !excluded.has(skill.name.trim().toLowerCase()))
      : skills;
  if (eligible.length === 0) return [];

  const maxHints = Math.max(1, Math.min(5, options.maxHints ?? 3));
  const { rawTokens, scored } = evaluateCorpus(eligible, prompt, true);
  const informativeCount = rawTokens.filter((token) => !CONVERSATIONAL_STOPWORDS.has(token)).length;

  const qualified = scored.filter((entry) => {
    if (entry.matchedTerms === 0) return false;
    // Short/casual prompts ("hi", "thanks", "help") only match if an exact skill/trigger name appears.
    if (informativeCount < 2 && !entry.exactNameMatch && !entry.exactTriggerPhrase) {
      return false;
    }
    // Single-term body-only coincidences are too noisy for pre-turn prompt hints.
    if (
      !entry.exactNameMatch &&
      !entry.exactTriggerPhrase &&
      entry.matchedTerms < 2 &&
      entry.nonBodyMatchedTerms === 0
    ) {
      return false;
    }
    if (
      !entry.exactNameMatch &&
      !entry.exactTriggerPhrase &&
      entry.nonBodyMatchedTerms === 0 &&
      entry.score < PROMPT_HINT_MIN_SCORE * 1.35
    ) {
      return false;
    }
    return entry.score >= PROMPT_HINT_MIN_SCORE;
  });

  const top = qualified[0];
  if (!top) return [];

  return qualified
    .filter(
      (entry, index) =>
        index === 0 ||
        entry.exactNameMatch ||
        entry.score >= top.score * PROMPT_HINT_RELATIVE_FLOOR,
    )
    .slice(0, maxHints)
    .map((entry) => ({
      id: entry.doc.skill.id,
      name: entry.doc.skill.name,
      source: entry.doc.skill.source,
      description: entry.doc.skill.description,
      ...(entry.matchedHeading ? { matchedHeading: entry.matchedHeading } : {}),
      score: Number(entry.score.toFixed(3)),
    }));
}
