/**
 * Placeholder argument linting for bot tool calls. A model that does not know what to fill
 * in often writes a stub — "placeholder", "a", "${name}", "xxx" — and the tool then creates
 * junk a user sees (a poll titled "placeholder" with options "a" and "b"). These rules catch
 * such values before the tool runs; the runtime rejects the call with a message that asks the
 * model for the actual value, and the model can re-issue the call.
 *
 * The rules mirror the Go detector in apps/api-go/internal/placeholderlint, with the runtime's
 * own designations: prose arguments a bot may be asked to transcribe verbatim (file contents,
 * commands, prompts) are exempt, and so are the computer tools, whose values are keystrokes
 * and UI text. Enum and const values the tool's own schema declares are never placeholders.
 */

/** The argument names whose values a bot may be asked to produce verbatim: files, commands, prompts. */
const PROSE_ARGUMENT_NAMES: Record<string, true> = {
  content: true,
  body: true,
  code: true,
  command: true,
  task: true,
  instructions: true,
  prompt: true,
  detail: true,
  old_text: true,
};

/** Tools whose argument values are keystrokes and UI text, where any short value is legitimate. */
const COMPUTER_TOOLS: Record<string, true> = {
  computer_observe: true,
  computer_act: true,
  browser_navigate: true,
  browser_snapshot: true,
  browser_act: true,
  open_path: true,
  launch_app: true,
  request_takeover: true,
  user_computer_observe: true,
  user_computer_act: true,
};

/** Whole values (compared after normalization) that are filler, not content. */
const PLACEHOLDER_WORDS = [
  "placeholder",
  "dummy",
  "sample",
  "example",
  "template",
  "todo",
  "fixme",
  "tbd",
  "n/a",
  "unknown",
  "unspecified",
  "lorem",
  "loremipsum",
  "testvalue",
  "sometext",
  "test",
  "testing",
  "foo",
  "bar",
  "baz",
  "asdf",
  "qwerty",
  "abc",
  "xyz",
  "tmp",
  "temp",
];

/**
 * Markup tag, SVG, XML root and C/C++ standard header names an angle token may hold as real
 * content, not a placeholder. "path" and "text" are deliberately absent: they are also common
 * placeholder names.
 */
