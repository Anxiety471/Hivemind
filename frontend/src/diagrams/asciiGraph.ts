// Conservative, grid-based ASCII → SVG scene conversion. Unsupported/ambiguous
// drawings stay as source rather than guessing connections or losing labels.
export type Point = { x: number; y: number };
export type AsciiNode = { id: string; label: string; x: number; y: number; w: number; h: number };
export type AsciiEdge = { id: string; from: string; to: string; points: Point[]; directed: boolean; both: boolean };
export type AsciiGraph = { nodes: AsciiNode[]; edges: AsciiEdge[]; width: number; height: number };
type CellNode = AsciiNode & { col: number; row: number; cols: number; rows: number };
type Contact = { node: string; vertex: number; point: Point; target: boolean };
const W = 12, H = 24, PAD = 24;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const HORIZONTAL = new Set("-─━═=<>→←↔");
const VERTICAL = new Set("|│┃║^v↑↓↕");
const JUNCTIONS = new Set("+┬┴├┤┼┌┐└┘┏┓┗┛╔╗╚╝╠╣╦╩╬");
const HEADS: Record<string, number> = { ">": 0, "→": 0, "<": 1, "←": 1, v: 2, "↓": 2, "^": 3, "↑": 3 };
const isHead = (char: string) => HEADS[char] !== undefined || char === "↔" || char === "↕";
const pointsTo = (char: string, direction: number) => HEADS[char] === direction || (char === "↔" && direction < 2) || (char === "↕" && direction >= 2);
const CORNERS: Record<string, number[]> = {
  "┌": [0, 2], "┏": [0, 2], "╔": [0, 2], "┐": [1, 2], "┓": [1, 2], "╗": [1, 2],
  "└": [0, 3], "┗": [0, 3], "╚": [0, 3], "┘": [1, 3], "┛": [1, 3], "╝": [1, 3],
  "┬": [0, 1, 2], "╦": [0, 1, 2], "┴": [0, 1, 3], "╩": [0, 1, 3],
  "├": [0, 2, 3], "╠": [0, 2, 3], "┤": [1, 2, 3], "╣": [1, 2, 3],
};
const allows = (char: string, direction: number) => CORNERS[char]?.includes(direction) ?? (JUNCTIONS.has(char) || (direction < 2 ? HORIZONTAL : VERTICAL).has(char));
const point = (col: number, row: number): Point => ({ x: PAD + (col + .5) * W, y: PAD + (row + .5) * H });

