/**
 * Random-value registry for the contract harness.
 *
 * A digest, secret or code that one side derives from its own randomness genuinely differs from
 * the other side's, so the comparison has to mask it. Masking by *shape* alone is unsafe: every
 * 64-hex string used to become "<share-token-hash>", which also masked every deterministic
 * SHA-256 the API stores or returns (page share hashes, invite token hashes, push token digests,
 * content hashes). A Go procedure that wrote the wrong digest then passed the database-state
 * comparison.
 *
 * This module inverts the default. `normalize` masks a digest/secret/code only when a case check
 * first proved, on that side, that it was recomputed from a random source:
 *
 *   - `<sha256>`: a lowercase hex SHA-256 (the check recomputed it from the token/content);
 *   - `<random-secret>`: 32 random bytes as unpadded base64url (secrets and page share tokens);
 *   - `<link-code>`: a messaging link code, with or without its display hyphen.
 *
 * Every other value, including every 64-hex string nobody registered, compares exactly. A new
 * procedure that generates a random digest therefore fails the harness with an explicit hint
 * until its case adds the recomputation, instead of passing silently. `digestMismatchHint` names
 * the paths that differ.
 */
import { createHash } from "node:crypto";

export type Side = "ts" | "go";

export type Placeholder = "<sha256>" | "<random-secret>" | "<link-code>";

/** The wire shape each placeholder may mask. A check cannot register a value of another shape. */
const SHAPES: Record<Placeholder, RegExp> = {
  "<sha256>": /^[0-9a-f]{64}$/,
  "<random-secret>": /^[A-Za-z0-9_-]{43}$/,
  "<link-code>": /^(?:[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}|[A-HJKMNP-TV-Z2-9]{8})$/,
};

const verified: Record<Side, Map<string, Placeholder>> = { ts: new Map(), go: new Map() };

/**
 * Records that `value` is random on `side` and was recomputed from its source by the case's
 * check. Called only after the caller's assertions passed, so a wrong digest never gets here.
 */
export function registerVerified(side: Side, value: string, placeholder: Placeholder): void {
  if (!SHAPES[placeholder].test(value))
    throw new Error(
      `cannot register ${JSON.stringify(value)} as ${placeholder}: it does not have that shape`,
    );
  verified[side].set(value, placeholder);
}

/** The placeholder a check registered for this side, or undefined when the value must compare exactly. */
export function maskedVerified(side: Side, value: string): string | undefined {
  return verified[side].get(value);
}

/** Whether the value has the wire shape the placeholder masks (for checks whose input may be seeded text). */
export function hasShape(value: string, placeholder: Placeholder): boolean {
  return SHAPES[placeholder].test(value);
}

/** Clears both sides' registrations; the harness calls this once per case, before the first side runs. */
export function clearVerified(): void {
  verified.ts.clear();
  verified.go.clear();
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const DIGEST_SHAPES = Object.values(SHAPES);

/**
 * Names the paths where two normalized trees still hold shape-matching values that differ. Such a
 * value is either a deterministic digest one side got wrong, or a random value whose source has no
 * recomputation yet; either way it must not be papered over.
 */
export function digestMismatchHint(left: unknown, right: unknown, label: string): string {
  const paths: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (paths.length >= 12) return;
    if (typeof a === "string" && typeof b === "string") {
      if (a !== b && DIGEST_SHAPES.some((shape) => shape.test(a) && shape.test(b)))
        paths.push(`${path}: typescript=${a} go=${b}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const length = Math.min(a.length, b.length);
      for (let index = 0; index < length; index += 1) walk(a[index], b[index], `${path}[${index}]`);
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys)
        walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          path === "" ? key : `${path}.${key}`,
        );
    }
  };
  walk(left, right, "");
  if (paths.length === 0) return "";
  return `\n${label}: digest-shaped values differ (deterministic digests must match exactly; register a random one only after recomputing it from its source):\n  ${paths.join("\n  ")}`;
}