const ANGLE_TOKEN_DENYLIST: Record<string, true> = {
  // HTML elements.
  a: true,
  abbr: true,
  address: true,
  area: true,
  article: true,
  aside: true,
  audio: true,
  b: true,
  base: true,
  bdi: true,
  bdo: true,
  blockquote: true,
  body: true,
  br: true,
  button: true,
  canvas: true,
  caption: true,
  cite: true,
  code: true,
  col: true,
  colgroup: true,
  data: true,
  datalist: true,
  dd: true,
  del: true,
  details: true,
  dfn: true,
  dialog: true,
  div: true,
  dl: true,
  dt: true,
  em: true,
  embed: true,
  fieldset: true,
  figcaption: true,
  figure: true,
  footer: true,
  form: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  head: true,
  header: true,
  hgroup: true,
  hr: true,
  html: true,
  i: true,
  iframe: true,
  img: true,
  input: true,
  ins: true,
  kbd: true,
  label: true,
  legend: true,
  li: true,
  link: true,
  main: true,
  map: true,
  mark: true,
  menu: true,
  meta: true,
  meter: true,
  nav: true,
  noscript: true,
  object: true,
  ol: true,
  optgroup: true,
  option: true,
  output: true,
  p: true,
  picture: true,
  pre: true,
  progress: true,
  q: true,
  rp: true,
  rt: true,
  ruby: true,
  s: true,
  samp: true,
  script: true,
  search: true,
  section: true,
  select: true,
  slot: true,
  small: true,
  source: true,
  span: true,
  strong: true,
  style: true,
  sub: true,
  summary: true,
  sup: true,
  table: true,
  tbody: true,
  td: true,
  tfoot: true,
  th: true,
  thead: true,
  time: true,
  title: true,
  tr: true,
  track: true,
  u: true,
  ul: true,
  var: true,
  video: true,
  wbr: true,
  // Common SVG elements.
  circle: true,
  clippath: true,
  defs: true,
  desc: true,
  ellipse: true,
  g: true,
  image: true,
  line: true,
  lineargradient: true,
  marker: true,
  mask: true,
  metadata: true,
  pattern: true,
  polygon: true,
  polyline: true,
  radialgradient: true,
  rect: true,
  stop: true,
  svg: true,
  switch: true,
  symbol: true,
  tspan: true,
  use: true,
  view: true,
  // Common XML roots.
  catalog: true,
  config: true,
  feed: true,
  manifest: true,
  note: true,
  root: true,
  rss: true,
  sitemapindex: true,
  urlset: true,
  // C standard headers.
  "assert.h": true,
  "complex.h": true,
  "ctype.h": true,
  "errno.h": true,
  "fenv.h": true,
  "float.h": true,
  "inttypes.h": true,
  "iso646.h": true,
  "limits.h": true,
  "locale.h": true,
  "math.h": true,
  "pthread.h": true,
  "setjmp.h": true,
  "signal.h": true,
  "stdalign.h": true,
  "stdarg.h": true,
  "stdatomic.h": true,
  "stdbit.h": true,
  "stdckdint.h": true,
  "stddef.h": true,
  "stdint.h": true,
  "stdnoreturn.h": true,
  "tgmath.h": true,
  "threads.h": true,
  "time.h": true,
  "uchar.h": true,
  "unistd.h": true,
  // POSIX headers.
  "fcntl.h": true,
  "termios.h": true,
  // C++ standard headers.
  algorithm: true,
  any: true,
  array: true,
  atomic: true,
  barrier: true,
  bit: true,
  bitset: true,
  cassert: true,
  cctype: true,
  cerrno: true,
  cfenv: true,
  cfloat: true,
  charconv: true,
  chrono: true,
  cinttypes: true,
  climits: true,
  clocale: true,
  cmath: true,
  codecvt: true,
  compare: true,
  complex: true,
  concepts: true,
  condition_variable: true,
  coroutine: true,
  csetjmp: true,
  csignal: true,
  cstdarg: true,
  cstddef: true,
  cstdint: true,
  cstdio: true,
  cstdlib: true,
  cstring: true,
  ctgmath: true,
  ctime: true,
  cuchar: true,
  cwchar: true,
  cwctype: true,
  deque: true,
  exception: true,
  execution: true,
  expected: true,
  filesystem: true,
  flat_map: true,
  flat_set: true,
  format: true,
  forward_list: true,
  fstream: true,
  functional: true,
  future: true,
  generator: true,
  hazard_pointer: true,
  initializer_list: true,
  inplace_vector: true,
  iomanip: true,
  ios: true,
  iosfwd: true,
  iostream: true,
  istream: true,
  iterator: true,
  latch: true,
  limits: true,
  list: true,
  locale: true,
  mdspan: true,
  memory: true,
  memory_resource: true,
  mutex: true,
  new: true,
  numbers: true,
  numeric: true,
  optional: true,
  ostream: true,
  print: true,
  queue: true,
  random: true,
  ranges: true,
  ratio: true,
  regex: true,
  scoped_allocator: true,
  semaphore: true,
  set: true,
  shared_mutex: true,
  source_location: true,
  spanstream: true,
  sstream: true,
  stack: true,
  stacktrace: true,
  stdbool: true,
  stdexcept: true,
  "stdio.h": true,
  "stdlib.h": true,
  stop_token: true,
  streambuf: true,
  string: true,
  "string.h": true,
  string_view: true,
  strstream: true,
  syncstream: true,
  system_error: true,
  text_encoding: true,
  thread: true,
  tuple: true,
  type_traits: true,
  typeindex: true,
  typeinfo: true,
  unordered_map: true,
  unordered_set: true,
  utility: true,
  valarray: true,
  variant: true,
  vector: true,
  version: true,
  "wchar.h": true,
  "wctype.h": true,
};

/** Longest offending value shown in a model-facing message, including the ellipsis. */
const FEEDBACK_VALUE_LIMIT = 40;

export interface PlaceholderFinding {
  /** The escaped path of the argument, such as "options[0]"; keys escape "\.[ and ] and an empty key is "\0". */
  path: string;
  /** The rule that flagged the value. */
  rule: string;
  /** The full offending value. */
  value: string;
}
/** The stable, model-facing feedback line: the path and a truncated value. */
export function placeholderFindingMessage(finding: PlaceholderFinding): string {
  const shown =
    finding.value.length > FEEDBACK_VALUE_LIMIT
      ? `${finding.value.slice(0, FEEDBACK_VALUE_LIMIT - 3)}...`
      : finding.value;
  return `argument "${unescapeKey(finding.path)}" looks like a placeholder ("${shown}"); provide the actual value, or ask the user if it's unknown`;
}

