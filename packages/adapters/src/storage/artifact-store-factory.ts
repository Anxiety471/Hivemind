import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  ArtifactStreamOptions,
  ArtifactStreamPut,
  ObjectStorage,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  contentEncryptionOf,
  isSealedArtifact,
  openArtifact,
  openArtifactRange,
  sealArtifact,
} from "@rakazo/db";
import type { ArtifactKeys } from "./artifacts.js";
import { LocalArtifactStore } from "./artifacts.js";
import { createObjectStorage } from "./create-object-storage.js";

const OBJECT_ID = /^object:([0-9a-f-]{36})$/;

async function* once(bytes: Uint8Array) {
  yield bytes;
}

/** Object contents are always sealed, even when plaintext database writes are enabled. */
export class ObjectArtifactStore implements ArtifactStore {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly keys: ArtifactKeys,
  ) {}

  describe() {
    return {
      id: "object-artifacts",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: true },
    };
  }

  private key(id: string, spaceId: string) {
    const match = OBJECT_ID.exec(id);
    if (!match || !spaceId || spaceId.includes("/") || spaceId.includes("\\"))
      throw new Error("Invalid artifact storage key");
    return `artifacts/${spaceId}/${match[1]}`;
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    context.signal.throwIfAborted();
    const id = `object:${randomUUID()}`;
    const key = await this.keys.current(context.spaceId);
    await this.storage.put(
      this.key(id, context.spaceId),
      sealArtifact(key, id, Readable.from([artifact.bytes])),
    );
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext) {
    context.signal.throwIfAborted();
    const bytes = await buffer(
      openArtifact(
        async (keyId) => {
          const key = await this.keys.byId(keyId);
          if (key.spaceId !== context.spaceId)
            throw new ContentDecryptionError("Encrypted artifact belongs to another space");
          return key;
        },
        id,
        this.storage.get(this.key(id, context.spaceId)),
      ),
    );
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async putStream(artifact: ArtifactStreamPut, context: AdapterContext) {
    context.signal.throwIfAborted();
    const id = `object:${randomUUID()}`;
    const key = await this.keys.current(context.spaceId);
    const hasher = createHash("sha256");
    let size = 0;
    async function* metered(source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        context.signal.throwIfAborted();
        if (chunk.byteLength === 0) continue;
        size += chunk.byteLength;
        hasher.update(chunk);
        yield chunk;
      }
    }
    await this.storage.put(
      this.key(id, context.spaceId),
      sealArtifact(key, id, metered(artifact.stream)),
    );
    return { id, hash: hasher.digest("hex"), size };
  }

  async getStream(
    id: string,
    context: AdapterContext,
    options?: ArtifactStreamOptions,
  ): Promise<AsyncIterable<Uint8Array>> {
    context.signal.throwIfAborted();
    const keyFor = async (keyId: string) => {
      const key = await this.keys.byId(keyId);
      if (key.spaceId !== context.spaceId)
        throw new ContentDecryptionError("Encrypted artifact belongs to another space");
      return key;
    };
    const key = this.key(id, context.spaceId);
    const range = options?.range;
    if (!range) return openArtifact(keyFor, id, this.storage.get(key));
    if (!this.storage.getRange || !this.storage.stat) {
      // A store without ranged reads still answers correctly by decrypting the whole object.
      const bytes = await buffer(openArtifact(keyFor, id, this.storage.get(key)));
      return once(bytes.subarray(range.start, Math.min(range.endInclusive + 1, bytes.length)));
    }
    const info = await this.storage.stat(key);
    if (!info) throw Object.assign(new Error("Artifact object is missing"), { code: "ENOENT" });
    const head = await buffer(
      this.storage.getRange(key, 0, Math.min(511, Math.max(0, info.size - 1))),
    );
    if (!isSealedArtifact(head))
      return this.storage.getRange(key, range.start, Math.min(range.endInclusive, info.size - 1));
    // Objects are sealed by write, but a head that is not RKZA falls back to a plaintext range.
    return openArtifactRange(keyFor, id, head, info.size, range, (start, endInclusive) =>
      this.storage.getRange!(key, start, endInclusive),
    );
  }

  async remove(id: string, context: AdapterContext) {
    await this.storage.delete([this.key(id, context.spaceId)]);
  }
}

/** Explicit storage keys preserve access to pre-existing local files during migration. */
export class DeploymentArtifactStore implements ArtifactStore {
  constructor(
    private readonly local: ArtifactStore,
    private readonly object?: ArtifactStore,
  ) {}
  describe() {
    return (this.object ?? this.local).describe();
  }
  put(artifact: ArtifactPut, context: AdapterContext) {
    return (this.object ?? this.local).put(artifact, context);
  }
  putStream(artifact: ArtifactStreamPut, context: AdapterContext) {
    const target = this.object ?? this.local;
    if (target.putStream) return target.putStream(artifact, context);
    throw new Error("Streaming artifact store unavailable");
  }
  private forId(id: string): ArtifactStore {
    if (!id.startsWith("object:")) return this.local;
    if (!this.object) throw new Error("This artifact requires the configured object storage");
    return this.object;
  }
  async get(id: string, context: AdapterContext) {
    return this.forId(id).get(id, context);
  }
  getStream(id: string, context: AdapterContext, options?: ArtifactStreamOptions) {
    const target = this.forId(id);
    if (target.getStream) return target.getStream(id, context, options);
    const range = options?.range;
    return Promise.resolve(
      (async function* () {
        const bytes = await target.get(id, context);
        if (!range) {
          yield bytes;
          return;
        }
        yield bytes.subarray(range.start, Math.min(range.endInclusive + 1, bytes.byteLength));
      })(),
    );
  }
  async remove(id: string, context: AdapterContext) {
    return this.forId(id).remove(id, context);
  }
}

export function createArtifactStore(
  dataDir: string,
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStore {
  const keys = contentEncryptionOf(prisma)?.ring;
  const local = new LocalArtifactStore(dataDir, keys);
  const storage = createObjectStorage(env);
  if (!storage) return new DeploymentArtifactStore(local);
  if (!keys) throw new Error("Storing artifacts in object storage needs content encryption keys");
  return new DeploymentArtifactStore(local, new ObjectArtifactStore(storage, keys));
}
