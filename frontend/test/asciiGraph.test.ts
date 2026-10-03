import assert from "node:assert/strict";
import { test } from "node:test";
import { asciiToGraph } from "../src/diagrams/asciiGraph.ts";

function connections(source: string) {
  const graph = asciiToGraph(source);
  assert.ok(graph, source);
  const name = (id: string) => graph.nodes.find((node) => node.id === id)!.label;
  return { graph, links: graph.edges.map((edge) => `${name(edge.from)}${edge.both ? "↔" : edge.directed ? "→" : "—"}${name(edge.to)}`) };
}

test("agent bracketed/bare labels become nodes with actual arrow geometry", () => {
  for (const input of ["[Browser] -> [API] --> [DB]", "Browser -> API -> DB", "Browser => API → DB"]) {
    const { graph, links } = connections(input);
    assert.deepEqual(links, ["Browser→API", "API→DB"]);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges[0].points[0].x, graph.nodes[0].x + graph.nodes[0].w);
    assert.equal(graph.edges[0].points.at(-1)!.x, graph.nodes[1].x);
  }
});

test("left, bidirectional, Unicode and undirected connectors preserve direction", () => {
  assert.deepEqual(connections("[A] <-- [B]").links, ["B→A"]);
  assert.deepEqual(connections("[A] ↔ [B]").links, ["A↔B"]);
});

test("bidirectional and vertical heads are not reversed", () => {
  assert.deepEqual(connections("[A] <-> [B]").links, ["A↔B"]);
  assert.deepEqual(connections("[A] -- [B]").links, ["A—B"]);
  assert.deepEqual(connections("[A]\n |\n v\n[B]").links, ["A→B"]);
  assert.deepEqual(connections("[A]\n ↑\n │\n[B]").links, ["B→A"]);
  assert.deepEqual(connections("[A] ← [B]").links, ["B→A"]);
});

test("complete ASCII and Unicode boxes retain all label lines", () => {
  for (const source of [
    "+-----+       +----+\n| API | ----> | DB |\n+-----+       +----+",
    "┌─────┐       ┌────┐\n│ API │ ────→ │ DB │\n└─────┘       └────┘",
  ]) assert.deepEqual(connections(source).links, ["API→DB"]);
  assert.deepEqual(connections("+-----+       +----+\n| Web | ----> | DB |\n| API |       |    |\n+-----+       +----+").links, ["Web\nAPI→DB"]);
});

test("explicit branch junction retains two routes and its bend", () => {
  const { graph, links } = connections("[A] --+--> [B]\n      |\n      v\n     [C]");
  assert.deepEqual(links, ["A→B", "A→C"]);
  assert.equal(graph.edges[1].points.length, 3);
});

test("unrecognized content, incomplete boxes and ambiguous junctions stay source", () => {
  for (const source of ["ASCII cat /\\_/\\", "[A] → [B]\nImportant unexplained note", "[A] --+--> [B]\n      |\n     [C]", "+-----+\n| API | --> [DB]", "[A]\t--> [B]", "[A] >---- [B]"]) {
    assert.equal(asciiToGraph(source), null, source);
  }
});

test("labels remain literal text, duplicate labels remain distinct nodes", () => {
  const { graph, links } = connections("[<img onerror=boom>] -> [<img onerror=boom>]");
  assert.equal(graph.nodes.length, 2);
  assert.notEqual(graph.nodes[0].id, graph.nodes[1].id);
  assert.deepEqual(links, ["<img onerror=boom>→<img onerror=boom>"]);
});

test("large agent drawings are bounded", () => {
  assert.equal(asciiToGraph("x".repeat(20001)), null);
  assert.equal(asciiToGraph("[A] -> [B]\n" + "\n".repeat(201)), null);
});
