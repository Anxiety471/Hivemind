import type { MessageBlock } from "@rakazo/contracts";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type ChatRepository = {
  /** Repository home or any PR/MR/issue/commit URL of it, over https. */
  url: string;
  aliases?: readonly string[];
  isDefault?: boolean;
};

export type ChatTicketReference = {
  ref: string;
  repository?: string | null;
  pullRequests?: readonly { url: string }[];
};

export type ChatJobReference = {
  repo?: string;
  prUrl?: string;
  url?: string;
  commit?: string;
};

export type ChatReferenceContext = {
  /** Board ticket prefix (e.g. "TASK"). Omit when board is unavailable/disabled. */
  ticketPrefix?: string;
  repositories?: readonly ChatRepository[];
  tickets?: readonly ChatTicketReference[];
  jobs?: readonly ChatJobReference[];
};

/** A reference found in a text: its source range and what it links to. */
export type ChatReference =
  | { start: number; end: number; kind: "ticket"; ticketRef: string }
  | { start: number; end: number; kind: "link"; href: string };

export type ChatReferenceSpan = { start: number; end: number; code?: string };

/** Markdown source split into the prose and inline-code spans that may hold references. */
export type ChatReferenceDocument = {
  text: string;
  /** Sorted, non-overlapping. Spans with `code` are inline code; others are prose. */
  spans: readonly ChatReferenceSpan[];
  /** Fenced code blocks: their lines never name a repository. */
  fences: readonly { start: number; end: number }[];
};

export const TICKET_URL_PREFIX = "rakazo-ticket:";

const TICKET_REF_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}-[1-9][0-9]{0,8}$/;

