/**
 * Emits the block-schema fixture the Go guard (`blockschema_guard_test.go`) drives the real
 * parsers with. TypeScript's zod is the oracle: the schema is converted with z.toJSONSchema, and
 * every variant gets
 *
 * - one block with EVERY field filled, so a field Go loses shows up as a stripped key;
 * - junk keys at every level, which both zod and Go must strip;
 * - cap probes: every maxLength/minLength/maxItems/minimum/exclusiveMinimum the schema declares,
 *   mutated one past the boundary, which zod must refuse;
 * - omission probes: every optional property removed in turn, which is how a default and a
 *   refinement that only fires when a key is absent ("a credential with auth login has an
 *   origin") reach the guard;
 * - refinement probes: the hand-written blocks below that only a `.refine`/`.superRefine`
 *   refuses, since z.toJSONSchema cannot express those;
 * - acceptance controls: the boundary-valid counterpart of a refinement, so a parser that
 *   refuses everything near a cap fails too.
 *
 * `expected` is `MessageBlock.parse`'s own output, never a re-derivation from the JSON Schema:
 * a hand-rolled projection can disagree with zod (it cannot know that z.record keeps its keys),
 * and then the guard compares Go against the projection instead of against TypeScript.
 *
 * Every sample is asserted against `MessageBlock` itself: a probe zod accepts, or a control
 * zod refuses, means the fixture is wrong and the generator exits non-zero rather than shipping
 * a guard that tests the wrong thing.
 *
 * Usage, from the repository root:
 *   node_modules/.bin/tsx apps/api-go/tools/blockschema-fixture.mts \
 *     > apps/api-go/internal/messageblocks/testdata/message-blocks-schema.json
 */
import { createRequire } from "node:module";
import { MessageBlock } from "../../../packages/contracts/src/threads/message-blocks.ts";

// apps/api-go has no zod of its own; resolve the contracts package's copy.
const requireFromContracts = createRequire(
  new URL("../../../packages/contracts/package.json", import.meta.url),
);
const { z } = requireFromContracts("zod") as typeof import("zod");

type Node = any;
type Path = (string | number)[];

