import { useEffect, useId, useRef, useState } from "react";
import type { AsciiGraph } from "./asciiGraph";

export function AsciiGraphView({ graph, playing, replay }: { graph: AsciiGraph; playing: boolean; replay: number }) {
  const marker = `ascii_arrow_${useId().replace(/[^\w-]/g, "_")}`;
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSelected(null); setZoom(1);
  }, [graph]);
  useEffect(() => {
    const container = viewport.current!;
    const update = () => setFit(Math.min(1, Math.max(100, container.clientWidth) / graph.width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [graph.width]);
  const active = graph.nodes.find((node) => node.id === selected);
  const connected = graph.edges.filter((edge) => edge.from === selected || edge.to === selected);
  const related = new Set(connected.flatMap((edge) => [edge.from, edge.to]));
  const describe = (id: string) => graph.nodes.find((node) => node.id === id)?.label.replace(/\n/g, " ") ?? id;
  return <div className="ascii-graph">
    <div className="ascii-graph-tools">
      <span>Interactive diagram · click a node</span>
      <div>
        <button type="button" className="code-copy-btn" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom((z) => Math.max(.5, z - .25))}>−</button>
        <span className="ascii-zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" className="code-copy-btn" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, z + .25))}>+</button>
        <button type="button" className="code-copy-btn" onClick={() => { setZoom(1); setSelected(null); viewport.current?.scrollTo(0, 0); }}>Fit</button>
      </div>
    </div>
    <div className="ascii-graph-viewport" ref={viewport}>
      <svg viewBox={`0 0 ${graph.width} ${graph.height}`} width={graph.width * fit * zoom} height={graph.height * fit * zoom}
        role="group" aria-label="Interactive diagram converted from agent ASCII" className="ascii-graph-svg">
        <defs>
          <marker id={marker} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0,0 L9,4.5 L0,9 Z" fill="context-stroke" />
          </marker>
        </defs>
        {graph.edges.map((edge) => {
          const d = edge.points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
          const focused = selected === null || connected.includes(edge);
          return <g key={edge.id} className="ascii-graph-edge" data-highlighted={selected !== null && focused} opacity={focused ? 1 : .2}>
            <title>{describe(edge.from)} {edge.both ? "↔" : edge.directed ? "→" : "—"} {describe(edge.to)}</title>
            <path d={d} fill="none" stroke="currentColor" strokeWidth={selected !== null && focused ? 3 : 2}
              markerEnd={edge.directed ? `url(#${marker})` : undefined} markerStart={edge.both ? `url(#${marker})` : undefined} />
            {playing && focused && edge.directed && <circle key={replay} r="4" className="ascii-flow-dot">
              <animateMotion dur="1.8s" repeatCount="indefinite" path={d} />
            </circle>}
          </g>;
        })}
        {graph.nodes.map((node) => {
          const label = node.label.split("\n");
          return <g key={node.id} role="button" tabIndex={0} aria-label={`Select node ${node.label.replace(/\n/g, " ")}`}
            aria-pressed={node.id === selected} className="ascii-graph-node" data-selected={node.id === selected}
            opacity={selected === null || related.has(node.id) ? 1 : .4}
            onClick={() => setSelected((old) => old === node.id ? null : node.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected((old) => old === node.id ? null : node.id); } }}>
            <title>{node.label}</title>
            <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="7" />
            <text x={node.x + node.w / 2} textAnchor="middle" dominantBaseline="central" fontSize="13">
              {label.map((line, i) => <tspan key={i} x={node.x + node.w / 2} y={node.y + node.h / 2 + (i - (label.length - 1) / 2) * 18}>{line}</tspan>)}
            </text>
          </g>;
        })}
      </svg>
    </div>
    {active && <div className="ascii-node-details" aria-live="polite">
      <strong>{active.label.replace(/\n/g, " ")}</strong>
      <ul>{connected.map((edge) => <li key={edge.id}>{describe(edge.from)} {edge.both ? "↔" : edge.directed ? "→" : "—"} {describe(edge.to)}</li>)}</ul>
      <button type="button" className="code-copy-btn" onClick={() => setSelected(null)}>Clear selection</button>
    </div>}
  </div>;
}
