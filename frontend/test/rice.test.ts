// Run with: bun test test/rice.test.ts   (or: node --experimental-strip-types --test test/rice.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESETS,
  accentInk,
  createRiceStore,
  exportRice,
  decideRicePull,
  fromServerRice,
  isDark,
  luminance,
  parseHex,
  shufflePalette,
  type CommittedRice,
  type Rice,
  type RiceEnv,
  type Scheme,
  type StorageLike,
} from "../src/rice.ts";

function memory(): StorageLike {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}

function harness(initial: Scheme = "light") {
  const applied: { rice: Rice | null; scheme: Scheme }[] = [];
  let scheme = initial;
  const listeners = new Set<() => void>();
  const env: RiceEnv = {
    scheme: () => scheme,
    watchScheme(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    apply(rice, next) {
      applied.push({ rice, scheme: next });
    },
  };
  return {
    applied,
    env,
    storage: memory(),
    setScheme(next: Scheme) {
      scheme = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("hive matches the stylesheet palette", () => {
  const hive = PRESETS[0];
  assert.equal(hive.id, "hive");
  assert.equal(hive.light.bg, "#f6f6f3");
  assert.equal(hive.light.accent, "#e8a317");
  assert.equal(hive.dark.bg, "#111215");
  assert.equal(hive.dark.sidebar, "#0b0c0e");
  assert.equal(hive.dark.accentSoft, "#3a2e12");
  assert.equal(parseHex("#E8A317"), "#e8a317");
  assert.equal(parseHex("abc"), "#aabbcc");
  assert.equal(parseHex("nope"), null);
  assert.equal(accentInk("#e8a317"), "#1c1d21");
  assert.ok(luminance("#ffffff") > luminance("#000000"));
});

test("the default rice leaves the stylesheet in charge", () => {
  const h = harness("dark");
  const store = createRiceStore(h.storage, h.env);
  assert.equal(store.snapshot().active.id, "hive");
  assert.equal(store.snapshot().scheme, "dark");
  assert.equal(h.applied.at(-1)?.rice, null);
  assert.equal(store.snapshot().dirty, false);
});

test("a preset applies its palette and follows the system scheme", () => {
  const h = harness("light");
  const store = createRiceStore(h.storage, h.env);
  store.select("nord");
  assert.equal(h.applied.at(-1)?.rice?.id, "nord");
  assert.equal(h.applied.at(-1)?.scheme, "light");
  h.setScheme("dark");
  assert.equal(h.applied.at(-1)?.scheme, "dark");
  assert.equal(h.applied.at(-1)?.rice?.dark.accent, "#88c0d0");
  store.setAppearance("light");
  h.setScheme("dark");
  assert.equal(h.applied.at(-1)?.scheme, "light");
});

test("tweaks are unsaved until saved, and they do not mutate presets", () => {
  const h = harness();
  const store = createRiceStore(h.storage, h.env);
  const before = PRESETS.find((rice) => rice.id === "gruvbox")!.light.accent;
  store.select("gruvbox");
  assert.equal(store.setColor("light", "accent", "gg"), false);
  assert.equal(store.snapshot().dirty, false);
  assert.equal(store.setColor("light", "accent", "#cc241d"), true);
  assert.equal(store.snapshot().dirty, true);
  assert.equal(store.snapshot().active.light.accent, "#cc241d");
  assert.notEqual(store.snapshot().active.light.accentSoft, PRESETS.find((rice) => rice.id === "gruvbox")!.light.accentSoft);
  assert.equal(PRESETS.find((rice) => rice.id === "gruvbox")!.light.accent, before);
  store.revert();
  assert.equal(store.snapshot().dirty, false);
  assert.equal(store.snapshot().active.light.accent, before);
  store.setRadius(99);
  assert.equal(store.snapshot().active.radius, 24);
  store.setRadius(-3);
  assert.equal(store.snapshot().active.radius, 0);
});

test("saved rices persist, update, import, and fall back when deleted", () => {
  const h = harness();
  const store = createRiceStore(h.storage, h.env);
  store.select("matrix");
  assert.equal(store.save("   "), "Use a name up to 40 characters.");
  assert.equal(store.save("Phosphor"), null);
  assert.equal(store.snapshot().active.name, "Phosphor");
  assert.equal(store.snapshot().active.builtin, false);
  assert.match(store.snapshot().active.blurb, /Matrix/);
  assert.equal(store.snapshot().dirty, false);

  store.setFont("sans");
  assert.equal(store.updateSaved(), null);
  assert.equal(store.snapshot().active.font, "sans");
  assert.equal(store.snapshot().dirty, false);

  const exported = exportRice(store.snapshot().active);
  assert.equal(JSON.parse(exported).id, undefined);
  const other = harness();
  const imported = createRiceStore(other.storage, other.env);
  assert.equal(imported.importJson("{"), "That is not a rice file.");
  assert.equal(imported.importJson(exported), null);
  assert.equal(imported.snapshot().active.name, "Phosphor");
  assert.equal(imported.snapshot().active.font, "sans");
  assert.equal(imported.snapshot().active.dark.accent, "#39ff14");

  const reloaded = createRiceStore(h.storage, h.env);
  assert.equal(reloaded.snapshot().active.name, "Phosphor");
  const id = reloaded.snapshot().active.id;
  reloaded.remove(id);
  assert.equal(reloaded.snapshot().active.id, "hive");
  assert.equal(reloaded.snapshot().custom.length, 0);
});

test("only a saved change is committed, and a matching server copy keeps the draft", () => {
  const commits: CommittedRice[] = [];
  const h = harness();
  h.env.onCommit = (state) => commits.push(state);
  const store = createRiceStore(h.storage, h.env);
  assert.equal(commits.length, 0);
  store.select("nord");
  assert.deepEqual(commits.map((commit) => commit.selectedId), ["nord"]);
  assert.equal(store.setColor("light", "accent", "#cc241d"), true);
  assert.equal(commits.length, 1);
  store.applyCommitted({ selectedId: "nord", custom: [] });
  assert.equal(store.snapshot().dirty, true);
  assert.equal(store.snapshot().active.light.accent, "#cc241d");
  store.applyCommitted({ selectedId: "matrix", custom: [] });
  assert.equal(store.snapshot().baseId, "matrix");
  assert.equal(store.snapshot().dirty, false);
  assert.equal(commits.length, 1);
  store.reset();
  assert.equal(commits.at(-1)?.selectedId, "hive");

  const hive = PRESETS[0];
  const parsed = fromServerRice({
    selected_id: "custom-amber",
    custom: [
      {
        id: "custom-amber",
        name: "Amber",
        blurb: "Imported rice.",
        appearance: "light",
        font: "serif",
        radius: 16,
        density: "roomy",
        light: hive.light,
        dark: hive.dark,
      },
    ],
  });
  assert.equal(parsed?.custom[0]?.font, "serif");
  assert.equal(fromServerRice({ selected_id: "nord", custom: [] })?.selectedId, "nord");
});

test("an empty server uploads a local rice once, then a clear stays cleared", () => {
  const local: CommittedRice = { selectedId: "nord", custom: [] };
  assert.equal(decideRicePull({ saved: null, local, synced: false }).kind, "migrate");
  assert.deepEqual(decideRicePull({ saved: null, local, synced: true }), { kind: "apply", saved: null });
  assert.equal(decideRicePull({ saved: null, local: { selectedId: "hive", custom: [] }, synced: false }).kind, "apply");

  const applied = decideRicePull({ saved: { selected_id: "matrix", custom: [] }, local, synced: false });
  assert.equal(applied.kind, "apply");
  if (applied.kind === "apply") assert.equal(applied.saved?.selectedId, "matrix");

  const skipped = decideRicePull({
    saved: { selected_id: "custom-x", custom: [{ id: "custom-x", name: "X" } as never] },
    local,
    synced: true,
  });
  assert.equal(skipped.kind, "skip");
});

test("shuffle stays readable and harmonize repaints secondary colors", () => {
  const dark = shufflePalette(true, 120);
  const light = shufflePalette(false, 120);
  assert.ok(isDark(dark.bg));
  assert.equal(isDark(light.bg), false);
  assert.equal(parseHex(dark.accent), dark.accent);
  assert.notEqual(dark.bg, light.bg);

  const h = harness();
  const store = createRiceStore(h.storage, h.env);
  store.select("hive");
  store.shuffle("both");
  assert.equal(store.snapshot().dirty, true);
  assert.ok(isDark(store.snapshot().active.dark.bg));
  store.harmonize("dark");
  assert.equal(store.snapshot().active.dark.accentInk, accentInk(store.snapshot().active.dark.accent));
});
