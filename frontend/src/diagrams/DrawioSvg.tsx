// SVG view of a draw.io Scene (see drawio.ts). Built from React elements, never raw markup,
// so diagram text from untrusted agent output cannot inject HTML.
import type { ReactNode } from "react";
import type { ArrowHead, Pt, Scene, SceneEdge, SceneShape, TextSpec } from "./drawio";

const FONT = "Helvetica, Arial, sans-serif";
const LINE = 1.2;
const CHAR_W = 0.56;

function polygon(points: Pt[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

function shapeBody(s: SceneShape): ReactNode {
  const common = {
    fill: s.fill,
    stroke: s.stroke,
    strokeWidth: s.strokeWidth,
    strokeDasharray: s.dashed ? "6 4" : undefined,
    opacity: s.opacity,
  };
  const { x, y, w, h } = s;
  switch (s.kind) {
    case "ellipse":
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    case "rhombus":
      return <polygon points={polygon([{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }])} {...common} />;
    case "triangle":
      return <polygon points={polygon([{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }])} {...common} />;
    case "hexagon":
      return <polygon points={polygon([{ x: x + w * 0.25, y }, { x: x + w * 0.75, y }, { x: x + w, y: y + h / 2 }, { x: x + w * 0.75, y: y + h }, { x: x + w * 0.25, y: y + h }, { x, y: y + h / 2 }])} {...common} />;
    case "parallelogram":
      return <polygon points={polygon([{ x: x + w * 0.25, y }, { x: x + w, y }, { x: x + w * 0.75, y: y + h }, { x, y: y + h }])} {...common} />;
    case "cylinder": {
      const ry = Math.min(h * 0.12, 15);
      const d = `M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z`;
      return (
        <g>
          <path d={d} {...common} />
          <path d={`M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}`} fill="none" stroke={s.stroke} strokeWidth={s.strokeWidth} />
        </g>
      );
    }
    case "swimlane":
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} {...common} fill="none" />
          <rect x={x} y={y} width={w} height={Math.min(s.startSize, h)} {...common} />
        </g>
      );
    case "text":
      return null;
    case "rect":
      return <rect x={x} y={y} width={w} height={h} rx={s.radius} {...common} />;
  }
}

function textNode(t: TextSpec): ReactNode {
  const lh = t.size * LINE;
  const total = t.lines.length * lh;
  const top = t.baseline === "top" ? t.y : t.baseline === "bottom" ? t.y - total : t.y - total / 2;
  const widest = Math.max(...t.lines.map((l) => l.length)) * t.size * CHAR_W;
  const bgX = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - widest : t.x - widest / 2;
  return (
    <>
      {t.background && <rect x={bgX - 3} y={top - 1} width={widest + 6} height={total + 2} fill={t.background} opacity={0.9} />}
      <text
        x={t.x}
        textAnchor={t.anchor}
        fill={t.color}
        fontFamily={FONT}
        fontSize={t.size}
        fontWeight={t.bold ? "bold" : undefined}
        fontStyle={t.italic ? "italic" : undefined}
        textDecoration={t.underline ? "underline" : undefined}
      >
        {t.lines.map((line, i) => (
          <tspan key={i} x={t.x} y={top + lh * i + lh / 2} dominantBaseline="central">
            {line || "\u00a0"}
          </tspan>
        ))}
      </text>
    </>
  );
}

function edgePath(e: SceneEdge): string {
  const pts = e.points;
  const r = e.curved ? 24 : e.rounded ? 10 : 0;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    if (!r || !next) {
      d += ` L${cur.x},${cur.y}`;
      continue;
    }
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const a = { x: cur.x - ((cur.x - prev.x) / inLen) * k, y: cur.y - ((cur.y - prev.y) / inLen) * k };
    const b = { x: cur.x + ((next.x - cur.x) / outLen) * k, y: cur.y + ((next.y - cur.y) / outLen) * k };
    d += ` L${a.x},${a.y} Q${cur.x},${cur.y} ${b.x},${b.y}`;
  }
  return d;
}

function head(h: ArrowHead, e: SceneEdge, key: number): ReactNode {
  const fill = h.filled ? e.stroke : "#ffffff";
  if (h.kind === "oval") return <circle key={key} cx={h.c!.x} cy={h.c!.y} r={h.r} fill={fill} stroke={e.stroke} strokeWidth={e.strokeWidth} />;
  if (h.kind === "line") return <polyline key={key} points={polygon(h.points)} fill="none" stroke={e.stroke} strokeWidth={e.strokeWidth} />;
  return <polygon key={key} points={polygon(h.points)} fill={fill} stroke={e.stroke} strokeWidth={e.strokeWidth} strokeLinejoin="round" />;
}

export function DrawioSvg({ scene }: { scene: Scene }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${scene.minX} ${scene.minY} ${scene.width} ${scene.height}`}
      width={scene.width}
      height={scene.height}
      role="img"
      aria-label="draw.io diagram"
    >
      <rect x={scene.minX} y={scene.minY} width={scene.width} height={scene.height} fill="#ffffff" />
      {scene.shapes.map((s) => (
        <g key={`s${s.id}`}>
          {shapeBody(s)}
          {s.text && textNode(s.text)}
        </g>
      ))}
      {scene.edges.map((e) => (
        <g key={`e${e.id}`}>
          <path d={edgePath(e)} fill="none" stroke={e.stroke} strokeWidth={e.strokeWidth} strokeDasharray={e.dashed ? "6 4" : undefined} />
          {e.heads.map((h, i) => head(h, e, i))}
          {e.text && textNode(e.text)}
        </g>
      ))}
    </svg>
  );
}
