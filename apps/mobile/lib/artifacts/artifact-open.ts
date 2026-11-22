import { t } from "@lingui/core/macro";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Image } from "react-native";
import type { ApiRequestContext } from "../api/api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../api/api";
import { currentSessionGeneration, loadSessionToken } from "../api/session";
import { fileContentUrl } from "../files/file-upload";
import type { ImageSize } from "../messages/inline-image";
import { createKeyedPromiseCache } from "../messages/inline-image";
import { artifactCacheSession } from "./artifact-cache-session";
import { artifactCacheFileName, artifactShareFileName } from "./artifact-file";
import { ARTIFACT_DOWNLOAD_TIMEOUT_MS } from "./artifacts";

/** Text and code previews read at most this much, so a large log cannot freeze the screen. */
export const TEXT_PREVIEW_MAX_BYTES = 100_000;

export type MobileArtifactTarget = { botId: string } | { groupId: string };

type ArtifactTarget = MobileArtifactTarget | null;

type ArtifactScope = {
  context: ApiRequestContext;
  generation: number;
  selectionId: string | null;
  namespace: string;
  userId: string;
};
let identity: { key: string; scope: Promise<ArtifactScope> } | undefined;

function assertCurrent(scope: ArtifactScope): void {
  if (
    scope.generation !== currentSessionGeneration() ||
    scope.context.apiBase !== currentApiBase() ||
    scope.selectionId !== selectedSpaceId()
  ) {
    throw new Error("Artifact session changed");
  }
}

function artifactScope(): Promise<ArtifactScope> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const selectionId = selectedSpaceId();
  const key = JSON.stringify([apiBase, generation, selectionId]);
  if (identity?.key === key) return identity.scope;
  imageArtifactUris.clear();
  imageArtifactSizes.clear();
  imageArtifactRequests.clear();
  const scope = (async () => {
    const context = await captureApiRequestContext();
    const token = await loadSessionToken();
    if (
      apiBase !== context.apiBase ||
      generation !== currentSessionGeneration() ||
      selectionId !== selectedSpaceId()
    )
      throw new Error("Artifact session changed");
    const me = await rpc("me", {}, { requestContext: context });
    if (generation !== currentSessionGeneration()) throw new Error("Artifact session changed");
    if (!me.userId) throw new Error("Missing artifact owner");
    const result = {
      context,
      generation,
      selectionId,
      userId: me.userId,
      namespace: await artifactCacheSession(token),
    };
    assertCurrent(result);
    return result;
  })();
  const entry = { key, scope };
  identity = entry;
  void scope.catch(() => {
    if (identity === entry) identity = undefined;
  });
  return scope;
}

function requestKey(target: ArtifactTarget, artifactId: string, mimeType: string): string {
  const scope = target
    ? "botId" in target
      ? `bot:${target.botId}`
      : `group:${target.groupId}`
    : "space";
  return JSON.stringify([scope, artifactId, mimeType]);
}

/**
 * A server that predates the streaming content route answers it with a 404. Expo's download
 * error names the status on both platforms, which is the only signal it gives.
 */
function contentEndpointMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /response has (?:status|n)[:\s]+404\b/i.test(message) || /\bHTTP 404\b/.test(message);
}

function cachedArtifactFile(scope: ArtifactScope, target: ArtifactTarget, artifactId: string, mimeType: string) {
  const root = new Directory(
    Paths.cache,
    "artifact-previews",
    scope.namespace,
    `endpoint-${encodeURIComponent(scope.context.apiBase)}`,
    `user-${encodeURIComponent(scope.userId)}`,
    `target-${encodeURIComponent(
      target ? ("botId" in target ? `bot:${target.botId}` : `group:${target.groupId}`) : "space",
    )}`,
    `artifact-${encodeURIComponent(artifactId)}`,
    `mime-${encodeURIComponent(mimeType)}`,
  );
  if (!root.exists) root.create({ intermediates: true });
  const file = new File(root, artifactCacheFileName(artifactId, mimeType));
  return { file, metadata: new File(root, `${file.name}.json`) };
}

