// PlantUML → Mermaid translation for the two diagram kinds agents emit most: activity
// diagrams (the "new" `start / :action; / if (..) then (..)` syntax) and sequence diagrams.
// No PlantUML server is involved, so diagram source never leaves the browser. Pure and
// DOM-free so bun or node can test it. Anything outside the supported subset throws, and the
// caller falls back to showing the source.

export class UnsupportedPlantUml extends Error {}

const SEQUENCE_HINT = /^\s*(participant|actor|boundary|control|entity|database|collections|queue|autonumber|activate|deactivate|alt|loop|opt|par|group)\b|^\s*("[^"]+"|[\w.]+)\s*(<?-+[>x\\/]+|<[\\/]?-+)\s*("[^"]+"|[\w.]+)?\s*:?/m;
const ACTIVITY_HINT = /^\s*(start|stop)\s*$|^\s*(if|while)\s*\(|^\s*(repeat|fork)\b|^\s*:[^\n]*[;|<>/\]}]\s*$/m;
const NON_SEQUENCE_KIND = /^\s*(class|interface|enum|abstract|state|usecase|component|node|package|cloud|\[\*\]|mindmap|gantt|@startmindmap|@startgantt|@startwbs)\b/m;

export function plantumlToMermaid(source: string): string {
  const body = stripEnvelope(source);
  if (NON_SEQUENCE_KIND.test(body) || /^@start(?!uml)/m.test(source)) {
    throw new UnsupportedPlantUml("Only PlantUML activity and sequence diagrams can be rendered; showing source");
  }
  if (ACTIVITY_HINT.test(body)) return activityToMermaid(body);
  if (SEQUENCE_HINT.test(body)) return sequenceToMermaid(body);
  throw new UnsupportedPlantUml("Only PlantUML activity and sequence diagrams can be rendered; showing source");
}

function stripEnvelope(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^\s*@startuml\b/i.test(l));
  const end = lines.findIndex((l, i) => i > start && /^\s*@enduml\b/i.test(l));
  const inner = start >= 0 ? lines.slice(start + 1, end >= 0 ? end : undefined) : lines;
  return inner.join("\n");
}

