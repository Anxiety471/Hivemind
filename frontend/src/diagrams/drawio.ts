// draw.io / diagrams.net (mxGraph XML) → renderable scene. Pure and DOM-free: a small XML
// reader, the mxCell model, shape/edge geometry and arrowheads all live here so node can test
// them; DrawioSvg.tsx only maps the resulting scene to SVG elements.
//
// Supported: <mxfile> (plain or deflate+base64 compressed diagrams) and bare <mxGraphModel>;
// rect / rounded / ellipse / rhombus / triangle / hexagon / parallelogram / cylinder / text /
// swimlane shapes (everything else falls back to a rectangle); straight, orthogonal and
// waypoint edges with exit/entry constraints; arrowheads; HTML labels; nested containers.

// ---------------------------------------------------------------------------------------
// Minimal XML reader

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cur = stack[stack.length - 1];
    if (m[1] !== undefined) cur.text += m[1];
    else if (m[6] !== undefined) cur.text += decodeEntities(m[6]);
    else if (m[3] !== undefined) {
      if (m[2]) {
        if (stack.length < 2 || cur.name !== m[3]) throw new Error(`Malformed XML: unexpected </${m[3]}>`);
        stack.pop();
      } else {
        const attrs: Record<string, string> = {};
        for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
        const node: XmlNode = { name: m[3], attrs, children: [], text: "" };
        cur.children.push(node);
        if (!m[5]) stack.push(node);
      }
    } else if (m[0].startsWith("<") && !m[0].startsWith("<!--") && !m[0].startsWith("<?") && !m[0].startsWith("<!")) {
      throw new Error("Malformed XML");
    }
  }
  if (stack.length !== 1) throw new Error(`Malformed XML: <${stack[stack.length - 1].name}> is not closed`);
  const first = root.children[0];
  if (!first) throw new Error("Empty XML document");
  return first;
}

// ---------------------------------------------------------------------------------------
// mxGraphModel extraction (including compressed <diagram> payloads)

/** draw.io stores diagrams as base64(raw-deflate(encodeURIComponent(xml))) unless exported uncompressed. */
async function inflateDiagram(b64: string): Promise<string> {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const text = await new Response(stream).text();
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export async function findGraphModel(xml: string, page = 0): Promise<XmlNode> {
  const root = parseXml(xml);
  if (root.name === "mxGraphModel") return root;
  if (root.name !== "mxfile" && root.name !== "diagram") throw new Error("Not a draw.io document (expected <mxfile> or <mxGraphModel>)");
  const diagrams = root.name === "diagram" ? [root] : root.children.filter((c) => c.name === "diagram");
  const d = diagrams[Math.min(page, diagrams.length - 1)];
  if (!d) throw new Error("draw.io file contains no <diagram>");
  const model = d.children.find((c) => c.name === "mxGraphModel");
  if (model) return model;
  const payload = d.text.trim();
  if (!payload) throw new Error("draw.io <diagram> is empty");
  const inner = payload.startsWith("<") ? payload : await inflateDiagram(payload);
  const parsed = parseXml(inner);
  if (parsed.name !== "mxGraphModel") throw new Error("draw.io <diagram> does not contain an mxGraphModel");
  return parsed;
}

// ---------------------------------------------------------------------------------------
// Cell model

export interface Pt {
  x: number;
  y: number;
}

interface Cell {
  id: string;
  value: string;
  style: Record<string, string>;
  vertex: boolean;
  edge: boolean;
  parent: string;
  source: string;
  target: string;
  hidden: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  relative: boolean;
  points: Pt[];
  sourcePoint: Pt | null;
  targetPoint: Pt | null;
}

export function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? "").split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq < 0) out[s] = "";
    else out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