async function cacheMobileArtifact(
  target: ArtifactTarget,
  artifactId: string,
  mimeType: string,
  cachedScope?: ArtifactScope,
): Promise<File> {
  const scope = cachedScope ?? (await artifactScope());
  assertCurrent(scope);
  const key = requestKey(target, artifactId, mimeType);
  const { file, metadata } = cachedArtifactFile(scope, target, artifactId, mimeType);
  if (file.exists && metadata.exists) {
    try {
      if (JSON.parse(metadata.textSync()).key === key) return file;
    } catch {
      // A corrupt sidecar is a cache miss.
    }
  }
  // Invalidate first so an interrupted overwrite cannot leave valid metadata for wrong bytes.
  if (metadata.exists) metadata.delete();
  try {
    await File.downloadFileAsync(
      fileContentUrl(artifactId, {
        apiBase: scope.context.apiBase,
        spaceId: scope.selectionId,
      }),
      file,
      { idempotent: true, headers: scope.context.headers },
    );
  } catch (error) {
    if (!target || !contentEndpointMissing(error)) throw error;
    // Older servers still serve artifact bytes through the chat attachment RPC.
    const artifact = await rpc(
      "artifacts/get",
      { ...target, artifactId },
      { timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS, requestContext: scope.context },
    );
    assertCurrent(scope);
    file.create({ overwrite: true });
    file.writeSync(artifact.contentBase64, { encoding: "base64" });
  }
  assertCurrent(scope);
  metadata.create({ overwrite: true });
  metadata.writeSync(JSON.stringify({ key }));
  return file;
}

/** Reads at most `maxBytes` of a text file so a large log cannot reach the view whole. */
export async function readBoundedText(
  file: File,
  maxBytes = TEXT_PREVIEW_MAX_BYTES,
): Promise<string> {
  if (file.size <= maxBytes) return file.text();
  const handle = file.open(FileMode.ReadOnly);
  try {
    const bytes = await handle.readBytes(maxBytes);
    return `${new TextDecoder().decode(bytes)}\n…`;
  } finally {
    handle.close();
  }
}

/** An artifact's text, read through the same authenticated, session-scoped cache. */
export async function textMobileArtifact(
  target: ArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  return readBoundedText(await cacheMobileArtifact(target, artifactId, mimeType));
}

/** The artifact's bytes as a local file, downloaded through the streaming content route. */
export async function downloadMobileArtifact(
  target: ArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<File> {
  return cacheMobileArtifact(target, artifactId, mimeType);
}

/** Local playback URI using the same authenticated, session-scoped artifact cache. */
export async function audioArtifactUri(
  target: ArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  return (await cacheMobileArtifact(target, artifactId, mimeType)).uri;
}

export async function openMobileArtifact(
  target: ArtifactTarget,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const file = await cacheMobileArtifact(target, artifactId, mimeType);
  await shareNamedFile(file, mimeType, name);
}

const imageArtifactUris = createKeyedPromiseCache<string>(async (key) => {
  const request = imageArtifactRequests.get(key);
  if (!request) throw new Error("unknown image artifact");
  const file = await cacheMobileArtifact(
    request.target,
    request.artifactId,
    request.mimeType,
    request.scope,
  );
  return file.uri;
});
const imageArtifactRequests = new Map<
  string,
  { target: ArtifactTarget; artifactId: string; mimeType: string; scope: ArtifactScope }
>();

/**
 * Local file URI of an image artifact, downloaded through the authenticated streaming route and
 * cached on disk. Concurrent callers (every bubble showing the same image) share one download.
 */
export async function imageArtifactUri(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const scope = await artifactScope();
  assertCurrent(scope);
  const key = JSON.stringify([
    scope.context.apiBase,
    scope.userId,
    scope.namespace,
    scope.generation,
    requestKey(target, artifactId, mimeType),
  ]);
  imageArtifactRequests.set(key, { target, artifactId, mimeType, scope });
  const entry = imageArtifactUris.get(key);
  const uri = await entry;
  assertCurrent(scope);
  if (new File(uri).exists) return uri;
  imageArtifactUris.forget(key, entry);
  const refreshed = await imageArtifactUris.get(key);
  assertCurrent(scope);
  return refreshed;
}

// Natural dimensions share the URI cache's session lifetime; fitted sizes stay per layout.
const imageArtifactSizes = createKeyedPromiseCache<ImageSize>(
  (uri) =>
    new Promise((resolve, reject) => {
      Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
    }),
);

export async function imageArtifactPreview(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<{ uri: string; size: ImageSize }> {
  const scope = await artifactScope();
  const uri = await imageArtifactUri(target, artifactId, mimeType);
  assertCurrent(scope);
  const size = await imageArtifactSizes.get(uri);
  assertCurrent(scope);
  return { uri, size };
}

/** Share a file already on disk (for example an image the viewer is showing) without downloading it again. */
export async function shareLocalFile(uri: string, mimeType: string, name: string): Promise<void> {
  await shareNamedFile(new File(uri), mimeType, name);
}

async function shareNamedFile(source: File, mimeType: string, name: string): Promise<void> {
  const root = new Directory(Paths.cache, "artifact-shares");
  if (!root.exists) root.create();
  const dir = new Directory(root, source.name || "attachment");
  if (!dir.exists) dir.create();
  const shared = new File(dir, artifactShareFileName(name, mimeType));
  source.copySync(shared, { overwrite: true });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(shared.uri, { mimeType });
    return;
  }
  throw new Error(t`Saved ${name} locally`);
}