function deref(root: Node, node: Node): Node {
  let current = node;
  for (let i = 0; i < 20; i++) {
    if (current && typeof current.$ref === "string") {
      current = root.$defs?.[current.$ref.replace(/^#\/\$defs\//, "")];
      continue;
    }
    if (current && Array.isArray(current.allOf) && current.allOf.length === 1) {
      current = current.allOf[0];
      continue;
    }
    return current ?? {};
  }
  return current ?? {};
}

/** The branch a nullable union uses for its value: the first that is not `type: "null"`. */
function shape(root: Node, node: Node): Node {
  const schema = deref(root, node);
  const branches: Node[] | undefined = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (!branches) return schema;
  const branch = branches.find((candidate) => {
    const resolved = deref(root, candidate);
    return resolved.type !== "null";
  });
  return branch ? shape(root, branch) : schema;
}

function typeOf(schema: Node): string | undefined {
  const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.find((t: string) => t !== "null") ?? types[0];
}

/** A value of the shape the schema declares, filling every declared property. */
function sample(root: Node, node: Node, depth = 0, key = ""): unknown {
  const schema = shape(root, node);
  if (depth > 12) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = typeOf(schema);
  switch (type) {
    case "string": {
      if (key === "origin") return "https://example.test";
      if (schema.format === "email") return "user@example.test";
      if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000000";
      if (schema.format === "date-time") return "2020-01-01T00:00:00.000Z";
      if (schema.format === "uri" || schema.format === "uri-reference") return "https://example.test/x";
      const min = Number.isInteger(schema.minLength) ? schema.minLength : 0;
      const max = Number.isInteger(schema.maxLength) ? schema.maxLength : Math.max(min, 2);
      return "x".repeat(Math.max(min, Math.min(max, 2)));
    }
    case "integer":
    case "number": {
      const lower = Number.isFinite(schema.exclusiveMinimum)
        ? schema.exclusiveMinimum + 1
        : Number.isFinite(schema.minimum)
          ? schema.minimum
          : undefined;
      const value = lower === undefined ? 1 : Math.max(lower, 1);
      if (Number.isFinite(schema.maximum) && value > schema.maximum) return schema.maximum;
      return value;
    }
    case "boolean":
      return true;
    case "array": {
      const min = Number.isInteger(schema.minItems) ? schema.minItems : 1;
      const count = Math.max(min, 1);
      return Array.from({ length: count }, () => sample(root, schema.items ?? {}, depth + 1));
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [property, child] of Object.entries(schema.properties ?? {})) {
        out[property] = sample(root, child, depth + 1, property);
      }
      return out;
    }
    default:
      return null;
  }
}

/** Adds a junk key to every object in the value, so stripping is proven at each level. */
function junkify(value: any, depth = 0): any {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => junkify(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = junkify(child, depth + 1);
    out.__junk = "strip me";
    return out;
  }
  return value;
}

type Probe = { path: Path; value: unknown; why: string };
type Omission = { path: Path; why: string };

/** Every cap the schema declares, as a mutation that one past the boundary must be refused. */
function probes(root: Node, node: Node, path: Path, out: Probe[], depth = 0): void {
  const schema = shape(root, node);
  if (depth > 12) return;
  if (Number.isInteger(schema.maxLength)) {
    out.push({ path, value: "x".repeat(schema.maxLength + 1), why: `maxLength ${schema.maxLength}` });
  }
  if (Number.isInteger(schema.minLength) && schema.minLength > 0) {
    out.push({ path, value: "x".repeat(schema.minLength - 1), why: `minLength ${schema.minLength}` });
  }
  if (Number.isInteger(schema.maxItems)) {
    const item = sample(root, schema.items ?? {});
    out.push({
      path,
      value: Array.from({ length: schema.maxItems + 1 }, () => item),
      why: `maxItems ${schema.maxItems}`,
    });
  }
  const type = typeOf(schema);
  if (type === "integer" || type === "number") {
    if (Number.isFinite(schema.exclusiveMinimum)) {
      out.push({ path, value: schema.exclusiveMinimum, why: `exclusiveMinimum ${schema.exclusiveMinimum}` });
    }
    if (Number.isFinite(schema.minimum)) {
      out.push({ path, value: schema.minimum - 1, why: `minimum ${schema.minimum}` });
    }
    if (Number.isFinite(schema.exclusiveMaximum)) {
      out.push({ path, value: schema.exclusiveMaximum, why: `exclusiveMaximum ${schema.exclusiveMaximum}` });
    }
    if (Number.isFinite(schema.maximum)) {
      out.push({ path, value: schema.maximum + 1, why: `maximum ${schema.maximum}` });
    }
  }
  if (type === "object") {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      probes(root, child, [...path, key], out, depth + 1);
    }
  }
  if (type === "array" && schema.items && !Number.isInteger(schema.maxItems)) {
    probes(root, schema.items, [...path, 0], out, depth + 1);
  }
}

/**
 * Every optional property, at every level, as a path to remove. Removing it is how an absent
 * key reaches the guard: a `.default()` must come back filled, and a `.superRefine` that only
 * fires on a missing key (a credential with no origin) must refuse.
 */
function omissions(root: Node, node: Node, path: Path, out: Omission[], depth = 0): void {
  const schema = shape(root, node);
  if (depth > 8) return;
  const type = typeOf(schema);
  if (type === "object") {
    const properties = schema.properties ?? {};
    const required = new Set<string>(schema.required ?? []);
    if (Object.keys(properties).length === 0) return;
    for (const [key, child] of Object.entries(properties)) {
      if (!required.has(key)) out.push({ path: [...path, key], why: `omitting ${[...path, key].join(".")}` });
      omissions(root, child, [...path, key], out, depth + 1);
    }
  }
  if (type === "array" && schema.items) {
    omissions(root, schema.items, [...path, 0], out, depth + 1);
  }
}

/**
 * Every leaf value (anything that is not an object with declared properties, or an array), with
 * the schema that declares it. Replacing it is how a parser that is too permissive — Go reading a
 * number where zod wants a string — or too strict, or that forgets a trim, is caught.
 */