function readCells(model: XmlNode): Cell[] {
  const rootEl = model.children.find((c) => c.name === "root");
  if (!rootEl) throw new Error("mxGraphModel has no <root>");
  const cells: Cell[] = [];
  // <object>/<UserObject> wrap an <mxCell>, supplying id and label (`label` attr).
  for (const el of rootEl.children) {
    let cellEl = el;
    let id = el.attrs.id ?? "";
    let value = el.attrs.value ?? "";
    if (el.name === "object" || el.name === "UserObject") {
      cellEl = el.children.find((c) => c.name === "mxCell") ?? el;
      value = el.attrs.label ?? el.attrs.value ?? "";
    } else if (el.name !== "mxCell") continue;
    const a = cellEl.attrs;
    id = id || a.id || "";
    const geo = cellEl.children.find((c) => c.name === "mxGeometry");
    const pt = (n: XmlNode | undefined): Pt | null => (n ? { x: num(n.attrs.x, 0), y: num(n.attrs.y, 0) } : null);
    const arr = geo?.children.find((c) => c.name === "Array" && c.attrs.as === "points");
    cells.push({
      id,
      value: a.value ?? value,
      style: parseStyle(a.style),
      vertex: a.vertex === "1",
      edge: a.edge === "1",
      parent: a.parent ?? "",
      source: a.source ?? "",
      target: a.target ?? "",
      hidden: a.visible === "0",
      x: num(geo?.attrs.x, 0),
      y: num(geo?.attrs.y, 0),
      w: num(geo?.attrs.width, 0),
      h: num(geo?.attrs.height, 0),
      relative: geo?.attrs.relative === "1",
      points: (arr?.children.filter((c) => c.name === "mxPoint") ?? []).map((p) => pt(p)!),
      sourcePoint: pt(geo?.children.find((c) => c.name === "mxPoint" && c.attrs.as === "sourcePoint")),
      targetPoint: pt(geo?.children.find((c) => c.name === "mxPoint" && c.attrs.as === "targetPoint")),
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------------------
// Scene

export type ShapeKind = "rect" | "ellipse" | "rhombus" | "triangle" | "hexagon" | "parallelogram" | "cylinder" | "text" | "swimlane";

export interface TextSpec {
  lines: string[];
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  baseline: "top" | "middle" | "bottom";
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  background?: string;
}

export interface SceneShape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  dashed: boolean;
  opacity: number;
  radius: number;
  startSize: number;
  text: TextSpec | null;
}

export interface SceneEdge {
  id: string;
  points: Pt[];
  stroke: string;
  strokeWidth: number;
  dashed: boolean;
  curved: boolean;
  rounded: boolean;
  /** Filled/outlined arrowhead polygons or ovals, already positioned. */
  heads: ArrowHead[];
  text: TextSpec | null;
}

export interface ArrowHead {
  kind: "polygon" | "oval" | "line";
  points: Pt[];
  /** oval centre/radius */
  c?: Pt;
  r?: number;
  filled: boolean;
}

export interface Scene {
  width: number;
  height: number;
  minX: number;
  minY: number;
  shapes: SceneShape[];
  edges: SceneEdge[];
}

const CHAR_W = 0.56;

function color(v: string | undefined, fallback: string): string {
  if (!v || v === "default") return fallback;
  const ld = /^light-dark\(\s*([^,]+?)\s*(?:,|\))/.exec(v);
  const c = ld ? ld[1] : v;
  return /^[#\w(),.%\s-]+$/.test(c) ? c : fallback;
}

/** draw.io HTML label → plain lines. */
export function labelLines(value: string, html: boolean): string[] {
  let s = value;
  if (html) {
    s = s
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h\d|tr)>/gi, "\n")
      .replace(/<(div|p|li|h\d|tr)[^>]*>/gi, "\n");
    // One pass can leave a tag behind (`<scr<b>ipt>` -> `<script>`), so strip until nothing changes.
    for (let prev = ""; prev !== s; ) {
      prev = s;
      s = s.replace(/<[^>]*>/g, "");
    }
    s = decodeEntities(s);
  }
  return s.replace(/^\n+|\n+$/g, "").split("\n");
}

function wrapLines(lines: string[], maxWidth: number, size: number): string[] {
  const perLine = Math.max(1, Math.floor(maxWidth / (size * CHAR_W)));
  const out: string[] = [];
  for (const line of lines) {
    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const w of words) {
      if (cur && (cur + " " + w).length > perLine) {
        out.push(cur);
        cur = w;
      } else cur = cur ? cur + " " + w : w;
    }
    out.push(cur);
  }
  return out;
}

function buildText(c: Cell, box: { x: number; y: number; w: number; h: number }, opts: { wrapDefault: boolean; kind: ShapeKind }): TextSpec | null {
  if (!c.value) return null;
  const html = c.style.html === "1";
  const size = num(c.style.fontSize, 12);
  let lines = labelLines(c.value, html);
  if (!lines.some((l) => l.trim())) return null;
  const wrap = c.style.whiteSpace === "wrap" || (opts.wrapDefault && html);
  if (wrap && box.w > 0) lines = wrapLines(lines, Math.max(box.w - 10, size), size);
  const align = c.style.align ?? "center";
  const vAlign = c.style.verticalAlign ?? "middle";
  const fs = num(c.style.fontStyle, 0);
  const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const pad = 5;
  const x = anchor === "start" ? box.x + pad : anchor === "end" ? box.x + box.w - pad : box.x + box.w / 2;
  let baseline: TextSpec["baseline"] = vAlign === "top" ? "top" : vAlign === "bottom" ? "bottom" : "middle";
  let y = baseline === "top" ? box.y + pad : baseline === "bottom" ? box.y + box.h - pad : box.y + box.h / 2;
  if (opts.kind === "swimlane") {
    baseline = "middle";
    y = box.y + num(c.style.startSize, 23) / 2;
  }
  return {
    lines,
    x,
    y,
    anchor,
    baseline,
    size,
    color: color(c.style.fontColor, "#000000"),
    bold: (fs & 1) !== 0,
    italic: (fs & 2) !== 0,
    underline: (fs & 4) !== 0,
  };
}

function shapeKind(style: Record<string, string>): ShapeKind {
  const shape = style.shape ?? "";
  if ("ellipse" in style || shape === "ellipse" || shape === "doubleEllipse") return "ellipse";
  if ("rhombus" in style || shape === "rhombus") return "rhombus";
  if ("triangle" in style || shape === "triangle") return "triangle";
  if ("hexagon" in style || shape === "hexagon") return "hexagon";
  if ("parallelogram" in style || shape === "parallelogram") return "parallelogram";
  if (/^cylinder/.test(shape) || "cylinder" in style) return "cylinder";
  if ("swimlane" in style || shape === "swimlane") return "swimlane";
  if ("text" in style || shape === "text") return "text";
  return "rect";
}

// Geometry helpers ---------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: ShapeKind;
}

