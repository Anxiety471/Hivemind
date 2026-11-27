/**
 * Finds a choice the bot wrote out as prose (a question line and a short option list at the end
 * of the message) so the run can ask it as an interactive card instead. Deterministic and
 * high-precision: any doubt returns null and the message stays exactly as written.
 */

export type ExtractedProseChoice = {
  /** Text before the choice question (if any), kept as context. */
  preamble?: string;
  /** The concise question line (<= 240 chars). */
  question: string;
  /** 2..4 structured choice actions. */
  actions: Array<{
    id: string;
    label: string;
    description?: string;
    recommended?: boolean;
  }>;
};

const MAX_QUESTION_LENGTH = 240;
const MAX_TRAILING_LENGTH = 180;
const MAX_LABEL_LENGTH = 120;
const MAX_SPLIT_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

const FENCE = /^\s{0,3}(```|~~~)/;
const ITEM = /^(\s*)([-*+]|\d{1,2}[.)]|[A-Za-z][.)])\s+(\S.*)$/;
const CHOICE_CUE =
  /\b(choose|pick|prefer|proceed|option|want|should i|should we|would you like|do you want|how do you want|what do you want|which way|reply with)\b|\bwhich\b[^?]*\b(do|would|should|want|prefer|like|use|go)\b/i;
const HEADER = /^(pick one|choose one|options|your options|choose|pick|decide|which[^?]*):$/i;
const INLINE_RECOMMENDED_SOURCE =
  "\\(\\s*recommended\\s*\\)|\\[\\s*recommended\\s*\\]|[—–-]\\s*recommended\\b|\\brecommended:";
const INLINE_RECOMMENDED = new RegExp(INLINE_RECOMMENDED_SOURCE, "i");
const RECOMMENDATION_CUE =
  /\b(this is my recommendation|my recommendation|i recommend this|recommended option|recommended approach)\b/i;
/** A cue sentence at the start of a description, which the badge already says. */
const LEADING_RECOMMENDATION_SENTENCE =
  /^(?:this is my recommendation|my recommendation|i recommend this|recommended option|recommended approach)\s*[.!:]\s*/i;

type ParsedOption = { label: string; description?: string; marked: boolean };

function markerKind(marker: string): string {
  if (/^[-*+]$/.test(marker)) return "bullet";
  return /^\d/.test(marker) ? "number" : "letter";
}

/** Lines in fenced code blocks: never a question, option, or prose. */
function codeLines(lines: string[]): boolean[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const match = FENCE.exec(line);
    if (fence) {
      if (match?.[1] === fence) fence = undefined;
      return true;
    }
    if (match) {
      fence = match[1];
      return true;
    }
    return false;
  });
}

type Range = { start: number; end: number };

/** Runs of prose lines, split by blank lines and code. */
function proseRanges(lines: string[], code: boolean[]): Range[] {
  const ranges: Range[] = [];
  let start = -1;
  lines.forEach((line, index) => {
    const prose = !code[index] && line.trim() !== "";
    if (prose && start < 0) start = index;
    if (!prose && start >= 0) {
      ranges.push({ start, end: index - 1 });
      start = -1;
    }
  });
  if (start >= 0) ranges.push({ start, end: lines.length - 1 });
  return ranges;
}

/** The line at an index; the caller keeps indexes inside the message. */
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}

function blankBetween(lines: string[], from: number, to: number): boolean {
  for (let index = from; index < to; index++) {
    if (lineAt(lines, index).trim() !== "") return false;
  }
  return true;
}

/** Each option's text, joined across its wrapped lines; null for nested or structural lines. */
function listItems(lines: string[], start: number, end: number): string[] | null {
  const items: string[][] = [];
  let kind: string | undefined;
  for (let index = start; index <= end; index++) {
    const line = lineAt(lines, index);
    const match = ITEM.exec(line);
    if (match) {
      const [, indent = "", marker = "", body = ""] = match;
      // A marker indented under an option is a nested list, which this does not read.
      if (indent.length >= 2) return null;
      const next = markerKind(marker);
      if (kind && next !== kind) return null;
      kind = next;
      items.push([body]);
      continue;
    }
    const current = items.at(-1);
    if (!current || /^\s*(#|>|\|)/.test(line)) return null;
    current.push(line.trim());
  }
  return items.map((parts) => parts.join(" ").trim());
}

function trimLabel(value: string): string {
  return value
    .trim()
    .replace(/[\s:.\-—–]+$/, "")
    .trim();
}

function stripInlineRecommendation(value: string): string {
  return value.replace(new RegExp(INLINE_RECOMMENDED_SOURCE, "gi"), "").trim();
}

function parseOption(item: string): Omit<ParsedOption, "marked"> | null {
  const bold = /^\*\*(.+?)\*\*(.*)$/.exec(item);
  let label: string;
  let description: string | undefined;
  if (bold) {
    const [, boldText = "", rest = ""] = bold;
    label = trimLabel(boldText);
    description = rest.replace(/^\s*[:—–-]+\s*/, "").trim();
  } else {
    const split = /^(.{2,100}?)\s*(?::\s+|\s+[—–-]\s+|\s*[—–]\s*)(.+)$/.exec(item);
    if (split) {
      const [, splitLabel = "", splitDescription = ""] = split;
      label = trimLabel(splitLabel);
      description = splitDescription.trim();
    } else {
      if (item.length > MAX_SPLIT_LABEL_LENGTH) return null;
      label = trimLabel(item);
    }
  }
  if (label.length < 2 || label.length > MAX_LABEL_LENGTH) return null;
  return {
    label,
    ...(description ? { description: description.slice(0, MAX_DESCRIPTION_LENGTH).trim() } : {}),
  };
}

function isTrailingLine(line: string): boolean {
  return (
    line.length > 0 &&
    line.length <= MAX_TRAILING_LENGTH &&
    !ITEM.test(line) &&
    !/^[#>|]/.test(line)
  );
}

/** Options the closing line recommends by number, letter, or label. */
function trailingRecommendations(trailing: string | undefined, options: ParsedOption[]): number[] {
  if (!trailing || !/recommend/i.test(trailing)) return [];
  const found = new Set<number>();
  for (const match of trailing.matchAll(
    /\b(?:option|#)\s*([1-4])\b|\brecommend\w*(?:\s+is)?\s+#?([1-4])\b/gi,
  )) {
    found.add(Number(match[1] ?? match[2] ?? 0) - 1);
  }
  for (const [, letter = "A"] of trailing.matchAll(/\boption\s+([A-D])\b/g)) {
    found.add(letter.charCodeAt(0) - 65);
  }
  const lower = trailing.toLowerCase();
  options.forEach((option, index) => {
    if (option.label.length >= 4 && lower.includes(option.label.toLowerCase())) found.add(index);
  });
  return [...found].filter((index) => index < options.length);
}

export function extractProseChoiceQuestion(text: string): ExtractedProseChoice | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const code = codeLines(lines);
  const ranges = proseRanges(lines, code);
  const last = ranges.at(-1);
  if (!last || lines.slice(last.end + 1).some((line) => line.trim() !== "")) return null;

  // The list is the last block; a single short line after it is the closing remark.
  let listIndex = ranges.length - 1;
  let listEnd = last.end;
  let trailing: string | undefined;
  if (!ITEM.test(lineAt(lines, last.start))) {
    if (last.start !== last.end || !isTrailingLine(lineAt(lines, last.end).trim())) return null;
    listIndex = ranges.length - 2;
    const list = ranges[listIndex];
    if (!list || !blankBetween(lines, list.end + 1, last.start)) return null;
    trailing = lineAt(lines, last.end).trim();
    listEnd = list.end;
  } else if (
    last.end > last.start &&
    !/^\s/.test(lineAt(lines, last.end)) &&
    !ITEM.test(lineAt(lines, last.end))
  ) {
    // A closing line with no blank line before it still ends the list.
    trailing = lineAt(lines, last.end).trim();
    if (!isTrailingLine(trailing)) return null;
    listEnd = last.end - 1;
  }
  const list = ranges[listIndex];
  if (!list) return null;
  let first = list.start;
  while (first <= listEnd && !ITEM.test(lineAt(lines, first))) first++;
  if (first > listEnd) return null;

  // The question is the line right before the list: the same block, or the block above it.
  let questionIndex: number;
  if (first > list.start) {
    questionIndex = first - 1;
  } else {
    const above = ranges[listIndex - 1];
    if (!above || !blankBetween(lines, above.end + 1, first)) return null;
    questionIndex = above.end;
  }
  const question = lineAt(lines, questionIndex).trim();
  const bare = question.replace(/[*_`\s]+$/, "");
  if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) return null;
  const cue = bare.endsWith("?") && CHOICE_CUE.test(bare);
  const header = HEADER.test(bare);

  const items = listItems(lines, first, listEnd);
  if (!items || items.length < MIN_OPTIONS || items.length > MAX_OPTIONS) return null;
  const parsed: ParsedOption[] = [];
  for (const item of items) {
    const option = parseOption(item);
    if (!option) return null;
    parsed.push({
      ...option,
      marked: INLINE_RECOMMENDED.test(item) || RECOMMENDATION_CUE.test(item),
    });
  }
  const labels = new Set(parsed.map((option) => option.label.toLowerCase()));
  if (labels.size !== parsed.length) return null;

  // Only an unambiguous recommendation is kept; two candidates are a guess, so none is marked.
  const candidates = new Set([
    ...parsed.flatMap((option, index) => (option.marked ? [index] : [])),
    ...trailingRecommendations(trailing, parsed),
  ]);
  const recommendedIndex = candidates.size === 1 ? [...candidates][0] : undefined;
  if (!cue && !(header && recommendedIndex !== undefined)) return null;

  const actions = parsed.map((option, index) => {
    const recommended = index === recommendedIndex;
    const label = recommended ? trimLabel(stripInlineRecommendation(option.label)) : option.label;
    const description =
      recommended && option.description
        ? stripInlineRecommendation(option.description)
            .replace(LEADING_RECOMMENDATION_SENTENCE, "")
            .trim()
        : option.description;
    return {
      id: `choice-${index + 1}`,
      label,
      ...(description ? { description } : {}),
      ...(recommended ? { recommended: true as const } : {}),
    };
  });

  const preamble = lines.slice(0, questionIndex).join("\n").trim();
  return {
    ...(preamble ? { preamble } : {}),
    question,
    actions,
  };
}