function simplify(points: Point[]): Point[] {
  return points.filter((p, i) => {
    const a = points[i - 1], b = points[i + 1];
    return !a || !b || !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

type ArrowToken = { index: number; text: string };
const SHAFT = new Set("-=─═");
const HORIZONTAL_HEADS = new Set("→←↔");

// Scan diagram punctuation, not HTML. Offsets use UTF-16 for string slicing;
// the graph parser converts these offsets to codepoint grid coordinates.
export function horizontalAsciiArrows(text: string): ArrowToken[] {
  const arrows: ArrowToken[] = [];
  for (let index = 0; index < text.length;) {
    const start = index;
    const left = text[index] === "<";
    if (HORIZONTAL_HEADS.has(text[index])) {
      arrows.push({ index, text: text[index++] });
      continue;
    }
    if (left) index++;
    const shaftStart = index;
    while (SHAFT.has(text[index])) index++;
    const hasShaft = index > shaftStart;
    const right = text[index] === ">";
    if (hasShaft && (left || right)) {
      if (right) index++;
      arrows.push({ index: start, text: text.slice(start, index) });
    } else {
      index = Math.max(index, start + 1);
    }
  }
  return arrows;
}

export function hasAsciiArrow(text: string): boolean {
  return horizontalAsciiArrows(text).length > 0 || [...text].some((char) => "↑↓↕".includes(char));
}

export function asciiToGraph(source: string): AsciiGraph | null {
  if (source.length > 20_000 || source.includes("\t")) return null;
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map((line) => Array.from(line));
  const cols = Math.max(1, ...lines.map((line) => line.length));
  if (lines.length > 200 || cols > 300 || cols * lines.length > 30_000) return null;
  const at = (col: number, row: number) => lines[row]?.[col] ?? " ";
  const key = (col: number, row: number) => row * cols + col;
  const occupied = new Map<number, CellNode>();
  const nodes: CellNode[] = [];
  const addNode = (col: number, row: number, width: number, height: number, label: string) => {
    if (!label.trim() || nodes.length >= 100) return false;
    for (let y = row; y < row + height; y++) for (let x = col; x < col + width; x++) if (occupied.has(key(x, y))) return false;
    const node: CellNode = { id: `n${nodes.length}`, label: label.trim(), col, row, cols: width, rows: height,
      x: PAD + col * W, y: PAD + row * H, w: width * W, h: height * H };
    nodes.push(node);
    for (let y = row; y < row + height; y++) for (let x = col; x < col + width; x++) occupied.set(key(x, y), node);
    return true;
  };

  // Multiline ASCII and Unicode boxes: require complete matching borders.
  for (let y = 0; y < lines.length; y++) {
    // Indices must be codepoint offsets, including labels containing emoji.
    for (let x = 0; x < cols; x++) {
      if (occupied.has(key(x, y)) || !["+", "┌", "╔"].includes(at(x, y))) continue;
      const topLeft = at(x, y), topRight = topLeft === "+" ? "+" : topLeft === "┌" ? "┐" : "╗";
      const bottomLeft = topLeft === "+" ? "+" : topLeft === "┌" ? "└" : "╚";
      const bottomRight = topLeft === "+" ? "+" : topLeft === "┌" ? "┘" : "╝";
      const side = topLeft === "+" ? "|" : topLeft === "┌" ? "│" : "║";
      let end = x + 1;
      while (end < cols && "-─═=".includes(at(end, y))) end++;
      if (end <= x + 1 || at(end, y) !== topRight) continue;
      for (let bottom = y + 1; bottom < lines.length; bottom++) {
        if (at(x, bottom) === bottomLeft && at(end, bottom) === bottomRight &&
            lines[bottom].slice(x + 1, end).every((c) => "-─═=".includes(c))) {
          const label = lines.slice(y + 1, bottom).map((r) => r.slice(x + 1, end).join("").trim()).join("\n");
          addNode(x, y, end - x + 1, bottom - y + 1, label);
          break;
        }
        if (at(x, bottom) !== side || at(end, bottom) !== side) break;
      }
    }
  }

  // [Node] notation and bare labels in explicit horizontal arrow chains.
  for (let y = 0; y < lines.length; y++) {
    for (let x = 0; x < cols; x++) {
      if (at(x, y) !== "[" || occupied.has(key(x, y))) continue;
      let end = x + 1;
      while (end < cols && !["[", "]"].includes(at(end, y))) end++;
      if (at(end, y) === "]") addNode(x, y, end - x + 1, 1, lines[y].slice(x + 1, end).join(""));
    }
    const text = lines[y].map((c, x) => occupied.has(key(x, y)) ? " " : c).join("");
    const arrows = horizontalAsciiArrows(text);
    if (!arrows.length) continue;
    let start = 0;
    for (const arrow of [...arrows, { index: text.length, text: "" }]) {
      const end = arrow.index;
      const segment = text.slice(start, end);
      const label = segment.trim();
      if (label && !/[+|│─<>^\[\]┌┐└┘]/.test(label)) {
        // Token offsets are UTF-16; convert them to the grid's codepoint offsets.
        const leading = segment.length - segment.trimStart().length;
        const col = Array.from(text.slice(0, start + leading)).length;
        addNode(col, y, Array.from(label).length, 1, label);
      }
      start = end + arrow.text.length;
    }
  }
  if (!nodes.length) return null;

  const vertices = new Map<number, string>();
  for (let y = 0; y < lines.length; y++) for (let x = 0; x < lines[y].length; x++) {
    const char = at(x, y);
    if (occupied.has(key(x, y)) || /\s/.test(char)) continue;
    if (!HORIZONTAL.has(char) && !VERTICAL.has(char) && !JUNCTIONS.has(char)) return null;
    vertices.set(key(x, y), char);
  }
  const adjacency = new Map<number, number[]>();
  const contacts: Contact[] = [];
  for (const [id, char] of vertices) {
    const y = Math.floor(id / cols), x = id % cols;
    const neighbours: number[] = [];
    for (let direction = 0; direction < 4; direction++) {
      if (!allows(char, direction)) continue;
      const [dx, dy] = DIRS[direction];
      let col = x + dx, row = y + dy;
      while (col >= 0 && col < cols && row >= 0 && row < lines.length && at(col, row) === " " && !occupied.has(key(col, row))) { col += dx; row += dy; }
      if (col < 0 || col >= cols || row < 0 || row >= lines.length) continue;
      const node = occupied.get(key(col, row));
      if (node) {
        const p = point(col, row);
        if (direction === 0) p.x = node.x;
        if (direction === 1) p.x = node.x + node.w;
        if (direction === 2) p.y = node.y;
        if (direction === 3) p.y = node.y + node.h;
        contacts.push({ node: node.id, vertex: id, point: p, target: pointsTo(char, direction) });
      } else {
        const next = key(col, row), other = vertices.get(next);
        if (other && allows(other, direction ^ 1)) neighbours.push(next);
      }
    }
    adjacency.set(id, neighbours);
  }

  const visited = new Set<number>();
  const edges: AsciiEdge[] = [];
  const connectedNodes = new Set<string>();
  for (const start of vertices.keys()) {
    if (visited.has(start)) continue;
    const component = new Set<number>([start]);
    const queue = [start]; visited.add(start);
    for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]) ?? []) {
      if (!visited.has(next)) { visited.add(next); component.add(next); queue.push(next); }
    }
    const ends = contacts.filter((c) => component.has(c.vertex));
    const ids = [...new Set(ends.map((c) => c.node))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    if (ids.length < 2) return null; // Do not silently drop unconnected drawing marks.
    const targets = [...new Set(ends.filter((c) => c.target).map((c) => c.node))];
    const heads = queue.filter((id) => isHead(vertices.get(id)!));
    if (heads.some((id) => !ends.some((c) => c.vertex === id && c.target))) return null;
    const sources = ids.filter((id) => !targets.includes(id));
    const pairs: [string, string][] = ids.length === 2
      ? [[targets.length === 1 ? sources[0] : ids[0], targets.length === 1 ? targets[0] : ids[1]]]
      : sources.length === 1 && targets.length === ids.length - 1 ? targets.map((id) => [sources[0], id]) : [];
    if (!pairs.length) return null; // Ambiguous crossing/many-to-many junction.
    for (const [from, to] of pairs) {
      const initial = ends.filter((c) => c.node === from);
      const goals = ends.filter((c) => c.node === to && (!targets.includes(to) || c.target));
      const paths = initial.map((entry) => {
        const prev = new Map<number, number | null>([[entry.vertex, null]]);
        const q = [entry.vertex];
        let goal: Contact | undefined;
        for (let i = 0; i < q.length; i++) {
          goal = goals.find((c) => c.vertex === q[i]);
          if (goal) break;
          for (const next of adjacency.get(q[i]) ?? []) if (!prev.has(next)) { prev.set(next, q[i]); q.push(next); }
        }
        if (!goal) return null;
        const route: number[] = [];
        for (let id: number | null = goal.vertex; id !== null; id = prev.get(id) ?? null) route.push(id);
        route.reverse();
        return [entry.point, ...route.map((id) => point(id % cols, Math.floor(id / cols))), goal.point];
      }).filter((p): p is Point[] => p !== null).sort((a, b) => a.length - b.length);
      if (!paths.length || edges.length >= 200) return null;
      edges.push({ id: `e${edges.length}`, from, to, points: simplify(paths[0]), directed: targets.length > 0, both: targets.length === 2 && ids.length === 2 });
      connectedNodes.add(from); connectedNodes.add(to);
    }
  }
  if (!edges.length || nodes.some((n) => !connectedNodes.has(n.id))) return null;
  return { nodes, edges, width: cols * W + PAD * 2, height: lines.length * H + PAD * 2 };
}