const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Point on the shape outline along the ray from its centre toward `to`. */
function boundary(b: Box, to: Pt): Pt {
  const c = centre(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = b.w / 2 || 1;
  const hh = b.h / 2 || 1;
  let t: number;
  if (b.kind === "ellipse") t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (b.kind === "rhombus") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

type Side = "left" | "right" | "top" | "bottom";

function sideOf(constraintX: number | undefined, constraintY: number | undefined): Side | null {
  if (constraintX === undefined && constraintY === undefined) return null;
  const x = constraintX ?? 0.5;
  const y = constraintY ?? 0.5;
  if (y <= 0) return "top";
  if (y >= 1) return "bottom";
  if (x <= 0) return "left";
  if (x >= 1) return "right";
  return null;
}

function sidePoint(b: Box, side: Side): Pt {
  switch (side) {
    case "left":
      return { x: b.x, y: b.y + b.h / 2 };
    case "right":
      return { x: b.x + b.w, y: b.y + b.h / 2 };
    case "top":
      return { x: b.x + b.w / 2, y: b.y };
    case "bottom":
      return { x: b.x + b.w / 2, y: b.y + b.h };
  }
}

const vertical = (s: Side) => s === "top" || s === "bottom";

function facing(a: Box, b: Box): [Side, Side] {
  const ca = centre(a);
  const cb = centre(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  return dx >= 0 ? ["right", "left"] : ["left", "right"];
}

function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const collinearX = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01;
    const collinearY = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01;
    if (collinearX || collinearY) out.splice(i, 1);
  }
  return out;
}

function orthogonal(s: Pt, ss: Side, e: Pt, es: Side): Pt[] {
  if (vertical(ss) && vertical(es)) {
    const my = (s.y + e.y) / 2;
    return [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
  }
  if (!vertical(ss) && !vertical(es)) {
    const mx = (s.x + e.x) / 2;
    return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
  }
  return vertical(ss) ? [s, { x: s.x, y: e.y }, e] : [s, { x: e.x, y: s.y }, e];
}

function squareOff(pts: Pt[], firstVertical: boolean): Pt[] {
  const out: Pt[] = [pts[0]];
  let vert = firstVertical;
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1];
    const q = pts[i];
    if (Math.abs(p.x - q.x) > 0.01 && Math.abs(p.y - q.y) > 0.01) {
      out.push(vert ? { x: p.x, y: q.y } : { x: q.x, y: p.y });
      vert = !vert;
    }
    out.push(q);
  }
  return out;
}

