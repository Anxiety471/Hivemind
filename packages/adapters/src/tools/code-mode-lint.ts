export interface CodeModeLintFinding {
  rule: string;
  line: number;
  message: string;
}

export interface CodeModeLintOptions {
  mode?: "script" | "command";
  tools?: readonly string[];
  commandPrefix?: string;
}

const REGEX_PREV_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "typeof",
  "void",
  "delete",
  "await",
  "yield",
  "in",
  "of",
  "instanceof",
  "new",
  "else",
  "do",
]);

/**
 * Replaces comments, string literals, template text (preserving `${...}` expressions), and regex
 * literals with spaces while keeping `\n` in place so character offsets map to exact 1-based lines.
 */
function stripNonCode(code: string): string {
  const out = new Array<string>(code.length).fill(" ");
  const stack: Array<{ kind: "template" } | { kind: "expr"; depth: number }> = [];
  let canStartRegex = true;
  let i = 0;

  const isIdentStart = (ch: string) => /[A-Za-z_$]/.test(ch);
  const isIdentChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

  const scanString = (quote: string) => {
    i += 1;
    while (i < code.length) {
      const ch = code[i]!;
      if (ch === "\n") out[i] = "\n";
      if (ch === "\\") {
        if (i + 1 < code.length && code[i + 1] === "\n") out[i + 1] = "\n";
        i += 2;
        continue;
      }
      if (ch === quote) {
        i += 1;
        break;
      }
      i += 1;
    }
    canStartRegex = false;
  };

  const scanRegex = () => {
    i += 1;
    let inClass = false;
    while (i < code.length) {
      const ch = code[i]!;
      if (ch === "\n") break;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "[" && !inClass) {
        inClass = true;
      } else if (ch === "]" && inClass) {
        inClass = false;
      } else if (ch === "/" && !inClass) {
        i += 1;
        while (i < code.length && /[A-Za-z]/.test(code[i]!)) i += 1;
        break;
      }
      i += 1;
    }
    canStartRegex = false;
  };

  while (i < code.length) {
    const top = stack.at(-1);
    if (top?.kind === "template") {
      const ch = code[i]!;
      if (ch === "\n") {
        out[i] = "\n";
        i += 1;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < code.length && code[i + 1] === "\n") out[i + 1] = "\n";
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        i += 1;
        canStartRegex = false;
        continue;
      }
      if (ch === "$" && code[i + 1] === "{") {
        stack.push({ kind: "expr", depth: 0 });
        i += 2;
        canStartRegex = true;
        continue;
      }
      i += 1;
      continue;
    }

    const ch = code[i]!;
    if (ch === "\n") {
      out[i] = "\n";
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length) {
        if (code[i] === "\n") out[i] = "\n";
        if (code[i] === "*" && code[i + 1] === "/") {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      scanString(ch);
      continue;
    }
    if (ch === "`") {
      stack.push({ kind: "template" });
      i += 1;
      continue;
    }
    if (ch === "/" && canStartRegex) {
      scanRegex();
      continue;
    }
    if (top?.kind === "expr") {
      if (ch === "{") top.depth += 1;
      else if (ch === "}") {
        if (top.depth === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        top.depth -= 1;
      }
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < code.length && isIdentChar(code[i]!)) {
        out[i] = code[i]!;
        i += 1;
      }
      const word = code.slice(start, i);
      canStartRegex = REGEX_PREV_KEYWORDS.has(word);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      while (i < code.length && /[0-9A-Za-z_.]/.test(code[i]!)) {
        out[i] = code[i]!;
        i += 1;
      }
      canStartRegex = false;
      continue;
    }

    out[i] = ch;
    canStartRegex = ch !== ")" && ch !== "]";
    i += 1;
  }

  return out.join("");
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function collectDeclaredNames(stripped: string): Set<string> {
  const declared = new Set<string>();
  const declPattern = /\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const match of stripped.matchAll(declPattern)) {
    if (match[1]) declared.add(match[1]);
  }
  return declared;
}

function collectTryRanges(stripped: string): Array<[start: number, end: number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of stripped.matchAll(/\btry\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < stripped.length; i += 1) {
      if (stripped[i] === "{") depth += 1;
      else if (stripped[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          ranges.push([open, i]);
          break;
        }
      }
    }
  }
  return ranges;
}

function inTryBlock(ranges: ReadonlyArray<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index > start && index < end);
}