function leafSchemas(
  root: Node,
  node: Node,
  path: Path,
  out: { path: Path; schema: Node; nullable: boolean }[],
  depth = 0,
): void {
  const resolved = deref(root, node);
  const nullable =
    (Array.isArray(resolved.anyOf) &&
      resolved.anyOf.some((branch: Node) => deref(root, branch).type === "null")) ||
    (Array.isArray(resolved.oneOf) &&
      resolved.oneOf.some((branch: Node) => deref(root, branch).type === "null"));
  const schema = shape(root, node);
  if (depth > 8) return;
  const type = typeOf(schema);
  if (type === "object") {
    const properties = schema.properties ?? {};
    if (Object.keys(properties).length === 0) {
      // z.record: its values are z.any, so only the map itself has a type.
      out.push({ path, schema, nullable });
      return;
    }
    for (const [key, child] of Object.entries(properties)) {
      leafSchemas(root, child, [...path, key], out, depth + 1);
    }
    return;
  }
  if (type === "array") {
    out.push({ path, schema, nullable });
    if (schema.items) leafSchemas(root, schema.items, [...path, 0], out, depth + 1);
    return;
  }
  if (type !== undefined) out.push({ path, schema, nullable });
}

/** A value of a JSON type the schema does not declare for that path. */
function wrongType(type: string): unknown {
  switch (type) {
    case "string":
      return 5;
    case "integer":
    case "number":
      return "5";
    case "boolean":
      return "true";
    case "array":
      return {};
    default:
      return [];
  }
}

/** Every required property, at every level, as a path to remove: zod refuses a block missing one. */
function requiredPaths(root: Node, node: Node, path: Path, out: Path[], depth = 0): void {
  const schema = shape(root, node);
  if (depth > 8) return;
  const type = typeOf(schema);
  if (type === "object") {
    const properties = schema.properties ?? {};
    if (Object.keys(properties).length === 0) return;
    const required = new Set<string>(schema.required ?? []);
    for (const [key, child] of Object.entries(properties)) {
      if (required.has(key)) out.push([...path, key]);
      requiredPaths(root, child, [...path, key], out, depth + 1);
    }
  }
  if (type === "array" && schema.items) {
    requiredPaths(root, schema.items, [...path, 0], out, depth + 1);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function withoutPath(block: unknown, path: Path): unknown {
  const mutated = clone(block) as any;
  let cursor = mutated;
  for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]!];
  delete cursor[path[path.length - 1]!];
  return mutated;
}

function withPath(block: unknown, path: Path, value: unknown): unknown {
  const mutated = clone(block) as any;
  let cursor = mutated;
  for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]!];
  cursor[path[path.length - 1]!] = value;
  return mutated;
}

/** Blocks TS refuses only through a refinement, built from the variant's own all-fields block. */
const refinements: Record<string, { why: string; mutate: (block: any) => void }[]> = {
  ask: [
    {
      why: "a credential with auth login has no origin",
      mutate: (block) => {
        block.credential = { name: "site-login", origin: "", auth: { type: "login" } };
      },
    },
    {
      why: "a website login on a private plain-HTTP origin",
      mutate: (block) => {
        block.credential = { name: "site-login", origin: "http://192.168.0.5:8080", auth: { type: "login" } };
      },
    },
    {
      why: "a command credential that names a site",
      mutate: (block) => {
        block.credential = { name: "token", origin: "https://example.test", auth: { type: "command" } };
      },
    },
    {
      why: "a command credential whose variable is reserved",
      mutate: (block) => {
        block.credential = { name: "path", origin: "", auth: { type: "command" } };
      },
    },
    {
      why: "a one-time code on a plain-HTTP origin",
      mutate: (block) => {
        block.oneTimeCode = { origin: "http://example.test" };
      },
    },
    {
      why: "a one-time code origin carrying credentials",
      mutate: (block) => {
        block.oneTimeCode = { origin: "https://user:pass@example.test" };
      },
    },
    {
      why: "login field labels that differ only by case",
      mutate: (block) => {
        block.loginFields = ["Username", "username"];
      },
    },
    {
      why: "a receipt item list over the 30-row cap (a maxItems probe, kept as the refinement it also is)",
      mutate: (block) => {
        block.receipt = { items: Array.from({ length: 31 }, () => ({ name: "n", amount: "a" })), amountSource: "page" };
      },
    },
  ],
  chart: [
    {
      why: "data rows plus the spec's own data rows over 5000",
      mutate: (block) => {
        block.data = Array.from({ length: 3_000 }, () => ({}));
        block.spec = { data: Array.from({ length: 2_001 }, () => ({})) };
      },
    },
    {
      why: "data rows plus a mark's data rows over 5000",
      mutate: (block) => {
        block.data = Array.from({ length: 100 }, () => ({}));
        block.spec = { marks: [{ data: Array.from({ length: 4_901 }, () => ({})) }] };
      },
    },
  ],
};