function pointAlong(pts: Pt[], frac: number): { p: Pt; normal: Pt } {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    lens.push(l);
    total += l;
  }
  let want = total * Math.min(1, Math.max(0, frac));
  for (let i = 0; i < lens.length; i++) {
    if (want <= lens[i] || i === lens.length - 1) {
      const t = lens[i] ? Math.min(1, want / lens[i]) : 0;
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = lens[i] || 1;
      return { p: { x: a.x + dx * t, y: a.y + dy * t }, normal: { x: -dy / l, y: dx / l } };
    }
    want -= lens[i];
  }
  return { p: pts[0], normal: { x: 0, y: 1 } };
}

// Arrowheads ---------------------------------------------------------------------------

function arrowHead(kind: string, filledFlag: string | undefined, tip: Pt, from: Pt, sw: number, size: number): { head: ArrowHead | null; trim: number } {
  if (!kind || kind === "none") return { head: null, trim: 0 };
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const L = Math.max(size, 6) + sw;
  const W = L * 0.5;
  const base = { x: tip.x - ux * L, y: tip.y - uy * L };
  const left = { x: base.x - uy * W, y: base.y + ux * W };
  const right = { x: base.x + uy * W, y: base.y - ux * W };
  const filled = filledFlag !== "0";
  switch (kind) {
    case "open":
    case "openThin":
      return { head: { kind: "line", points: [left, tip, right], filled: false }, trim: 0 };
    case "oval": {
      const r = L / 2;
      return { head: { kind: "oval", points: [], c: { x: tip.x - ux * r, y: tip.y - uy * r }, r, filled }, trim: L };
    }
    case "diamond":
    case "diamondThin": {
      const mid = { x: tip.x - ux * L, y: tip.y - uy * L };
      const back = { x: tip.x - ux * 2 * L, y: tip.y - uy * 2 * L };
      const l = { x: mid.x - uy * W, y: mid.y + ux * W };
      const r = { x: mid.x + uy * W, y: mid.y - ux * W };
      return { head: { kind: "polygon", points: [tip, l, back, r], filled }, trim: 2 * L };
    }
    case "block":
    case "blockThin":
      return { head: { kind: "polygon", points: [tip, left, right], filled }, trim: L };
    default: {
      // classic (draw.io default): notched arrow
      const notch = { x: tip.x - ux * L * 0.75, y: tip.y - uy * L * 0.75 };
      return { head: { kind: "polygon", points: [tip, left, notch, right], filled }, trim: L * 0.75 };
    }
  }
}

function retract(pts: Pt[], endIndex: "start" | "end", by: number): Pt[] {
  if (!by || pts.length < 2) return pts;
  const out = pts.slice();
  const i = endIndex === "end" ? out.length - 1 : 0;
  const j = endIndex === "end" ? i - 1 : 1;
  const dx = out[i].x - out[j].x;
  const dy = out[i].y - out[j].y;
  const len = Math.hypot(dx, dy);
  if (len <= by) return out;
  out[i] = { x: out[i].x - (dx / len) * by, y: out[i].y - (dy / len) * by };
  return out;
}

