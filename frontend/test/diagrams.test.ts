// Run with: node --experimental-strip-types --test test/diagrams.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { drawioToScene, labelLines, looksLikeDrawio } from "../src/diagrams/drawio.ts";
import { plantumlToMermaid } from "../src/diagrams/plantuml.ts";

const ACTIVITY = `@startuml
title Language choice: Zig vs Rust
start
if (C/C++ interop or embedded/freestanding\\na hard requirement?) then (Yes)
  if (Safety-critical a team\\nmaintaining it?) then (No)
    :Zig;
  else (Yes)
    :Rust;
  endif
else (No)
  if (Compile-time safety worth\\na steeper learning curve?) then (Yes)
    :Rust;
  else (No)
    :Spike both on a real task\\n(time-box: ~half a day per language);
  endif
endif
:Document the decision in an ADR;
stop
@enduml`;

test("plantuml activity diagram keeps every branch and joins them afterwards", () => {
  const mmd = plantumlToMermaid(ACTIVITY);
  const lines = mmd.split("\n");
  assert.equal(lines[0], "flowchart TD");
  const edges = lines.filter((l) => l.includes("-->"));
  const nodes = lines.filter((l) => !l.includes("-->") && l !== lines[0]);
  assert.equal(nodes.filter((l) => l.includes("{")).length, 3, "three decisions");
  assert.ok(mmd.includes('"C/C++ interop or embedded/freestanding<br/>a hard requirement?"'));
  // Both Rust/Zig leaves of the first branch and the Spike leaf flow into the ADR action.
  const adr = nodes.find((l) => l.includes("Document the decision"))!.trim().split("[")[0];
  const incoming = edges.filter((l) => l.trim().endsWith(`--> ${adr}`) || l.trim().endsWith(`| ${adr}`));
  assert.equal(incoming.length, 4);
  // Edge labels from `then (Yes)` / `else (No)` are preserved.
  assert.ok(edges.some((l) => l.includes('|"Yes"|')) && edges.some((l) => l.includes('|"No"|')));
  // Stop is terminal: nothing leaves it.
  const stop = nodes.find((l) => l.includes('"Stop"'))!.trim().split("(")[0];
  assert.ok(!edges.some((l) => l.trim().startsWith(`${stop} `)));
});

test("plantuml while/repeat/fork produce loops and parallel joins", () => {
  const mmd = plantumlToMermaid(`@startuml
start
while (more?) is (yes)
  :work;
endwhile (no)
repeat
  :try;
repeat while (failed?) is (yes) not (done)
fork
  :a;
fork again
  :b;
end fork
stop
@enduml`);
  assert.match(mmd, /n1\{"more\?"\}/);
  assert.match(mmd, /n2 --> n1/, "loop back edge");
  assert.match(mmd, /-->\|"no"\| n3/, "exit label on while");
  assert.match(mmd, /\|"yes"\| n3/, "repeat back edge");
  assert.equal((mmd.match(/\{\{" "\}\}/g) ?? []).length, 2, "fork + join bars");
});

test("plantuml sequence diagram maps arrows, aliases and blocks", () => {
  const mmd = plantumlToMermaid(`@startuml
actor User
participant "Web App" as W
User -> W: open
W --> User: page
W <- User: ack
alt ok
  W -> W: self
else bad
  W ->x User: fail
end
@enduml`);
  assert.deepEqual(mmd.split("\n"), [
    "sequenceDiagram",
    "  actor User",
    "  participant W as Web App",
    "  User ->> W: open",
    "  W -->> User: page",
    "  User ->> W: ack",
    "  alt ok",
    "  W ->> W: self",
    "  else bad",
    "  W -x User: fail",
    "  end",
  ]);
});

test("plantuml rejects unsupported diagram kinds and malformed blocks", () => {
  assert.throws(() => plantumlToMermaid("@startuml\nclass A\n@enduml"), /activity and sequence/);
  assert.throws(() => plantumlToMermaid("@startuml\nstart\nif (x) then (y)\n:a;\n@enduml"), /Unterminated/);
  assert.throws(() => plantumlToMermaid("@startuml\nstart\nendif\n@enduml"), /endif without if/);
});

test("plantuml labels cannot inject markup", () => {
  const mmd = plantumlToMermaid('@startuml\nstart\n:<img src=x onerror=alert(1)> "q";\nstop\n@enduml');
  assert.ok(!mmd.includes("<img"));
  assert.ok(mmd.includes("#lt;img") && mmd.includes("#quot;q#quot;"));
});