/** The ticket ref of a `rakazo-ticket:<REF>` link, if this href is one. */
export function markdownTicketRef(href: string | undefined): string | undefined {
  if (!href?.startsWith(TICKET_URL_PREFIX)) return undefined;
  const ref = href.slice(TICKET_URL_PREFIX.length);
  return TICKET_REF_PATTERN.test(ref) ? ref : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function httpsUrl(value: string | null | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

const REPOSITORY_PATH_SUFFIX =
  /\/(?:-\/)?(?:pull|pulls|merge_requests|pull-requests|issues|commit|commits)(?:\/.*)?$/;

const REPOSITORY_PAGE_SEGMENTS = new Set([
  "-",
  "actions",
  "blob",
  "branches",
  "commits",
  "compare",
  "jobs",
  "pipelines",
  "releases",
  "runs",
  "src",
  "tags",
  "tree",
  "wiki",
]);

/** `https://<host>/<owner>/<repo>` for a repository home or a PR/MR/issue/commit URL of one. */
export function deriveRepositoryBaseUrl(url: string | undefined | null): string | null {
  const parsed = httpsUrl(url);
  if (!parsed) return null;
  let path = parsed.pathname.replace(/\/+$/, "");
  const suffix = REPOSITORY_PATH_SUFFIX.exec(path);
  if (suffix) path = path.slice(0, suffix.index);
  let segments = path
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  // A page inside a repository (its files, runs, releases) ends the repository path.
  const page = segments.findIndex(
    (segment, index) => index >= 2 && REPOSITORY_PAGE_SEGMENTS.has(segment),
  );
  if (page !== -1) segments = segments.slice(0, page);
  if (segments.length < 2 || segments.length > 8) return null;
  return `${parsed.origin}/${segments.join("/")}`;
}

/** A commit URL of a repository; `dash` is the `/-/commit/<sha>` form some hosts use. */
export function repositoryCommitUrl(
  repoUrl: string,
  sha: string,
  style: "standard" | "dash" = "standard",
): string {
  return `${repoUrl}/${style === "dash" ? "-/" : ""}commit/${sha}`;
}

/** A pull/merge request URL of a repository; `segment` is `pull` unless the host names it otherwise. */
export function repositoryPullRequestUrl(
  repoUrl: string,
  number: number,
  segment = "pull",
): string {
  return `${repoUrl}/${segment}/${number}`;
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value) && /[0-9]/.test(value) && /[a-f]/i.test(value);
}

const PULL_REQUEST_PATH =
  /\/((?:-\/)?(?:pull|pulls|merge_requests|pull-requests))\/([1-9][0-9]*)(?:\/.*)?$/;

function pullRequestLocation(url: string | undefined | null) {
  const parsed = httpsUrl(url);
  const base = deriveRepositoryBaseUrl(url);
  const match = parsed && base ? PULL_REQUEST_PATH.exec(parsed.pathname) : null;
  return match && base ? { base, segment: match[1]!, number: Number(match[2]) } : undefined;
}

type Repo = {
  url: string;
  /** Lowercase `owner/repo` (or a longer subgroup path). */
  path: string;
  name: string;
  pullSegment: string;
  dash: boolean;
  isDefault: boolean;
};

type PullRequestCandidate = { number: number; url: string; repo: Repo };

type Catalog = {
  repos: Map<string, Repo>;
  /** Unambiguous lowercase alias (path, name or explicit) to its repository. */
  aliases: Map<string, Repo>;
  nameMatcher?: RegExp;
  ticketMatcher?: RegExp;
  defaultRepo?: Repo;
  ticketRepos: Map<string, Repo[]>;
  ticketPullRequests: Map<string, PullRequestCandidate[]>;
  jobPullRequests: PullRequestCandidate[];
  jobs: { job: ChatJobReference; repo: Repo | undefined }[];
};

function buildCatalog(context: ChatReferenceContext): Catalog {
  const repos = new Map<string, Repo>();
  const repoFor = (url: string | null | undefined): Repo | undefined => {
    const base = deriveRepositoryBaseUrl(url);
    if (!base || !url) return undefined;
    const key = base.toLowerCase();
    let repo = repos.get(key);
    if (!repo) {
      const path = new URL(base).pathname.slice(1);
      repo = {
        url: base,
        path: path.toLowerCase(),
        name: (path.split("/").at(-1) ?? "").toLowerCase(),
        pullSegment: "pull",
        dash: false,
        isDefault: false,
      };
      repos.set(key, repo);
    }
    if (url.includes("/-/")) repo.dash = true;
    return repo;
  };
  const pullRequestCandidate = (url: string): PullRequestCandidate | undefined => {
    const location = pullRequestLocation(url);
    const repo = repoFor(url);
    if (!location || !repo) return undefined;
    repo.pullSegment = location.segment;
    return { number: location.number, url, repo };
  };

  const explicitAliases: [string, Repo][] = [];
  const declared: Repo[] = [];
  let flagged: Repo | undefined;
  for (const repository of context.repositories ?? []) {
    const repo = repoFor(repository.url);
    if (!repo) continue;
    declared.push(repo);
    if (repository.isDefault && !flagged) flagged = repo;
    for (const alias of repository.aliases ?? []) explicitAliases.push([alias, repo]);
  }
  const distinctDeclared = new Set(declared);
  const defaultRepo =
    flagged ?? (distinctDeclared.size === 1 ? [...distinctDeclared][0] : undefined);

  const ticketRepos = new Map<string, Repo[]>();
  const ticketPullRequests = new Map<string, PullRequestCandidate[]>();
  for (const ticket of context.tickets ?? []) {
    const ref = ticket.ref.toUpperCase();
    const repo = repoFor(ticket.repository);
    if (repo) ticketRepos.set(ref, [...(ticketRepos.get(ref) ?? []), repo]);
    const candidates = ticketPullRequests.get(ref) ?? [];
    for (const pullRequest of ticket.pullRequests ?? []) {
      const candidate = pullRequestCandidate(pullRequest.url);
      if (candidate) candidates.push(candidate);
    }
    ticketPullRequests.set(ref, candidates);
  }

  const jobPullRequests: PullRequestCandidate[] = [];
  for (const job of context.jobs ?? []) {
    const candidate = job.prUrl ? pullRequestCandidate(job.prUrl) : undefined;
    if (candidate) jobPullRequests.push(candidate);
    repoFor(job.prUrl);
    repoFor(job.url);
  }

  const owners = new Map<string, Set<Repo>>();
  const addAlias = (alias: string, repo: Repo) => {
    const key = alias.trim().toLowerCase();
    if (!key) return;
    owners.set(key, (owners.get(key) ?? new Set<Repo>()).add(repo));
  };
  for (const repo of repos.values()) {
    addAlias(repo.path, repo);
    addAlias(repo.name, repo);
  }
  for (const [alias, repo] of explicitAliases) addAlias(alias, repo);
  const aliases = new Map<string, Repo>();
  for (const [key, set] of owners) {
    const [only] = set;
    if (set.size === 1 && only) aliases.set(key, only);
  }

  const jobs = (context.jobs ?? []).map((job) => {
    const base = deriveRepositoryBaseUrl(job.prUrl) ?? deriveRepositoryBaseUrl(job.url);
    if (base) return { job, repo: repos.get(base.toLowerCase()) };
    const key = job.repo?.trim().toLowerCase() ?? "";
    return { job, repo: key.includes("/") ? aliases.get(key) : undefined };
  });

  const names = [...aliases.keys()]
    .filter((key) => !key.includes("/"))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const prefix = context.ticketPrefix?.trim();

  return {
    repos,
    aliases,
    nameMatcher: names.length
      ? new RegExp(
          `(?<![\\p{L}\\p{N}_./@-])(${names.join("|")})(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_])`,
          "giu",
        )
      : undefined,
    ticketMatcher: prefix
      ? new RegExp(`(?<![/-])\\b(${escapeRegExp(prefix)}-([1-9][0-9]*))\\b`, "gi")
      : undefined,
    defaultRepo,
    ticketRepos,
    ticketPullRequests,
    jobPullRequests,
    jobs,
  };
}

/** A repository named on a line: its range, and whether it sits in parentheses. */
type Mention = { start: number; end: number; repo: Repo; parenthesized: boolean };

const URL_MENTION = /https:\/\/[^\s<>()[\]`"']+/gi;
const PATH_MENTION = /(?<![A-Za-z0-9_./@-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![A-Za-z0-9_/-])/g;

function lineMentions(line: string, lineStart: number, catalog: Catalog): Mention[] {
  const found: { start: number; end: number; repo: Repo }[] = [];
  const note = (match: RegExpExecArray | RegExpMatchArray, repo: Repo | undefined) => {
    if (!repo) return;
    const start = lineStart + (match.index ?? 0);
    found.push({ start, end: start + match[0].length, repo });
  };
  for (const match of line.matchAll(URL_MENTION)) {
    const base = deriveRepositoryBaseUrl(match[0])?.toLowerCase() ?? "";
    note(match, catalog.repos.get(base));
  }
  for (const match of line.matchAll(PATH_MENTION)) {
    note(match, catalog.aliases.get(match[0].toLowerCase()));
  }
  if (catalog.nameMatcher) {
    for (const match of line.matchAll(catalog.nameMatcher)) {
      note(match, catalog.aliases.get(match[0].toLowerCase()));
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const mentions: Mention[] = [];
  let lastEnd = -1;
  for (const mention of found) {
    if (mention.start < lastEnd) continue;
    lastEnd = mention.end;
    const before = line.slice(0, mention.start - lineStart);
    const depth = [...before].reduce(
      (sum, char) => sum + (char === "(" ? 1 : char === ")" ? -1 : 0),
      0,
    );
    mentions.push({ ...mention, parenthesized: depth > 0 });
  }
  return mentions;
}

type Line = { start: number; end: number; mentions: Mention[]; active: Repo | undefined };

/** Lines of one document with the repository each one inherits from the lines above. */
function scanLines(document: ChatReferenceDocument, catalog: Catalog, state: { active?: Repo }) {
  const lines: Line[] = [];
  let offset = 0;
  for (const text of document.text.split("\n")) {
    const start = offset;
    const end = start + text.length;
    offset = end + 1;
    const fenced = document.fences.some((fence) => start < fence.end && end > fence.start);
    const mentions = fenced ? [] : lineMentions(text, start, catalog);
    lines.push({ start, end, mentions, active: state.active });
    const subject = mentions.find((mention) => !mention.parenthesized);
    if (subject) state.active = subject.repo;
  }
  return lines;
}

function lineAt(lines: readonly Line[], position: number): Line {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lines[middle]!.start <= position) low = middle;
    else high = middle - 1;
  }
  return lines[low]!;
}

/** The mention nearest the reference on its line, whatever clause it sits in. */
function nearestMention(mentions: readonly Mention[], start: number, end: number) {
  let best: Mention | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const mention of mentions) {
    const distance =
      mention.end <= start ? start - mention.end : mention.start >= end ? mention.start - end : 0;
    if (distance < bestDistance) {
      best = mention;
      bestDistance = distance;
    }
  }
  return best;
}

function spanContains(spans: readonly ChatReferenceSpan[], start: number, end: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.start <= start) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const span = spans[found];
  return span !== undefined && span.code === undefined && end <= span.end;
}

type Item =
  | { kind: "ticket"; start: number; end: number; ref: string }
  | { kind: "pr"; start: number; end: number; number: number; repo?: Repo }
  | { kind: "sha"; start: number; end: number; sha: string; repo?: Repo };

const EXPLICIT_PR =
  /(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,6})\b(?![0-9a-fA-F])/g;
const EXPLICIT_SHA =
  /(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-fA-F]{7,40})\b/g;
const PR_NUMBER = /(?<![A-Za-z0-9_/#])((?:PR\s+)?#([1-9][0-9]{0,6}))\b(?![0-9a-fA-F])/gi;
const BARE_SHA = /(?<![A-Za-z0-9_/-])[0-9a-fA-F]{7,40}(?![A-Za-z0-9_/-])/g;
const MAX_TICKET_NUMBER = 999_999_999;

/**
 * Every reference in a document, in position order, with no two overlapping. Explicit
 * `owner/repo#n` and `owner/repo@sha` win over bare numbers and SHAs, and tickets win over both.
 */
function collectItems(document: ChatReferenceDocument, catalog: Catalog): Item[] {
  const { text, spans } = document;
  const accepted: Item[] = [];
  const candidates: { priority: number; item: Item }[] = [];
  const add = (priority: number, item: Item) => candidates.push({ priority, item });

  for (const span of spans) {
    if (span.code !== undefined && isCommitSha(span.code)) {
      accepted.push({ kind: "sha", start: span.start, end: span.end, sha: span.code });
    }
  }
  const prose = (match: RegExpMatchArray | RegExpExecArray) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return spanContains(spans, start, end) ? { start, end } : undefined;
  };

  for (const match of text.matchAll(EXPLICIT_PR)) {
    const range = prose(match);
    const repo = catalog.aliases.get(match[1]!.toLowerCase());
    if (range && repo) add(0, { kind: "pr", ...range, number: Number(match[2]), repo });
  }
  for (const match of text.matchAll(EXPLICIT_SHA)) {
    const range = prose(match);
    const repo = catalog.aliases.get(match[1]!.toLowerCase());
    if (range && repo && isCommitSha(match[2]!))
      add(0, { kind: "sha", ...range, sha: match[2]!, repo });
  }
  if (catalog.ticketMatcher) {
    for (const match of text.matchAll(catalog.ticketMatcher)) {
      const range = prose(match);
      if (range && Number(match[2]) <= MAX_TICKET_NUMBER) {
        add(1, { kind: "ticket", ...range, ref: match[1]!.toUpperCase() });
      }
    }
  }
  for (const match of text.matchAll(PR_NUMBER)) {
    const range = prose(match);
    if (range) add(2, { kind: "pr", ...range, number: Number(match[2]) });
  }
  for (const match of text.matchAll(BARE_SHA)) {
    const range = prose(match);
    if (range && isCommitSha(match[0])) add(3, { kind: "sha", ...range, sha: match[0] });
  }

  const marked = new Uint8Array(text.length);
  candidates.sort((a, b) => a.priority - b.priority || a.item.start - b.item.start);
  for (const { item } of candidates) {
    if (marked.subarray(item.start, item.end).some((value) => value !== 0)) continue;
    marked.fill(1, item.start, item.end);
    accepted.push(item);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function uniqueRepo(repos: readonly Repo[]): Repo | undefined {
  const unique = new Set(repos);
  return unique.size === 1 ? [...unique][0] : undefined;
}

function pullRequestUrl(repo: Repo, number: number): string {
  return repositoryPullRequestUrl(repo.url, number, repo.pullSegment);
}

function commitUrl(repo: Repo, sha: string): string {
  return repositoryCommitUrl(repo.url, sha, repo.dash ? "dash" : "standard");
}

/**
 * References for several documents that share one message. Each line inherits the repository
 * named above it; a PR number or SHA resolves from the nearest repository on its line, then from
 * what the message already bound, then from the inherited one, the tickets' repository, and the
 * default.
 */
export function planChatReferences(
  documents: readonly ChatReferenceDocument[],
  context: ChatReferenceContext = {},
): ChatReference[][] {
  const catalog = buildCatalog(context);
  const state: { active?: Repo } = {};
  const lines = documents.map((document) => scanLines(document, catalog, state));
  const items = documents.map((document) => collectItems(document, catalog));

  const mentionedRefs = new Set(
    items.flat().flatMap((item) => (item.kind === "ticket" ? [item.ref] : [])),
  );
  const ticketRepo = uniqueRepo(
    [...mentionedRefs].flatMap((ref) => catalog.ticketRepos.get(ref) ?? []),
  );
  const pullRequests = [
    ...[...mentionedRefs].flatMap((ref) => catalog.ticketPullRequests.get(ref) ?? []),
    ...catalog.jobPullRequests,
  ];
  const jobWithCommit = (sha: string) =>
    catalog.jobs.find(({ job, repo }) => {
      const commit = job.commit?.trim().toLowerCase() ?? "";
      return repo !== undefined && isCommitSha(commit) && commit.startsWith(sha);
    });

  const boundPullRequests = new Map<number, Repo>();
  const boundShas: { sha: string; repo: Repo }[] = [];

  return documents.map((_document, index) => {
    const references: ChatReference[] = [];
    for (const item of items[index]!) {
      const line = lineAt(lines[index]!, item.start);
      const near = nearestMention(line.mentions, item.start, item.end)?.repo;
      if (item.kind === "ticket") {
        references.push({ start: item.start, end: item.end, kind: "ticket", ticketRef: item.ref });
        continue;
      }
      if (item.kind === "pr") {
        let found: { repo: Repo; href: string } | undefined;
        if (item.repo) {
          found = { repo: item.repo, href: pullRequestUrl(item.repo, item.number) };
        } else {
          const matches = pullRequests.filter((candidate) => candidate.number === item.number);
          const exact = near ? matches.find((candidate) => candidate.repo === near) : undefined;
          const distinct = [
            ...new Map(matches.map((candidate) => [candidate.url, candidate])).values(),
          ];
          if (exact) found = { repo: exact.repo, href: exact.url };
          else if (near) found = { repo: near, href: pullRequestUrl(near, item.number) };
          else if (distinct.length === 1)
            found = { repo: distinct[0]!.repo, href: distinct[0]!.url };
          else {
            const repo =
              boundPullRequests.get(item.number) ??
              line.active ??
              ticketRepo ??
              catalog.defaultRepo;
            if (repo) found = { repo, href: pullRequestUrl(repo, item.number) };
          }
        }
        if (!found) continue;
        boundPullRequests.set(item.number, found.repo);
        references.push({ start: item.start, end: item.end, kind: "link", href: found.href });
        continue;
      }
      const lower = item.sha.toLowerCase();
      const jobRepo = item.repo ? undefined : jobWithCommit(lower)?.repo;
      const repo =
        item.repo ??
        jobRepo ??
        near ??
        boundShas.find((bound) => bound.sha.startsWith(lower) || lower.startsWith(bound.sha))
          ?.repo ??
        line.active ??
        ticketRepo ??
        catalog.defaultRepo;
      if (!repo) continue;
      if (!boundShas.some((bound) => bound.sha === lower)) boundShas.push({ sha: lower, repo });
      references.push({
        start: item.start,
        end: item.end,
        kind: "link",
        href: commitUrl(repo, item.sha),
      });
    }
    return references;
  });
}

const referenceParser = unified().use(remarkParse).use(remarkGfm);
type ReferenceTree = ReturnType<typeof referenceParser.parse>;
type ReferenceNode = ReferenceTree | ReferenceTree["children"][number];

/** Markdown split into the spans a reference may use; links, images, HTML and code blocks are skipped. */
export function markdownReferenceDocument(text: string): ChatReferenceDocument {
  const spans: ChatReferenceSpan[] = [];
  const fences: { start: number; end: number }[] = [];
  try {
    const visit = (node: ReferenceNode) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      switch (node.type) {
        case "code":
          fences.push({ start, end });
          return;
        case "inlineCode":
          spans.push({ start, end, code: node.value.trim() });
          return;
        case "text":
          spans.push({ start, end });
          return;
        case "html":
        case "link":
        case "image":
        case "linkReference":
        case "imageReference":
        case "definition":
          return;
        default:
          if ("children" in node) for (const child of node.children) visit(child);
      }
    };
    visit(referenceParser.parse(text));
  } catch {
    return { text, spans: [], fences: [] };
  }
  return { text, spans, fences };
}

/** Plain text (a user bubble) as one prose document, except the given ranges. */
export function plainReferenceDocument(
  text: string,
  skips: readonly { start: number; end: number }[],
): ChatReferenceDocument {
  const spans: ChatReferenceSpan[] = [];
  let cursor = 0;
  for (const skip of [...skips].sort((a, b) => a.start - b.start)) {
    if (skip.start > cursor) spans.push({ start: cursor, end: skip.start });
    cursor = Math.max(cursor, skip.end);
  }
  if (cursor < text.length) spans.push({ start: cursor, end: text.length });
  return { text, spans, fences: [] };
}

/** References in plain text, avoiding the skipped ranges (for example page and URL links). */
export function planPlainChatReferences(
  text: string,
  skips: readonly { start: number; end: number }[],
  context: ChatReferenceContext,
): ChatReference[] {
  return planChatReferences([plainReferenceDocument(text, skips)], context)[0] ?? [];
}

function applyChatReferences(text: string, references: readonly ChatReference[]): string {
  let result = "";
  let cursor = 0;
  for (const reference of references) {
    const raw = text.slice(reference.start, reference.end);
    result += text.slice(cursor, reference.start);
    result +=
      reference.kind === "ticket"
        ? `[${raw}](${TICKET_URL_PREFIX}${reference.ticketRef})`
        : `[${raw}](<${reference.href}>)`;
    cursor = reference.end;
  }
  return result + text.slice(cursor);
}

/** Markdown with its tickets, pull requests and commit SHAs linked where they resolve. */
export function withChatReferences(text: string, context?: ChatReferenceContext): string {
  if (!context) return text;
  const document = markdownReferenceDocument(text);
  return applyChatReferences(text, planChatReferences([document], context)[0] ?? []);
}

/** Message blocks whose prose links their references, sharing one message's repository context. */
export function withBlockChatReferences(
  blocks: readonly MessageBlock[],
  context?: ChatReferenceContext,
): MessageBlock[] {
  if (!context) return [...blocks];
  const prose = blocks.flatMap((block, index) =>
    block.kind === "text" || (block.kind === "progress" && !block.activity) ? [index] : [],
  );
  const documents = prose.map((index) =>
    markdownReferenceDocument((blocks[index] as { text: string }).text),
  );
  const plans = planChatReferences(documents, context);
  const texts = new Map(
    prose.map((index, position) => [
      index,
      applyChatReferences(documents[position]!.text, plans[position] ?? []),
    ]),
  );
  return blocks.map((block, index) =>
    texts.has(index) ? ({ ...block, text: texts.get(index) } as MessageBlock) : block,
  );
}

/** The commit URL for a JobCard's commit, from its PR, its URL, or its `owner/repo` in the repositories. */
export function resolveJobCommitUrl(
  job: ChatJobReference,
  repositories: readonly ChatRepository[] = [],
): string | undefined {
  const commit = job.commit?.trim() ?? "";
  if (!isCommitSha(commit)) return undefined;
  const repo = buildCatalog({ repositories, jobs: [job] }).jobs[0]?.repo;
  return repo ? commitUrl(repo, commit) : undefined;
}
