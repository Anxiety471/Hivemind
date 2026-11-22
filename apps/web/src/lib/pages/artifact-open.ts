import { fileContentUrl } from "../files/file-client";

export type ArtifactTarget = { botId: string } | { groupId: string };

/** Text and code previews read at most this much, so a large log cannot freeze the page. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export function decodeArtifactBase64(contentBase64: string): Uint8Array {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Reads a file through its streaming content URL; `maxBytes` asks the server for a prefix. */
export async function fetchArtifactBytes(
  artifactId: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes;
  const response = await fetch(fileContentUrl(artifactId), {
    credentials: "include",
    signal: options.signal,
    headers: maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : undefined,
  });
  if (!response.ok) throw new Error(`Could not load this file (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export function downloadArtifactBytes(name: string, mimeType: string, bytes: Uint8Array): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Downloads through the content URL, so a large file streams instead of loading in memory. */
export function downloadArtifact(artifactId: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = fileContentUrl(artifactId, { download: true });
  anchor.download = name;
  anchor.click();
}