const DRAWIO = `<mxfile host="app.diagrams.net">
  <diagram id="lang-choice" name="Language Choice">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="start" value="Start: new project" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="360" y="20" width="160" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="q1" value="C/C++ interop &amp;amp; embedded?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="320" y="100" width="240" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="zig" value="Zig" style="ellipse;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="100" y="240" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="start" target="q1">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="e2" value="Yes" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;" edge="1" parent="1" source="q1" target="zig">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

test("draw.io document becomes shapes with clipped orthogonal edges", async () => {
  assert.ok(looksLikeDrawio(DRAWIO));
  const scene = await drawioToScene(DRAWIO);
  assert.deepEqual(scene.shapes.map((s) => [s.id, s.kind]), [["start", "rect"], ["q1", "rhombus"], ["zig", "ellipse"]]);
  assert.equal(scene.shapes[0].radius > 0, true, "rounded=1 gives corner radius");
  assert.equal(scene.shapes[2].fill, "#dae8fc");
  assert.deepEqual(scene.shapes[1].text?.lines, ["C/C++ interop & embedded?"]);

  const [e1, e2] = scene.edges;
  // start (bottom centre 440,60) → rhombus top vertex (440,100): one vertical segment, arrowhead trimmed off the line.
  assert.equal(e1.points.length, 2);
  assert.equal(e1.points[0].x, 440);
  assert.equal(e1.points[0].y, 60);
  assert.ok(e1.points[1].y < 100 && e1.heads[0].points[0].y === 100);
  // q1 → zig: rhombus left vertex (320,140) to ellipse top (160,240), L-shaped through (160,140).
  assert.equal(e2.points[0].x, 320);
  assert.equal(e2.points[0].y, 140);
  assert.ok(e2.points.some((p) => p.x === 160 && p.y === 140));
  assert.equal(e2.points[e2.points.length - 1].x, 160);
  assert.equal(e2.text?.lines[0], "Yes");
  // Everything lies inside the computed viewBox.
  for (const s of scene.shapes) assert.ok(s.x >= scene.minX && s.x + s.w <= scene.minX + scene.width);
});

test("draw.io compressed <diagram> payloads are inflated", async () => {
  const model = DRAWIO.slice(DRAWIO.indexOf("<mxGraphModel"), DRAWIO.indexOf("</mxGraphModel>") + "</mxGraphModel>".length);
  const payload = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString("base64");
  const scene = await drawioToScene(`<mxfile><diagram name="p">${payload}</diagram></mxfile>`);
  assert.equal(scene.shapes.length, 3);
  assert.equal(scene.edges.length, 2);
});

test("draw.io child cells are positioned relative to their container and hidden cells are skipped", async () => {
  const scene = await drawioToScene(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="box" value="Box" style="swimlane;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="200" height="200" as="geometry"/></mxCell>
    <mxCell id="in" value="in" vertex="1" parent="box"><mxGeometry x="10" y="40" width="50" height="30" as="geometry"/></mxCell>
    <mxCell id="gone" value="x" vertex="1" visible="0" parent="1"><mxGeometry x="0" y="0" width="5" height="5" as="geometry"/></mxCell>
  </root></mxGraphModel>`);
  const inner = scene.shapes.find((s) => s.id === "in")!;
  assert.deepEqual([inner.x, inner.y], [110, 140]);
  assert.equal(scene.shapes.some((s) => s.id === "gone"), false);
});

test("draw.io rejects non-diagram XML", async () => {
  await assert.rejects(drawioToScene("<svg></svg>"), /Not a draw.io document/);
  await assert.rejects(drawioToScene("<mxfile><diagram>"), /not closed|Malformed/);
  assert.equal(looksLikeDrawio("<svg/>"), false);
});

test("label tag stripping leaves no tag behind when tags are nested", () => {
  for (const input of ["<scr<b>ipt>alert(1)</scr</b>ipt>", "<<b>script>x", "<scr<!-->ipt>x", "<<<b>b>b>script>x"]) {
    const out = labelLines(input, true).join("\n");
    assert.ok(!/<[a-z/!]/i.test(out), `${input} -> ${out}`);
  }
  assert.deepEqual(labelLines("a<b>b</b><br/>c", true), ["ab", "c"]);
  // Entities decode to plain text only after stripping, so they never become tags to strip.
  assert.deepEqual(labelLines("&lt;b&gt;x", true), ["<b>x"]);
});