/** One line per finding; the model sees them all and can fix every argument in one re-issue. */
export function placeholderRejectionMessage(findings: readonly PlaceholderFinding[]): string {
  return findings.map(placeholderFindingMessage).join(" ");
}

/**
 * Lints one tool call's arguments and returns the flagged values, at most one per argument
 * path, sorted by path. `schema` is the tool's declared JSON schema: its top-level `required`
 * names drive the blank check, and its top-level `enum` and `const` values are known
 * legitimate. Non-string leaves and unknown shapes are skipped; the walk cannot loop.
 */
export function lintPlaceholderArguments(
  toolName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): PlaceholderFinding[] {
  if (COMPUTER_TOOLS[toolName]) return [];
  const properties = record(schema?.properties);
  const known = knownValues(properties);
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const findings: PlaceholderFinding[] = [];
  const onPath = new Set<unknown>();

  const check = (path: string, name: string, value: string) => {
    if (PROSE_ARGUMENT_NAMES[name]) return;
    if (known.has(lastKey(path), value)) return;
    for (const rule of RULES) {
      if (rule.check({ value, required: required.has(name) })) {
        findings.push({ path, rule: rule.name, value });
        return;
      }
    }
  };

  const walk = (prefix: string, value: unknown) => {
    if (typeof value === "string") {
      check(prefix, lastKey(prefix), value);
      return;
    }
    if (value === null || typeof value !== "object" || onPath.has(value)) return;
    onPath.add(value);
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(`${prefix}[${index}]`, item);
    } else {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        walk(joinPath(prefix, key), item);
      }
    }
    onPath.delete(value);
  };
  for (const [key, item] of Object.entries(args)) walk(escapeKey(key), item);
  return findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A named check over one string argument value. */
interface Rule {
  name: string;
  check(argument: { value: string; required: boolean }): boolean;
}

const RULES: readonly Rule[] = [
  {
    name: "blank-required",
    check: ({ value, required }) => required && value.trim() === "",
  },
  {
    name: "template-token",
    check: ({ value }) => containsTemplateToken(value),
  },
  {
    name: "placeholder-word",
    check: ({ value }) => {
      const normalized = normalizeWord(value);
      return (
        normalized !== "" && PLACEHOLDER_WORDS.some((word) => normalized === normalizeWord(word))
      );
    },
  },
  {
    // The Go detector leaves lowercase single letters alone as possible words; a whole tool
    // argument that is one letter is a stub in practice ("a", "b" as poll options), so here
    // both cases are flagged.
    name: "alphabet-index",
    check: ({ value }) => /^[A-Za-z](\d{1,2})?$/.test(value.trim()),
  },
  {
    name: "filler-repeat",
    check: ({ value }) => {
      const trimmed = value.trim();
      if (trimmed.length < 3) return false;
      const first = trimmed.at(0)?.toLowerCase() ?? "";
      return [...trimmed].every(
        (character) => /[A-Za-z]/.test(character) && character.toLowerCase() === first,
      );
    },
  },
];

function containsTemplateToken(value: string): boolean {
  const dollar = value.indexOf("${");
  if (dollar >= 0 && value.slice(dollar + 2).includes("}")) return true;
  const brace = value.indexOf("{{");
  if (brace >= 0 && value.slice(brace + 2).includes("}}")) return true;
  if (containsAngleToken(value)) return true;
  return containsPrintfToken(value);
}

/**
 * Angle tokens such as "<name>", delimited by non-word characters on both sides. Anything with
 * attributes, a closing tag, a doctype or non-name characters is left alone, as are markup and
 * standard header names.
 */
function containsAngleToken(value: string): boolean {
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "<") continue;
    const closing = value.indexOf(">", start + 1);
    if (closing < 0) return false;
    if (
      angleTokenContent(value.slice(start + 1, closing)) &&
      !touchesWordRune(value, start, closing)
    ) {
      return true;
    }
  }
  return false;
}

