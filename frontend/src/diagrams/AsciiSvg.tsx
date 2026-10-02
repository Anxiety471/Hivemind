// SVG view of an ASCII diagram grid (see ascii.ts): box-drawing characters become strokes,
// arrow glyphs become triangles, everything else stays text pinned to its grid column.
import type { ReactNode } from "react";
import { parseAscii } from "./ascii";
import type { Seg } from "./ascii";

const SIZE = 13;
const CW = SIZE * 0.602;
const CH = SIZE * 1.35;
const PAD = 8;

function segPath(s: Seg): string {
  const cx = PAD + (s.col + 0.5) * CW;
  const cy = PAD + (s.row + 0.5) * CH;
  const x0 = cx - CW / 2;
  const x1 = cx + CW / 2;
  const y0 = cy - CH / 2;
  const y1 = cy + CH / 2;
  if (s.round) {
    const ex = s.l ? x0 : x1;
    const ey = s.u ? y0 : y1;
    return `M${ex},${cy} Q${cx},${cy} ${cx},${ey}`;
  }
  let d = "";
  if (s.l) d += `M${x0},${cy}H${cx}`;
  if (s.r) d += `M${cx},${cy}H${x1}`;
  if (s.u) d += `M${cx},${y0}V${cy}`;
  if (s.d) d += `M${cx},${cy}V${y1}`;
  return d;
}

function arrowPoints(col: number, row: number, dir: "l" | "r" | "u" | "d"): string {
  const cx = PAD + (col + 0.5) * CW;
  const cy = PAD + (row + 0.5) * CH;
  const a = CW * 0.5;
  const b = CH * 0.32;
  switch (dir) {
    case "r":
      return `${cx - a},${cy - b} ${cx + a},${cy} ${cx - a},${cy + b}`;
    case "l":
      return `${cx + a},${cy - b} ${cx - a},${cy} ${cx + a},${cy + b}`;
    case "u":
      return `${cx - a},${cy + b} ${cx},${cy - b} ${cx + a},${cy + b}`;
    case "d":
      return `${cx - a},${cy - b} ${cx},${cy + b} ${cx + a},${cy - b}`;
  }
}

export function AsciiSvg({ code }: { code: string }): ReactNode {
  const g = parseAscii(code);
  const width = PAD * 2 + g.cols * CW;
  const height = PAD * 2 + g.rows * CH;
  return (
    <svg className="ascii-svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="ASCII diagram" fill="currentColor">
      <g fill="none" stroke="currentColor" strokeLinecap="butt">
        {g.segs.map((s, i) => (
          <path key={i} d={segPath(s)} strokeWidth={s.weight === 2 ? 2.4 : 1.1} />
        ))}
      </g>
      {g.arrows.map((a, i) => (
        <polygon key={i} points={arrowPoints(a.col, a.row, a.dir)} />
      ))}
      {g.text.map((t) => (
        <text
          key={t.row}
          x={t.cols.map((c) => PAD + c * CW).join(" ")}
          y={PAD + (t.row + 0.5) * CH}
          dominantBaseline="central"
          fontFamily='"DejaVu Sans Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
          fontSize={SIZE}
          style={{ whiteSpace: "pre" }}
        >
          {t.chars}
        </text>
      ))}
    </svg>
  );
}