/** Blocks TS accepts and whose output differs from the all-fields sample: cap boundaries and
 * shapes a refinement allows on one side only. */
const acceptances: Record<string, { why: string; mutate: (block: any) => void }[]> = {
  ask: [
    {
      why: "a private plain-HTTP origin for an API credential",
      mutate: (block) => {
        block.credential = { name: "token", origin: "http://192.168.0.5:8080", auth: { type: "bearer" } };
      },
    },
    {
      why: "a command credential with no site",
      mutate: (block) => {
        block.credential = { name: "token", origin: "", auth: { type: "command" } };
      },
    },
  ],
  chart: [
    {
      why: "exactly 5000 rows across data and the spec",
      mutate: (block) => {
        block.data = Array.from({ length: 2_500 }, () => ({}));
        block.spec = { data: Array.from({ length: 2_500 }, () => ({})) };
      },
    },
  ],
};

function assertAccepted(why: string, block: unknown): Record<string, unknown> {
  const parsed = MessageBlock.safeParse(block);
  if (!parsed.success) {
    throw new Error(`${why}: TypeScript refuses the fixture block\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  // Round-trip through JSON so `undefined` and class instances read exactly as the Go side sees
  // the stored jsonb value.
  return JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
}

function assertRefused(why: string, block: unknown): void {
  if (MessageBlock.safeParse(block).success) {
    throw new Error(`${why}: TypeScript accepts the fixture's refusal probe`);
  }
}

const json = z.toJSONSchema(MessageBlock, { io: "input" }) as Node;
const root = { ...json, $defs: { ...(json.$defs ?? {}) } };
const variants = json.anyOf ?? json.oneOf ?? [];

const fixture = {
  source: "packages/contracts/src/threads/message-blocks.ts MessageBlock",
  variants: variants.map((variant: Node) => {
    const block = junkify(sample(root, variant));
    const expected = assertAccepted("all-fields sample", block);

    const capProbes: Probe[] = [];
    probes(root, variant, [], capProbes);
    const probeEntries = capProbes.map((probe) => {
      const mutated = withPath(block, probe.path, probe.value);
      assertRefused(`cap probe ${probe.why} at ${probe.path.join(".") || "<root>"}`, mutated);
      return { path: probe.path, why: probe.why, block: mutated };
    });

    const omissionPaths: Omission[] = [];
    omissions(root, variant, [], omissionPaths);
    const omissionEntries: { path: Path; why: string; block: unknown; expected: unknown }[] = [];
    const refusals: { why: string; block: unknown }[] = [];
    const padEntries: { why: string; block: unknown; expected: unknown }[] = [];
    const leafList: { path: Path; schema: Node; nullable: boolean }[] = [];
    leafSchemas(root, variant, [], leafList);
    for (const leaf of leafList) {
      const leafType = typeOf(leaf.schema);
      // A value of another JSON type is refused by the type check. z.any() declares none, so it
      // never reaches this list.
      if (leafType !== undefined) {
        const why = `a value of another JSON type at ${leaf.path.join(".")} where ${leafType} is declared`;
        const mutated = withPath(block, leaf.path, wrongType(leafType));
        assertRefused(why, mutated);
        refusals.push({ why, block: mutated });
      }
      // An integer is not a float and not beyond the safe range zod's `.int()` declares: both are
      // values `z.number().int()` refuses and a looser parser would keep.
      if (leafType === "integer") {
        for (const [value, name] of [
          [1.5, "a fractional number"],
          [9_007_199_254_740_992, "an unsafe integer"],
        ] as [number, string][]) {
          const why = `${name} at ${leaf.path.join(".")} where an integer is declared`;
          const mutated = withPath(block, leaf.path, value);
          assertRefused(why, mutated);
          refusals.push({ why, block: mutated });
        }
      }
      // A nullable leaf accepts null, and zod's output keeps it: a parser that reads the null
      // branch as a missing field drops the key instead of returning null.
      if (leaf.nullable) {
        const why = `null at ${leaf.path.join(".")} where the schema is nullable`;
        const mutated = withPath(block, leaf.path, null);
        if (MessageBlock.safeParse(mutated).success) {
          padEntries.push({ why, block: mutated, expected: assertAccepted(why, mutated) });
        }
      }
      // A value outside an enum: the tables Go keeps beside its parsers can go stale even when
      // every declared field is present.
      if (Array.isArray(leaf.schema.enum)) {
        const why = `a value outside the enum at ${leaf.path.join(".")}`;
        const mutated = withPath(block, leaf.path, "__probe__");
        assertRefused(why, mutated);
        refusals.push({ why, block: mutated });
      }
      if ("const" in leaf.schema) {
        const expected = leaf.schema.const;
        const other = typeof expected === "boolean" ? !expected : typeof expected === "number" ? expected + 1 : `${expected}-probe`;
        const why = `a value other than the literal at ${leaf.path.join(".")}`;
        const mutated = withPath(block, leaf.path, other);
        assertRefused(why, mutated);
        refusals.push({ why, block: mutated });
      }
      // A padded string: when zod declares `.trim()`, `expected` holds the trimmed form, so a
      // parser that keeps the spaces shows up as a rewrite. Formats, patterns and enums are left
      // alone (their values are not free text).
      if (
        leafType === "string" &&
        !Array.isArray(leaf.schema.enum) &&
        !("const" in leaf.schema) &&
        !leaf.schema.format &&
        !leaf.schema.pattern
      ) {
        const value = (sample(root, leaf.schema) as string) || "x";
        const max = Number.isInteger(leaf.schema.maxLength) ? leaf.schema.maxLength : Infinity;
        if (value.length + 2 <= max) {
          const padded = ` ${value} `;
          const why = `a padded string at ${leaf.path.join(".")}`;
          const mutated = withPath(block, leaf.path, padded);
          if (MessageBlock.safeParse(mutated).success) {
            padEntries.push({ why, block: mutated, expected: assertAccepted(why, mutated) });
          }
        }
      }
    }

    for (const omission of omissionPaths) {
      const mutated = withoutPath(block, omission.path);
      if (MessageBlock.safeParse(mutated).success) {
        omissionEntries.push({
          path: omission.path,
          why: omission.why,
          block: mutated,
          expected: assertAccepted(omission.why, mutated),
        });
      } else {
        refusals.push({ why: `${omission.why} (a refinement rejects it)`, block: mutated });
      }
    }

    const required: Path[] = [];
    requiredPaths(root, variant, [], required);
    for (const path of required) {
      const why = `omitting required ${path.join(".")}`;
      const mutated = withoutPath(block, path);
      assertRefused(why, mutated);
      refusals.push({ why, block: mutated });
    }

    for (const refinement of refinements[block.kind as string] ?? []) {
      const mutated = clone(block);
      refinement.mutate(mutated);
      assertRefused(refinement.why, mutated);
      refusals.push({ why: refinement.why, block: mutated });
    }

    const acceptEntries = [
      ...(acceptances[block.kind as string] ?? []).map((acceptance) => {
        const mutated = clone(block);
        acceptance.mutate(mutated);
        return { why: acceptance.why, block: mutated, expected: assertAccepted(acceptance.why, mutated) };
      }),
      ...padEntries,
    ];

    return {
      kind: block.kind,
      block,
      expected,
      probes: probeEntries,
      omissions: omissionEntries,
      refusals,
      accepts: acceptEntries,
    };
  }),
};

process.stdout.write(JSON.stringify(fixture) + "\n");