// Scene construction -------------------------------------------------------------------

export function buildScene(model: XmlNode): Scene {
  const cells = readCells(model);
  const byId: Record<string, Cell> = {};
  for (const c of cells) byId[c.id] = c;

  const isHidden = (c: Cell): boolean => {
    for (let cur: Cell | undefined = c, guard = 0; cur && guard < 64; cur = byId[cur.parent], guard++) if (cur.hidden) return true;
    return false;
  };

  // Absolute boxes. Children of vertices are positioned relative to their parent's origin.
  const boxes: Record<string, Box> = {};
  const absBox = (c: Cell, depth = 0): Box => {
    const cached = boxes[c.id];
    if (cached) return cached;
    let ox = 0;
    let oy = 0;
    const p = byId[c.parent];
    if (p && p.vertex && depth < 64) {
      const pb = absBox(p, depth + 1);
      ox = pb.x;
      oy = pb.y;
    }
    const kind = shapeKind(c.style);
    const b: Box = { x: ox + c.x, y: oy + c.y, w: c.w, h: c.h, kind };
    boxes[c.id] = b;
    return b;
  };

  const shapes: SceneShape[] = [];
  const edges: SceneEdge[] = [];
  const edgeLabelCells: Cell[] = [];

  // Draw order = document order (parents precede children in draw.io output).
  for (const c of cells) {
    if (!c.vertex || isHidden(c)) continue;
    if (byId[c.parent]?.edge) {
      edgeLabelCells.push(c);
      continue;
    }
    const b = absBox(c);
    const kind = b.kind;
    const noFill = kind === "text" || c.style.fillColor === "none";
    const noStroke = kind === "text" || c.style.strokeColor === "none";
    shapes.push({
      id: c.id,
      kind,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      fill: noFill ? "none" : color(c.style.fillColor, "#ffffff"),
      stroke: noStroke ? "none" : color(c.style.strokeColor, "#000000"),
      strokeWidth: num(c.style.strokeWidth, 1),
      dashed: c.style.dashed === "1",
      opacity: num(c.style.opacity, 100) / 100,
      radius: c.style.rounded === "1" ? Math.min(b.w, b.h) * (num(c.style.arcSize, 15) / 100) : 0,
      startSize: num(c.style.startSize, 23),
      text: buildText(c, b, { wrapDefault: kind !== "text", kind }),
    });
  }

  for (const c of cells) {
    if (!c.edge || isHidden(c)) continue;
    const src = byId[c.source];
    const dst = byId[c.target];
    const sb = src && src.vertex ? absBox(src) : null;
    const tb = dst && dst.vertex ? absBox(dst) : null;
    const wps = c.points.slice();
    const ortho = /orthogonal|elbow/i.test(c.style.edgeStyle ?? "");

    const exitSide = sb ? sideOf(c.style.exitX === undefined ? undefined : num(c.style.exitX, 0.5), c.style.exitY === undefined ? undefined : num(c.style.exitY, 0.5)) : null;
    const entrySide = tb ? sideOf(c.style.entryX === undefined ? undefined : num(c.style.entryX, 0.5), c.style.entryY === undefined ? undefined : num(c.style.entryY, 0.5)) : null;

    let pts: Pt[];
    if (ortho && wps.length === 0 && sb && tb) {
      const [fs, ft] = facing(sb, tb);
      // Target beside the source and not level with it: leave sideways, enter from above/below (an L).
      const sc = centre(sb);
      const beside = tb.x + tb.w < sb.x || tb.x > sb.x + sb.w;
      const level = sc.y >= tb.y && sc.y <= tb.y + tb.h;
      const ss = exitSide ?? (beside && !level ? (tb.x > sb.x ? "right" : "left") : fs);
      const es = entrySide ?? (beside && !level && !exitSide ? (tb.y > sc.y ? "top" : "bottom") : ft);
      pts = orthogonal(sidePoint(sb, ss), ss, sidePoint(tb, es), es);
    } else {
      const first = wps[0] ?? (tb ? centre(tb) : c.targetPoint ?? { x: 0, y: 0 });
      const last = wps[wps.length - 1] ?? (sb ? centre(sb) : c.sourcePoint ?? { x: 0, y: 0 });
      const start = sb ? (exitSide ? sidePoint(sb, exitSide) : boundary(sb, first)) : c.sourcePoint ?? first;
      const end = tb ? (entrySide ? sidePoint(tb, entrySide) : boundary(tb, last)) : c.targetPoint ?? last;
      pts = [start, ...wps, end];
      if (ortho) pts = squareOff(pts, exitSide ? vertical(exitSide) : Math.abs(pts[1].y - pts[0].y) >= Math.abs(pts[1].x - pts[0].x));
    }
    pts = simplify(pts);
    if (pts.length < 2) continue;

    const sw = num(c.style.strokeWidth, 1);
    const size = num(c.style.endSize, 6);
    const stroke = color(c.style.strokeColor, "#000000");
    const endKind = "endArrow" in c.style ? c.style.endArrow : "classic";
    const startKind = "startArrow" in c.style ? c.style.startArrow : "none";
    const end = arrowHead(endKind, c.style.endFill, pts[pts.length - 1], pts[pts.length - 2], sw, size);
    const start = arrowHead(startKind, c.style.startFill, pts[0], pts[1], sw, num(c.style.startSize, 6));
    const line = retract(retract(pts, "end", end.trim), "start", start.trim);
    const heads = [end.head, start.head].filter((h): h is ArrowHead => h !== null);

    let text: TextSpec | null = null;
    if (c.value) {
      const mid = pointAlong(pts, 0.5).p;
      text = buildText(c, { x: mid.x, y: mid.y, w: 0, h: 0 }, { wrapDefault: false, kind: "text" });
      if (text) {
        text.anchor = "middle";
        text.baseline = "middle";
        text.background = "#ffffff";
      }
    }
    edges.push({ id: c.id, points: line, stroke, strokeWidth: sw, dashed: c.style.dashed === "1", curved: c.style.curved === "1", rounded: c.style.rounded === "1", heads, text });
  }

  // Labels attached to edges: geometry x ∈ [-1, 1] runs along the edge, y is the perpendicular offset.
  for (const c of edgeLabelCells) {
    const edge = edges.find((e) => e.id === c.parent);
    if (!edge || !c.value) continue;
    const { p, normal } = pointAlong(edge.points, (c.x + 1) / 2);
    const text = buildText(c, { x: p.x + normal.x * c.y, y: p.y + normal.y * c.y, w: 0, h: 0 }, { wrapDefault: false, kind: "text" });
    if (!text) continue;
    text.anchor = "middle";
    text.baseline = "middle";
    if (!edge.text) edge.text = text;
    else edge.text.lines.push(...text.lines);
  }

  // Bounds ---------------------------------------------------------------------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const s of shapes) {
    grow(s.x, s.y);
    grow(s.x + s.w, s.y + s.h);
  }
  for (const e of edges) {
    for (const p of e.points) grow(p.x, p.y);
    for (const h of e.heads) {
      for (const p of h.points) grow(p.x, p.y);
      if (h.c && h.r) {
        grow(h.c.x - h.r, h.c.y - h.r);
        grow(h.c.x + h.r, h.c.y + h.r);
      }
    }
    if (e.text) grow(e.text.x, e.text.y);
  }
  if (!Number.isFinite(minX)) throw new Error("draw.io diagram has no visible shapes");
  const pad = 20;
  return { minX: minX - pad, minY: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2, shapes, edges };
}

export async function drawioToScene(xml: string): Promise<Scene> {
  return buildScene(await findGraphModel(xml));
}

/** True when a code block's content is a draw.io document. */
export function looksLikeDrawio(code: string): boolean {
  return /^\s*(<\?xml[^>]*\?>\s*)?<(mxfile|mxGraphModel)\b/.test(code);
}
