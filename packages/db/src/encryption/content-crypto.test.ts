import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DataKey } from "./content-crypto.js";
import {
  artifactKeyId,
  ContentDecryptionError,
  ciphertextKeyId,
  decryptText,
  encryptText,
  isSealedArtifact,
  jsonKeyIds,
  jsonNeedsSealing,
  openArtifact,
  openArtifactRange,
  openJson,
  querySearchTokens,
  sealArtifact,
  sealJson,
  searchTokens,
} from "./content-crypto.js";

const key: DataKey = { id: "key-1", spaceId: "space-1", version: 1, key: randomBytes(32) };
const location = { table: "messages", column: "blocks", rowId: "row-1", owner: "thread-1" };

async function* from(...chunks: Uint8Array[]) {
  yield* chunks;
}
async function collect(source: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

describe("content ciphertext", () => {
  it("round-trips with a fresh IV and names its key", () => {
    const first = encryptText(key, location, "hello");
    const second = encryptText(key, location, "hello");
    expect(first).not.toBe(second);
    expect(first.startsWith("rkz1:key-1:")).toBe(true);
    expect(ciphertextKeyId(first)).toBe("key-1");
    expect(decryptText(key, location, first)).toBe("hello");
  });

  it("fails authentication when moved to another table, column, row or space", () => {
    const sealed = encryptText(key, location, "hello");
    for (const moved of [
      { ...location, table: "events" },
      { ...location, column: "payload" },
      { ...location, rowId: "row-2" },
      { ...location, owner: "thread-2" },
    ])
      expect(() => decryptText(key, moved, sealed)).toThrow(ContentDecryptionError);
    expect(() => decryptText({ ...key, spaceId: "space-2" }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
  });

  it("detects tampering and wrong keys", () => {
    const sealed = encryptText(key, location, "hello");
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;
    expect(() => decryptText(key, location, flipped)).toThrow(ContentDecryptionError);
    expect(() => decryptText({ ...key, key: randomBytes(32) }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
    expect(() => decryptText({ ...key, id: "key-2" }, location, sealed)).toThrow(
      ContentDecryptionError,
    );
  });

  it("seals JSON per element and keeps plain keys queryable", () => {
    const blocks = [
      { kind: "text", text: "secret" },
      { kind: "channel_message", channelId: "c1", text: "also secret", hop: 2 },
    ];
    const sealed = sealJson(blocks, new Set(["kind", "channelId"]), (plaintext) =>
      encryptText(key, location, plaintext),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(sealed)).not.toContain("secret");
    expect(sealed[1]).toMatchObject({ kind: "channel_message", channelId: "c1" });
    expect(sealed[1]).not.toHaveProperty("hop");
    expect(jsonKeyIds(sealed)).toEqual(["key-1", "key-1"]);
    expect(jsonNeedsSealing(sealed)).toBe(false);
    expect(jsonNeedsSealing(blocks)).toBe(true);
    expect(jsonNeedsSealing([])).toBe(false);
    expect(openJson(sealed, (value) => decryptText(key, location, value))).toEqual(blocks);
  });

  it("reads plaintext JSON unchanged", () => {
    const payload = { messageId: "m1", $sealed: "not ciphertext" };
    expect(openJson(payload, () => "unused")).toBe(payload);
    expect(jsonKeyIds(payload)).toEqual([]);
  });
});

describe("blind index tokens", () => {
  it("matches words and prefixes without revealing them, per key", () => {
    const tokens = new Set(
      searchTokens(key, { words: "Ship the Pelican report", strings: ["Ship the Pelican report"] }),
    );
    for (const token of querySearchTokens(key, "pelican SHIP", "word"))
      expect(tokens.has(token)).toBe(true);
    for (const token of querySearchTokens(key, "peli rep", "prefix"))
      expect(tokens.has(token)).toBe(true);
    expect(querySearchTokens(key, "elican", "prefix").every((token) => tokens.has(token))).toBe(
      false,
    );
    expect(querySearchTokens(key, "x", "prefix")).toEqual([]);
    const other = querySearchTokens({ ...key, key: randomBytes(32) }, "pelican", "word");
    expect(tokens.has(other[0]!)).toBe(false);
  });

  it("only indexes history text as words", () => {
    const tokens = new Set(searchTokens(key, { words: "", strings: ["photo.png"] }));
    expect(tokens.has(querySearchTokens(key, "photo", "word")[0]!)).toBe(false);
    expect(tokens.has(querySearchTokens(key, "photo", "prefix")[0]!)).toBe(true);
  });
});

describe("artifact stream", () => {
  for (const size of [0, 1, 64 * 1024 - 1, 64 * 1024, 64 * 1024 * 2, 200_001]) {
    it(`round-trips ${size} bytes`, async () => {
      const bytes = randomBytes(size);
      const sealed = await collect(
        sealArtifact(key, "file-1", from(bytes.subarray(0, 7), bytes.subarray(7))),
      );
      expect(isSealedArtifact(sealed)).toBe(true);
      expect(artifactKeyId(sealed)).toBe("key-1");
      if (size > 32) expect(sealed.includes(bytes.subarray(0, 32))).toBe(false);
      // Odd-sized reads split the header and segments across chunk boundaries.
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < sealed.length; offset += 9_973)
        pieces.push(sealed.subarray(offset, offset + 9_973));
      pieces.unshift(sealed.subarray(0, 0));
      const opened = await collect(openArtifact(async () => key, "file-1", from(...pieces)));
      expect(opened.equals(bytes)).toBe(true);
    });
  }

  it("rejects truncation, splicing and the wrong file id", async () => {
    const bytes = randomBytes(64 * 1024 * 2 + 10);
    const sealed = await collect(sealArtifact(key, "file-1", from(bytes)));
    const open = (data: Buffer, fileId = "file-1") =>
      collect(openArtifact(async () => key, fileId, from(data)));
    await expect(open(sealed, "file-2")).rejects.toThrow(ContentDecryptionError);
    await expect(open(sealed.subarray(0, sealed.length - 30))).rejects.toThrow(
      ContentDecryptionError,
    );
    const header = sealed.length - (64 * 1024 + 16) * 2 - (10 + 16);
    await expect(open(sealed.subarray(0, header + 64 * 1024 + 16))).rejects.toThrow(
      ContentDecryptionError,
    );
    const swapped = Buffer.concat([
      sealed.subarray(0, header),
      sealed.subarray(header + 64 * 1024 + 16, header + 2 * (64 * 1024 + 16)),
      sealed.subarray(header, header + 64 * 1024 + 16),
      sealed.subarray(header + 2 * (64 * 1024 + 16)),
    ]);
    await expect(open(swapped)).rejects.toThrow(ContentDecryptionError);
  });

  it("does not treat plaintext as sealed", () => {
    expect(isSealedArtifact(Buffer.from("%PDF-1.7"))).toBe(false);
  });
});

describe("artifact range stream", () => {
  const size = 64 * 1024 * 3 + 123;

  async function sealedBytes(bytes: Buffer) {
    return collect(sealArtifact(key, "file-1", from(bytes)));
  }

  function rangeReader(bytes: Buffer) {
    const served: Array<{ start: number; end: number }> = [];
    const read = (start: number, end: number) => {
      served.push({ start, end });
      return from(bytes.subarray(start, end + 1));
    };
    return { read, served };
  }

  it("reads only the sealed segments a range touches", async () => {
    const bytes = randomBytes(size);
    const sealed = await sealedBytes(bytes);
    // Corrupt the first segment: a reader that starts at the file head would fail authentication.
    const corrupted = Buffer.from(sealed);
    corrupted[600] = corrupted[600]! ^ 0xff;
    const { read, served } = rangeReader(corrupted);
    const opened = await collect(
      openArtifactRange(
        async () => key,
        "file-1",
        corrupted.subarray(0, 512),
        corrupted.length,
        { start: 70_000, endInclusive: 70_100 },
        read,
      ),
    );
    expect(opened.equals(bytes.subarray(70_000, 70_101))).toBe(true);
    expect(served).toHaveLength(1);
    expect(served[0]!.start).toBe(19 + 65_552);
    await expect(collect(openArtifact(async () => key, "file-1", from(corrupted)))).rejects.toThrow(
      ContentDecryptionError,
    );
  });

  it("spans segment boundaries and verifies the final segment", async () => {
    const bytes = randomBytes(size);
    const sealed = await sealedBytes(bytes);
    const read = (start: number, end: number) => from(sealed.subarray(start, end + 1));
    for (const range of [
      { start: 0, endInclusive: 0 },
      { start: 65_535, endInclusive: 65_536 },
      { start: size - 1, endInclusive: size - 1 },
      { start: 0, endInclusive: size - 1 },
    ]) {
      const opened = await collect(
        openArtifactRange(
          async () => key,
          "file-1",
          sealed.subarray(0, 512),
          sealed.length,
          range,
          read,
        ),
      );
      expect(opened.equals(bytes.subarray(range.start, range.endInclusive + 1))).toBe(true);
    }

    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await expect(
      collect(
        openArtifactRange(
          async () => key,
          "file-1",
          tampered.subarray(0, 512),
          tampered.length,
          { start: size - 4, endInclusive: size - 1 },
          (start, end) => from(tampered.subarray(start, end + 1)),
        ),
      ),
    ).rejects.toThrow(ContentDecryptionError);
  });

  it("rejects out-of-bounds ranges and another file's id", async () => {
    const bytes = randomBytes(size);
    const sealed = await sealedBytes(bytes);
    const read = (start: number, end: number) => from(sealed.subarray(start, end + 1));
    await expect(
      collect(
        openArtifactRange(
          async () => key,
          "file-1",
          sealed.subarray(0, 512),
          sealed.length,
          { start: size - 2, endInclusive: size },
          read,
        ),
      ),
    ).rejects.toThrow(ContentDecryptionError);
    await expect(
      collect(
        openArtifactRange(
          async () => key,
          "file-2",
          sealed.subarray(0, 512),
          sealed.length,
          { start: 0, endInclusive: 10 },
          read,
        ),
      ),
    ).rejects.toThrow(ContentDecryptionError);
  });
});
