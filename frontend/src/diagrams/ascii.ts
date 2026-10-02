// ASCII / box-drawing diagrams → drawing primitives on a fixed character grid. Browsers fall
// back to different fonts for box-drawing and arrow glyphs, which breaks vertical joins and
// advance widths; drawing those characters as line segments and triangles keeps every
// junction exact whatever fonts are installed. Pure and DOM-free so node can test it.

export interface Seg {
  /** cell column/row of the segment's cell */
  col: number;
  row: number;
  /** directions the stroke leaves the cell centre toward */
  l: boolean;
  r: boolean;
  u: boolean;
  d: boolean;
  weight: 1 | 2;
  /** rounded corner (╭╮╯╰) */
  round: boolean;
}

export interface Arrow {
  col: number;
  row: number;
  dir: "l" | "r" | "u" | "d";
}

export interface AsciiGrid {
  cols: number;
  rows: number;
  segs: Seg[];
  arrows: Arrow[];
  /** One entry per row: the plain characters to print and their column positions. */
  text: { row: number; chars: string; cols: number[] }[];
}

const L = 1;
const R = 2;
const U = 4;
const D = 8;

// Light, heavy and double box-drawing glyphs → direction mask (weight 2 = heavy/double).
const BOX: Record<string, [number, 1 | 2]> = {};
const add = (chars: string, masks: number[], weight: 1 | 2) => {
  [...chars].forEach((c, i) => {
    BOX[c] = [masks[i], weight];
  });
};
const LIGHT_MASKS = [L | R, U | D, R | D, L | D, R | U, L | U, U | D | R, U | D | L, L | R | D, L | R | U, L | R | U | D];
add("─│┌┐└┘├┤┬┴┼", LIGHT_MASKS, 1);
add("━┃┏┓┗┛┣┫┳┻╋", LIGHT_MASKS, 2);
add("═║╔╗╚╝╠╣╦╩╬", LIGHT_MASKS, 2);
add("╭╮╰╯", [R | D, L | D, R | U, L | U], 1);
add("┄┈╌╴╶╼╾", [L | R, L | R, L | R, L, R, R, L], 1);
add("╍┅┉", [L | R, L | R, L | R], 2);
add("┆┊╎╵╷╽╿", [U | D, U | D, U | D, U, D, D, U], 1);
add("┇┋╏", [U | D, U | D, U | D], 2);

const ARROWS: Record<string, Arrow["dir"]> = {
  "▶": "r", "►": "r", "▷": "r", "▸": "r", "‣": "r",
  "◀": "l", "◄": "l", "◁": "l", "◂": "l",
  "▲": "u", "△": "u", "▴": "u",
  "▼": "d", "▽": "d", "▾": "d",
};

const ROUND = new Set([..."╭╮╰╯"]);

export function parseAscii(code: string): AsciiGrid {
  const lines = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map((l) => l.replace(/\t/g, "    ").replace(/\s+$/, ""));
  const segs: Seg[] = [];
  const arrows: Arrow[] = [];
  const text: AsciiGrid["text"] = [];
  let cols = 0;
  lines.forEach((line, row) => {
    const chars = [...line];
    cols = Math.max(cols, chars.length);
    let printed = "";
    const at: number[] = [];
    chars.forEach((ch, col) => {
      const box = BOX[ch];
      if (box) {
        const [m, weight] = box;
        segs.push({ col, row, l: (m & L) !== 0, r: (m & R) !== 0, u: (m & U) !== 0, d: (m & D) !== 0, weight, round: ROUND.has(ch) });
      } else if (ARROWS[ch]) {
        arrows.push({ col, row, dir: ARROWS[ch] });
      } else if (ch !== " ") {
        printed += ch;
        at.push(col);
      }
    });
    if (printed) text.push({ row, chars: printed, cols: at });
  });
  return { cols, rows: lines.length, segs, arrows, text };
}