function angleTokenContent(content: string): boolean {
  if (content.length === 0 || content.length > 60) return false;
  const first = content.at(0);
  if (first === undefined || !/[A-Za-z_]/.test(first)) return false;
  let hasLetter = false;
  for (const character of content) {
    if (/[A-Za-z]/.test(character)) hasLetter = true;
    else if (!/[0-9_.\- ]/.test(character)) return false;
  }
  return hasLetter && !ANGLE_TOKEN_DENYLIST[content.trim().toLowerCase()];
}

/** Whether a letter, digit or underscore touches the token at [start, end] on either side. */
function touchesWordRune(value: string, start: number, end: number): boolean {
  const previous = start > 0 ? value.codePointAt(start - 1) : undefined;
  const next = end + 1 < value.length ? value.codePointAt(end + 1) : undefined;
  const wordRune = (code: number | undefined) =>
    code !== undefined &&
    (/\p{L}|\p{M}|\p{Nd}|\p{Nl}/u.test(String.fromCodePoint(code)) || code === 95);
  return wordRune(previous) === true || wordRune(next) === true;
}

/**
 * Printf tokens such as "%s", "%.2f", "%02d", "%+v" and the positional "%1" through "%9".
 * Percent-encoding comes first: a "%1"–"%9" followed by a hexadecimal digit, or "%0" followed
 * by a hex digit that is also a verb folded to lower case (b, d, e, f), is an escape ("%20",
 * "%2F", "%1F", "%0d"), never printf. The space flag is deliberately not recognized so text
 * such as "5% v/v" stays quiet, and a verb followed by a word character ("%done") is not one.
 */
function containsPrintfToken(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%" || percentEncodingLike(value, index)) continue;
    if (numericPrintfToken(value, index)) return true;
    const next = value[index + 1];
    if (next !== undefined && next >= "1" && next <= "9") return true;
  }
  return false;
}

function percentEncodingLike(value: string, index: number): boolean {
  if (index + 2 >= value.length) return false;
  const leading = value[index + 1] ?? "";
  if (leading === "0") {
    // A "%0" escape names a hex digit that is also a printf verb once folded (b, d, e, f).
    const second = value[index + 2] ?? "";
    return isHexDigit(second) && isPrintfVerb(second.toLowerCase());
  }
  return leading >= "1" && leading <= "9" && isHexDigit(value[index + 2] ?? "");
}

function numericPrintfToken(value: string, index: number): boolean {
  let cursor = index + 1;
  while (cursor < value.length && ["+", "#", "-"].includes(value[cursor] ?? "")) cursor += 1;
  while (cursor < value.length && /[0-9.]/.test(value[cursor] ?? "")) cursor += 1;
  const verb = value[cursor];
  if (verb === undefined || !isPrintfVerb(verb)) return false;
  const following = value[cursor + 1];
  return following === undefined || !/[A-Za-z0-9_]/.test(following);
}

function isPrintfVerb(character: string): boolean {
  return ["s", "d", "f", "v", "q", "t", "x", "e", "g", "b", "o"].includes(character.toLowerCase());
}

function isHexDigit(character: string): boolean {
  return /[0-9A-Fa-f]/.test(character);
}

/** The normalized form a placeholder word compares against: folded, ignoring separators. */
function normalizeWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Known legitimate values, keyed by the argument name the schema declares them for. */
function knownValues(properties: Record<string, unknown>) {
  const byName = new Map<string, Set<string>>();
  for (const [name, spec] of Object.entries(properties)) {
    const field = record(spec);
    const values = new Set<string>();
    for (const item of Array.isArray(field.enum) ? field.enum : []) {
      if (typeof item === "string") values.add(item);
    }
    if (typeof field.const === "string") values.add(field.const);
    if (values.size) byName.set(name, values);
  }
  return {
    has(name: string, value: string): boolean {
      return byName.get(name)?.has(value) ?? false;
    },
  };
}

/** The unescaped name of the nearest map key; the array's key for an array element. */
function lastKey(path: string): string {
  return unescapeKey((path.split(".").at(-1) ?? "").replace(/\[\d+\]$/, ""));
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${escapeKey(key)}` : escapeKey(key);
}

/** In a path, "\" is written "\\", "." as "\.", "[" as "\[", "]" as "\]", an empty key as "\0". */
function escapeKey(key: string): string {
  return key
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/^$/, "\\0");
}

function unescapeKey(path: string): string {
  return path.replace(/\\(.)/g, "$1").replace(/^\\0$/, "");
}