/** Escape text for a double-quoted Mermaid label; real and literal `\n` become line breaks. */
function label(text: string): string {
  return text
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .split(/\\n|\n/)
    .map((s) => s.trim())
    .join("<br/>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\/\/([^/]+)\/\//g, "<i>$1</i>");
}

function parenArg(s: string): string {
  const m = /^\s*\(([\s\S]*)\)\s*$/.exec(s);
  return m ? m[1] : s.trim();
}

// ---------------------------------------------------------------------------------------
// Activity diagrams

type Tail = { from: string; label: string };

type Frame =
  | { kind: "if"; decision: string; ends: Tail[]; hasElse: boolean }
  | { kind: "while"; decision: string }
  | { kind: "repeat"; entry: string }
  | { kind: "fork"; origin: string; ends: Tail[] };

class ActivityGraph {
  out: string[] = [];
  tails: Tail[] = [];
  stack: Frame[] = [];
  nextLabel = "";
  private n = 0;

  id(): string {
    return `n${this.n++}`;
  }

  private edge(from: string, to: string, text: string) {
    this.out.push(text ? `  ${from} -->|"${label(text)}"| ${to}` : `  ${from} --> ${to}`);
  }

  /** Connect every dangling tail to `to`; the first edge also takes a pending `-> text;` label. */
  link(to: string) {
    for (const t of this.tails) {
      const text = t.label || this.nextLabel;
      if (text) this.nextLabel = "";
      this.edge(t.from, to, text);
    }
    this.tails = [];
  }

  node(def: (id: string) => string): string {
    const id = this.id();
    this.out.push(`  ${def(id)}`);
    this.link(id);
    this.tails = [{ from: id, label: "" }];
    return id;
  }

  action(text: string) {
    this.node((id) => `${id}["${label(text)}"]`);
  }

  terminal(text: string) {
    this.node((id) => `${id}(["${text}"])`);
  }

  decision(cond: string): string {
    return this.node((id) => `${id}{"${label(cond)}"}`);
  }
}

function activityToMermaid(body: string): string {
  const g = new ActivityGraph();
  let direction = "TD";
  const lines = body.split("\n");
  let skipUntil: RegExp | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (skipUntil) {
      if (skipUntil.test(line)) skipUntil = null;
      continue;
    }
    if (!line || line.startsWith("'") || line.startsWith("/'")) continue;

    // Multi-line actions: `:text` continues until a terminator character.
    if (line.startsWith(":") || /^#\w+:/.test(line)) {
      line = line.replace(/^#\w+:/, ":");
      while (!/[;|<>/\]}]$/.test(line) && i + 1 < lines.length) line += "\n" + lines[++i].trim();
      g.action(line.slice(1, -1));
      continue;
    }

    let m: RegExpExecArray | null;
    if (/^(skinparam|hide|show|title|header|footer|scale|!|autonumber|label|goto|\|[^|]*\||-\[hidden\])/i.test(line) || line === "}" || /^(partition|group|rectangle|card|package)\b.*\{$/.test(line)) {
      continue;
    }
    if (/^(legend|note|floating note)\b/i.test(line)) {
      if (!/:/.test(line) || /^legend\b/i.test(line)) skipUntil = /^end\s*(legend|note)\b|^endlegend\b/i;
      continue;
    }
    if (/^left to right direction$/i.test(line)) {
      direction = "LR";
      continue;
    }
    if (/^start$/i.test(line)) {
      g.terminal("Start");
    } else if (/^(stop|end)$/i.test(line)) {
      g.terminal("Stop");
      g.tails = [];
    } else if (/^(detach|kill)$/i.test(line)) {
      g.tails = [];
    } else if ((m = /^->\s*([\s\S]*?);?$/.exec(line))) {
      g.nextLabel = m[1].trim();
    } else if ((m = /^if\s*(\([\s\S]*?\))\s*then\s*(\([\s\S]*\))?\s*$/i.exec(line)) || (m = /^if\s*(\([\s\S]*\))\s*$/i.exec(line))) {
      const d = g.decision(parenArg(m[1]));
      g.stack.push({ kind: "if", decision: d, ends: [], hasElse: false });
      g.tails = [{ from: d, label: m[2] ? parenArg(m[2]) : "" }];
    } else if ((m = /^else\s*if\s*(\([\s\S]*?\))\s*(?:then\s*(\([\s\S]*\))?)?\s*$/i.exec(line))) {
      const f = top(g, "if");
      f.ends.push(...g.tails);
      g.tails = [{ from: f.decision, label: "" }];
      f.decision = g.decision(parenArg(m[1]));
      g.tails = [{ from: f.decision, label: m[2] ? parenArg(m[2]) : "" }];
    } else if ((m = /^else\b\s*(\([\s\S]*\))?\s*$/i.exec(line))) {
      const f = top(g, "if");
      f.ends.push(...g.tails);
      f.hasElse = true;
      g.tails = [{ from: f.decision, label: m[1] ? parenArg(m[1]) : "" }];
    } else if (/^(endif|end if)$/i.test(line)) {
      const f = g.stack.pop();
      if (!f || f.kind !== "if") throw new UnsupportedPlantUml("endif without if");
      f.ends.push(...g.tails);
      if (!f.hasElse) f.ends.push({ from: f.decision, label: "" });
      g.tails = f.ends;
    } else if ((m = /^while\s*(\([\s\S]*?\))\s*(?:is\s*(\([\s\S]*\)))?\s*$/i.exec(line))) {
      const d = g.decision(parenArg(m[1]));
      g.stack.push({ kind: "while", decision: d });
      g.tails = [{ from: d, label: m[2] ? parenArg(m[2]) : "" }];
    } else if ((m = /^(?:endwhile|end while)\s*(\([\s\S]*\))?\s*$/i.exec(line))) {
      const f = g.stack.pop();
      if (!f || f.kind !== "while") throw new UnsupportedPlantUml("endwhile without while");
      g.link(f.decision);
      g.tails = [{ from: f.decision, label: m[1] ? parenArg(m[1]) : "" }];
    } else if (/^repeat$/i.test(line)) {
      const entry = g.node((id) => `${id}(( ))`);
      g.stack.push({ kind: "repeat", entry });
    } else if ((m = /^repeat\s*while\s*(\([\s\S]*?\))\s*(?:is\s*(\([\s\S]*?\)))?\s*(?:not\s*(\([\s\S]*\)))?\s*$/i.exec(line))) {
      const f = g.stack.pop();
      if (!f || f.kind !== "repeat") throw new UnsupportedPlantUml("repeat while without repeat");
      const d = g.decision(parenArg(m[1]));
      g.out.push(m[2] ? `  ${d} -->|"${label(parenArg(m[2]))}"| ${f.entry}` : `  ${d} --> ${f.entry}`);
      g.tails = [{ from: d, label: m[3] ? parenArg(m[3]) : "" }];
    } else if (/^fork$/i.test(line)) {
      const origin = g.node((id) => `${id}{{" "}}`);
      g.stack.push({ kind: "fork", origin, ends: [] });
    } else if (/^fork again$/i.test(line)) {
      const f = top(g, "fork");
      f.ends.push(...g.tails);
      g.tails = [{ from: f.origin, label: "" }];
    } else if (/^(end fork|end merge|endfork)$/i.test(line)) {
      const f = g.stack.pop();
      if (!f || f.kind !== "fork") throw new UnsupportedPlantUml("end fork without fork");
      f.ends.push(...g.tails);
      g.tails = f.ends;
      g.node((id) => `${id}{{" "}}`);
    } else {
      throw new UnsupportedPlantUml(`Unsupported PlantUML statement: ${line}`);
    }
  }
  if (g.stack.length) throw new UnsupportedPlantUml("Unterminated block in PlantUML activity diagram");
  if (!g.out.length) throw new UnsupportedPlantUml("Empty PlantUML diagram");
  return `flowchart ${direction}\n${g.out.join("\n")}`;
}

