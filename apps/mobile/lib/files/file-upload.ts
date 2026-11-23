import type { Artifact, DriveFile, FileSource } from "@rakazo/contracts";
import { attachmentMaxBytes, DriveFileSchema, fileContentPath } from "@rakazo/contracts";
import { Directory, File, Paths } from "expo-file-system";
import type { ApiRequestContext } from "../api/api";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "../api/api";
import { fetchServer } from "../api/server-headers";

export type MobileFileUpload = {
  uri?: string;
  name: string;
  mimeType: string;
  /** Known before the upload when the picker supplied it; the server enforces its own limit. */
  size?: number;
  folderId?: string | null;
  botId?: string;
  groupId?: string;
  source?: FileSource;
  description?: string;
  clientNonce?: string;
  /** Already read bytes; written to a staging file when there is no `uri`. */
  contentBase64?: string;
  /** A Space other than the selected one, for a queued send restored under its own Space. */
  spaceId?: string | null;
  /** The request the send was started with, so an upload cannot land in another session. */
  context?: ApiRequestContext;
  signal?: AbortSignal;
};

/**
 * A file's content as a native player or the share sheet opens it. The Space is in the query
 * too, so a URL used outside this app's fetch still authorizes.
 */
export function fileContentUrl(
  artifactId: string,
  {
    spaceId = selectedSpaceId(),
    download = false,
    apiBase = currentApiBase(),
  }: { spaceId?: string | null; download?: boolean; apiBase?: string } = {},
): string {
  const url = new URL(`${apiBase}${fileContentPath(artifactId)}`);
  if (spaceId) url.searchParams.set("spaceId", spaceId);
  if (download) url.searchParams.set("download", "1");
  return url.toString();
}

/**
 * The metadata parts of a Drive upload, in the order the server reads them. The file part goes
 * last: the Go server reads the multipart body once, so fields that arrive after the bytes are
 * never looked at.
 */
export function uploadFormFields(input: MobileFileUpload): Array<[string, string]> {
  return [
    ["folderId", input.folderId ?? ""],
    ["botId", input.botId ?? ""],
    ["groupId", input.groupId ?? ""],
    ["source", input.source ?? "upload"],
    ["name", input.name],
    ["description", input.description ?? ""],
    ["mimeType", input.mimeType],
    ["clientNonce", input.clientNonce ?? ""],
  ];
}

function artifactAsDriveFile(artifact: Artifact): DriveFile {
  return {
    id: artifact.id,
    botId: artifact.botId,
    groupId: artifact.groupId,
    runId: artifact.runId,
    folderId: null,
    source: artifact.botId || artifact.groupId ? "chat" : "upload",
    name: artifact.name,
    slug: null,
    description: artifact.description,
    mimeType: artifact.mimeType,
    size: artifact.size,
    hash: "",
    version: artifact.version,
    versionCount: 1,
    trashedAt: null,
    createdAt: artifact.createdAt,
    updatedAt: artifact.createdAt,
    contentUrl: fileContentPath(artifact.id),
  };
}

async function throwUploadFailure(response: Response): Promise<never> {
  let message = "";
  try {
    const body = (await response.json()) as {
      message?: unknown;
      json?: { message?: unknown };
    };
    const detail = body.json?.message ?? body.message;
    if (typeof detail === "string") message = detail;
  } catch {
    // A proxy or an older server may answer with something other than the error envelope.
  }
  throw Object.assign(new Error(message || "Upload failed"), { status: response.status });
}

/** Bytes a base64-only server can accept; a file past its limit is refused before it is read. */
async function readFallbackBase64(
  uri: string,
  size: number | undefined,
  maxBytes: number,
): Promise<string> {
  const known = size ?? new File(uri).info().size ?? 0;
  if (known > maxBytes) {
    throw Object.assign(new Error("This file is too large for this server"), { status: 413 });
  }
  return new File(uri).base64();
}

/** A server that predates streaming uploads still accepts its chat attachment RPC. */
async function uploadThroughChatRpc(
  input: MobileFileUpload,
  uri: string | undefined,
  context: ApiRequestContext,
): Promise<DriveFile> {
  const target = input.groupId
    ? { groupId: input.groupId }
    : input.botId
      ? { botId: input.botId }
      : null;
  if (!target)
    throw Object.assign(new Error("This server cannot store files yet"), { status: 404 });
  const contentBase64 =
    input.contentBase64 ||
    (uri ? await readFallbackBase64(uri, input.size, attachmentMaxBytes()) : "");
  if (!contentBase64) throw new Error("Could not read this file");
  const artifact = await rpc(
    "artifacts/create",
    {
      ...target,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      mimeType: input.mimeType,
      contentBase64,
      clientNonce: input.clientNonce,
    },
    { requestContext: context },
  );
  return artifactAsDriveFile(artifact);
}

/** A temporary file for bytes already in memory; deleted once the upload settles. */
function stageBase64(contentBase64: string, name: string): File {
  const directory = new Directory(Paths.cache, "file-uploads");
  if (!directory.exists) directory.create({ intermediates: true });
  const file = new File(directory, `${Date.now()}-${name.replace(/[^\w.-]+/g, "_")}`);
  file.create({ overwrite: true });
  file.writeSync(contentBase64, { encoding: "base64" });
  return file;
}

/**
 * Streams a file to the Space Drive. A server without `/api/v1/files` falls back to the base64
 * chat attachment RPC, which only accepts chat attachments within that older limit.
 */
export async function uploadMobileFile(input: MobileFileUpload): Promise<DriveFile> {
  const context = input.context ?? (await captureApiRequestContext(input.spaceId));
  let staged: File | undefined;
  let uri = input.uri;
  if (!uri && input.contentBase64) {
    staged = stageBase64(input.contentBase64, input.name);
    uri = staged.uri;
  }
  if (!uri) throw new Error("Could not read this file");
  const form = new FormData();
  for (const [field, value] of uploadFormFields(input)) form.append(field, value);
  form.append("file", {
    uri,
    name: input.name,
    type: input.mimeType,
  } as unknown as Blob);
  try {
    const response = await fetchServer(
      `${context.apiBase}/api/v1/files`,
      {
        method: "POST",
        headers: { origin: "rakazo://", ...context.headers },
        body: form,
        signal: input.signal,
      },
      context.apiBase,
    );
    if (response.status === 404) {
      return await uploadThroughChatRpc(input, uri, context);
    }
    if (!response.ok) await throwUploadFailure(response);
    const parsed = DriveFileSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Upload failed");
    return parsed.data;
  } finally {
    if (staged) {
      try {
        staged.delete();
      } catch {
        // A staging file left behind is cleared by the cache directory on a later run.
      }
    }
  }
}