function precededBy(stripped: string, index: number, word: string): boolean {
  const before = stripped.slice(0, index).trimEnd();
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${word}$`).test(before);
}

function isPropertyAccess(stripped: string, index: number): boolean {
  const before = stripped.slice(0, index).trimEnd();
  return before.endsWith(".") || before.endsWith("?.");
}

function editDistance(a: string, b: string): number {
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

function closestToolName(name: string, tools: readonly string[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  const target = name.toLowerCase();
  for (const candidate of tools) {
    const dist = editDistance(target, candidate.toLowerCase());
    const maxAllowed = Math.max(2, Math.floor(Math.max(target.length, candidate.length) / 3));
    if (dist <= maxAllowed && (!best || dist < best.score)) {
      best = { name: candidate, score: dist };
    }
  }
  return best?.name;
}

/**
 * Checks a `code_mode` script or saved command body for capabilities the isolate does not
 * provide (`import`, `require`, `fetch`, timers, host globals, nested commands, unknown tools)
 * before starting QuickJS.
 */
export function lintCodeModeScript(
  code: string,
  options: CodeModeLintOptions = {},
): CodeModeLintFinding[] {
  const mode = options.mode ?? "script";
  const stripped = stripNonCode(code);
  const declared = collectDeclaredNames(stripped);
  const tryRanges = collectTryRanges(stripped);
  const findings: CodeModeLintFinding[] = [];

  for (const match of stripped.matchAll(/(?:^|[;\n}])\s*import\b/gm)) {
    const keywordIndex = match.index + match[0].lastIndexOf("import");
    if (stripped.slice(keywordIndex).startsWith("import(")) continue;
    findings.push({
      rule: "no-import",
      line: lineNumberAt(stripped, keywordIndex),
      message: "code_mode has no module imports; use `codemode.<tool>(...)` instead.",
    });
  }

  for (const match of stripped.matchAll(/\bimport\s*\(/g)) {
    const idx = match.index;
    if (isPropertyAccess(stripped, idx) || precededBy(stripped, idx, "typeof")) continue;
    findings.push({
      rule: "no-import",
      line: lineNumberAt(stripped, idx),
      message: "code_mode has no dynamic `import()`; use `codemode.<tool>(...)` instead.",
    });
  }

  for (const match of stripped.matchAll(/\brequire\s*\(/g)) {
    const idx = match.index;
    if (
      declared.has("require") ||
      isPropertyAccess(stripped, idx) ||
      precededBy(stripped, idx, "typeof") ||
      precededBy(stripped, idx, "function")
    ) {
      continue;
    }
    findings.push({
      rule: "no-require",
      line: lineNumberAt(stripped, idx),
      message: "code_mode has no `require()`; use `codemode.<tool>(...)` instead.",
    });
  }

  for (const match of stripped.matchAll(/\bfetch\s*\(/g)) {
    const idx = match.index;
    if (
      declared.has("fetch") ||
      isPropertyAccess(stripped, idx) ||
      precededBy(stripped, idx, "typeof") ||
      precededBy(stripped, idx, "function")
    ) {
      continue;
    }
    findings.push({
      rule: "no-fetch",
      line: lineNumberAt(stripped, idx),
      message:
        "code_mode has no `fetch()`; use `codemode.web_fetch(...)` or `codemode.secret_request(...)`.",
    });
  }

  for (const match of stripped.matchAll(/\b(setTimeout|setInterval)\s*\(/g)) {
    const idx = match.index;
    const name = match[1]!;
    if (
      declared.has(name) ||
      isPropertyAccess(stripped, idx) ||
      precededBy(stripped, idx, "typeof") ||
      precededBy(stripped, idx, "function")
    ) {
      continue;
    }
    findings.push({
      rule: "no-timers",
      line: lineNumberAt(stripped, idx),
      message: `code_mode has no \`${name}()\`; await tool calls directly.`,
    });
  }

  for (const match of stripped.matchAll(
    /(?:\b(process|Deno|Bun)\s*\??\.|\bnew\s+(XMLHttpRequest|WebSocket)\b)/g,
  )) {
    const idx = match.index;
    const name = (match[1] ?? match[2])!;
    if (
      declared.has(name) ||
      (match[1] && (isPropertyAccess(stripped, idx) || precededBy(stripped, idx, "typeof")))
    ) {
      continue;
    }
    findings.push({
      rule: "no-host-globals",
      line: lineNumberAt(stripped, idx),
      message: `code_mode has no \`${name}\`; use the offered \`codemode\` tools instead.`,
    });
  }

  if (mode === "command") {
    for (const match of stripped.matchAll(/\bcodemode\s*\.\s*cmd\s*\.|\bcodemode\s*\[\s*\]/g)) {
      if (match[0].includes("[")) {
        // String content was blanked out by stripNonCode; inspect original slice for "cmd".
        const rawSlice = code.slice(match.index, match.index + match[0].length);
        if (!/\[\s*["']cmd["']\s*\]/.test(rawSlice)) continue;
      }
      findings.push({
        rule: "no-nested-command",
        line: lineNumberAt(stripped, match.index),
        message: "A saved command cannot call another command.",
      });
    }
  }

  if (options.tools) {
    const allowed = new Set(options.tools);
    const prefixNs = options.commandPrefix?.endsWith(".")
      ? options.commandPrefix.slice(0, -1)
      : undefined;
    for (const match of stripped.matchAll(/\bcodemode\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const idx = match.index;
      const name = match[1]!;
      if (allowed.has(name) || name === prefixNs) continue;
      if (inTryBlock(tryRanges, idx)) continue;
      const suggestion = closestToolName(name, options.tools);
      findings.push({
        rule: "no-unknown-tool",
        line: lineNumberAt(stripped, idx),
        message: `${name} is not a tool this run offers${
          suggestion ? `; did you mean \`codemode.${suggestion}\`?` : "."
        } Find available tools with \`codemode.search({ query })\`.`,
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

export function formatCodeModeLintFindings(findings: readonly CodeModeLintFinding[]): string {
  return findings
    .map((finding) => `line ${finding.line} (${finding.rule}): ${finding.message}`)
    .join("\n");
}