function top<K extends Frame["kind"]>(g: ActivityGraph, kind: K): Extract<Frame, { kind: K }> {
  const f = g.stack[g.stack.length - 1];
  if (!f || f.kind !== kind) throw new UnsupportedPlantUml(`Misplaced ${kind} branch`);
  return f as Extract<Frame, { kind: K }>;
}

// ---------------------------------------------------------------------------------------
// Sequence diagrams

const PARTICIPANT_KIND: Record<string, string> = { actor: "actor" };
const ARROW = /^(".+?"|[^\s"<>\-:]+)\s*(<?)(-+|\.+)(>>?x?|x|\\\\?|\/\/?|o)?(\[[^\]]*\])?\s*(".+?"|[^\s"<>\-:]+)\s*(?::\s*([\s\S]*))?$/;

function sequenceToMermaid(body: string): string {
  const out: string[] = ["sequenceDiagram"];
  const aliases = new Map<string, string>();
  const declared = new Set<string>();

  const ref = (raw: string): string => {
    const name = raw.replace(/^"|"$/g, "");
    const known = aliases.get(name);
    if (known) return known;
    const id = name.replace(/[^\w]/g, "_") || "_";
    if (!declared.has(id) && id !== name) {
      declared.add(id);
      out.push(`  participant ${id} as ${label(name)}`);
    }
    aliases.set(name, id);
    return id;
  };

  const blocks: string[] = [];

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("'")) continue;
    let m: RegExpExecArray | null;

    if (/^(skinparam|hide|show|title|header|footer|!|newpage|\.\.\.|\|\|\||={2}.*={2}$|-{2}.*-{2}$)/i.test(line)) continue;
    if (/^autonumber\b/i.test(line)) {
      out.push("  autonumber");
    } else if ((m = /^(participant|actor|boundary|control|entity|database|collections|queue)\s+(?:"([^"]+)"|(\S+))(?:\s+as\s+(?:"([^"]+)"|(\S+)))?/i.exec(line))) {
      const kw = m[1].toLowerCase();
      const first = m[2] ?? m[3];
      const second = m[4] ?? m[5];
      // `participant "Long Name" as L` vs `participant L as "Long Name"`
      const [id, text] = second && m[2] !== undefined ? [second, first] : second ? [first, second] : [first.replace(/[^\w]/g, "_") || "_", first];
      aliases.set(first, id);
      aliases.set(id, id);
      declared.add(id);
      out.push(`  ${PARTICIPANT_KIND[kw] ?? "participant"} ${id}${text !== id ? ` as ${label(text)}` : ""}`);
    } else if ((m = /^(alt|else|loop|opt|par|and|critical|break)\b\s*([\s\S]*)$/i.exec(line))) {
      const kw = m[1].toLowerCase();
      if (kw === "else" || kw === "and") out.push(`  ${kw} ${label(m[2])}`);
      else {
        blocks.push(kw);
        out.push(`  ${kw} ${label(m[2])}`);
      }
    } else if ((m = /^group\s*([\s\S]*)$/i.exec(line))) {
      blocks.push("opt");
      out.push(`  opt ${label(m[1])}`);
    } else if (/^end$/i.test(line)) {
      if (!blocks.pop()) throw new UnsupportedPlantUml("end without block");
      out.push("  end");
    } else if ((m = /^(activate|deactivate)\s+(".+?"|\S+)/i.exec(line))) {
      out.push(`  ${m[1].toLowerCase()} ${ref(m[2])}`);
    } else if (/^(note|rnote|hnote)\b/i.test(line)) {
      const n = /^(?:note|rnote|hnote)\s+(left|right|over)(?:\s+of)?\s+([^:]+?)\s*(?::\s*([\s\S]*))?$/i.exec(line);
      if (!n) throw new UnsupportedPlantUml(`Unsupported PlantUML note: ${line}`);
      if (n[3] === undefined) throw new UnsupportedPlantUml("Multi-line notes are not supported in PlantUML sequence diagrams");
      const who = n[2].split(",").map((s) => ref(s.trim())).join(",");
      out.push(`  Note ${n[1].toLowerCase()}${n[1].toLowerCase() === "over" ? "" : " of"} ${who}: ${label(n[3])}`);
    } else if ((m = ARROW.exec(line))) {
      const [, a, back, dash, head, , b, text] = m;
      const dotted = dash.length > 1;
      const lost = head?.includes("x") ?? false;
      const open = head === ">>" || head?.[0] === "\\" || head?.[0] === "/" || head === "o";
      const from = back ? ref(b) : ref(a);
      const to = back ? ref(a) : ref(b);
      const arrow = `${dotted ? "--" : "-"}${lost ? "x" : open ? ")" : ">>"}`;
      out.push(`  ${from} ${arrow} ${to}: ${label(text ?? "")}`);
    } else {
      throw new UnsupportedPlantUml(`Unsupported PlantUML statement: ${line}`);
    }
  }
  if (blocks.length) throw new UnsupportedPlantUml("Unterminated block in PlantUML sequence diagram");
  if (out.length === 1) throw new UnsupportedPlantUml("Empty PlantUML diagram");
  return out.join("\n");
}
