import type { DriveFile, FileSource } from "@rakazo/contracts";
import { fileContentPath } from "@rakazo/contracts";
import { inferAttachmentMimeType, isUnreachableStatus, parseRetryAfter } from "@rakazo/core";
import { getMaxUploadSizeBytes } from "../bootstrap";
import { noteServerReachable } from "../query/connection-state";
import { rpc, selectedSpaceId } from "../query/rpc";

export type UploadedDriveFile = Pick<DriveFile, "id" | "name" | "mimeType" | "size">;

/**
 * The streaming file URL; media elements cannot send the Space header, so it rides in the query.
 * It defaults to the selected Space, which is where every thread, reply and peer transcript on
 * screen lives; pass `spaceId` explicitly only for a file rendered from another Space.
 */
export function fileContentUrl(
  artifactId: string,
  options: { spaceId?: string | null; download?: boolean } = {},
): string {
  const spaceId = options.spaceId === undefined ? selectedSpaceId() : options.spaceId;
  const query = new URLSearchParams();
  if (spaceId) query.set("spaceId", spaceId);
  if (options.download) query.set("download", "1");
  const search = query.toString();
  return `${fileContentPath(artifactId)}${search ? `?${search}` : ""}`;
}

function uploadError(xhr: XMLHttpRequest): Error {
  const fallback = xhr.status ? `Upload failed (${xhr.status})` : "Upload failed";
  const meta: PropertyDescriptorMap = {};
  if (xhr.status > 0) meta.status = { value: xhr.status, writable: true, configurable: true };
  const retryAfterMs = parseRetryAfter(xhr.getResponseHeader("retry-after"));
  if (retryAfterMs !== undefined)
    meta.retryAfterMs = { value: retryAfterMs, writable: true, configurable: true };
  try {
    const body = JSON.parse(xhr.responseText) as { json?: { message?: unknown } };
    const message = body.json?.message;
    return Object.defineProperties(
      new Error(typeof message === "string" && message ? message : fallback),
      meta,
    );
  } catch {
    return Object.defineProperties(new Error(fallback), meta);
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? (result.split(",")[1] ?? "") : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function appendField(form: FormData, name: string, value: string | null | undefined) {
  if (value) form.append(name, value);
}

/**
 * Uploads one file through the streaming Drive endpoint. Metadata parts go before the file
 * part because the Go server reads the multipart body once, in order.
 */
export function uploadSpaceFile({
  file,
  folderId,
  botId,
  groupId,
  source = "upload",
  description,
  clientNonce,
  spaceId,
  onProgress,
  signal,
}: {
  file: File;
  folderId?: string | null;
  botId?: string;
  groupId?: string;
  source?: FileSource;
  description?: string;
  clientNonce?: string;
  /** The Space the file belongs to; defaults to the selected one. */
  spaceId?: string | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<UploadedDriveFile> {
  const mimeType = inferAttachmentMimeType(file.name, file.type);
  if (!mimeType) return Promise.reject(new Error(`Unsupported file type: ${file.name}`));
  const targetSpaceId = spaceId === undefined ? selectedSpaceId() : spaceId;
  return new Promise<UploadedDriveFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    appendField(form, "folderId", folderId);
    appendField(form, "botId", botId);
    appendField(form, "groupId", groupId);
    appendField(form, "source", source);
    appendField(form, "name", file.name);
    appendField(form, "description", description);
    appendField(form, "mimeType", mimeType);
    appendField(form, "clientNonce", clientNonce);
    form.append("file", file, file.name);

    const abort = () => xhr.abort();
    const settle = () => signal?.removeEventListener("abort", abort);
    xhr.open("POST", "/api/v1/files");
    xhr.withCredentials = true;
    xhr.timeout = 60_000;
    if (targetSpaceId) xhr.setRequestHeader("x-rakazo-space-id", targetSpaceId);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => {
      settle();
      if (!signal?.aborted) noteServerReachable(false);
      reject(new Error("Upload failed", { cause: new TypeError("Failed to fetch") }));
    };
    xhr.ontimeout = () => {
      settle();
      if (!signal?.aborted) noteServerReachable(false);
      // A DOMException counts as an Error only in some realms, so name a plain Error instead.
      reject(
        Object.defineProperty(new Error("Upload timed out"), "name", { value: "TimeoutError" }),
      );
    };
    xhr.onabort = () => {
      settle();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    xhr.onload = () => {
      settle();
      noteServerReachable(!isUnreachableStatus(xhr.status));
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedDriveFile);
        } catch {
          reject(new Error("Upload failed"));
        }
        return;
      }
      // Servers without the streaming endpoint keep the older base64 artifact upload.
      if (xhr.status === 404 && (botId || groupId) && file.size <= getMaxUploadSizeBytes()) {
        void readFileAsBase64(file)
          .then((contentBase64) =>
            rpc.artifacts.create(
              groupId
                ? { groupId, name: file.name, mimeType, contentBase64, clientNonce }
                : { botId: botId!, name: file.name, mimeType, contentBase64, clientNonce },
              { context: { spaceId: targetSpaceId } },
            ),
          )
          .then((artifact) => resolve(artifact))
          .catch(reject);
        return;
      }
      reject(uploadError(xhr));
    };
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(form);
  });
}
