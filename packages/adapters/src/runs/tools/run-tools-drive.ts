import { createHash } from "node:crypto";
import path from "node:path";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  attachmentSizeLabel,
  FILE_UPLOAD_MAX_BYTES,
  fileContentPath,
} from "@rakazo/contracts";
import {
  AttachmentValidationError,
  fileCategoryForMimeType,
  inferAttachmentMimeType,
  redactSecrets,
  validateDriveName,
} from "@rakazo/core";
import { withResolvedArtifactVersion, withTransactionRetry } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { resolveBotWorkspacePath } from "../../computers/screens/computer-support.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { artifactGroupId } from "./run-tools-files.js";

const DEFAULT_READ_BYTES = 65_536;
const MAX_READ_BYTES = 1_048_576;

function normalizeWorkspaceRelPath(raw: string): string | null {
  const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) return null;
  const normalized = path.posix.normalize(cleaned);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

export const driveTools: Record<string, ToolHandler> = {
  async drive_list(ctx, call) {
    const { deps, run } = ctx;
    const folderId =
      typeof call.args.folder_id === "string" && call.args.folder_id.trim()
        ? call.args.folder_id.trim()
        : undefined;
    const query =
      typeof call.args.query === "string" && call.args.query.trim()
        ? call.args.query.trim()
        : undefined;
    const category =
      typeof call.args.category === "string" && call.args.category.trim()
        ? call.args.category.trim()
        : "all";
    const rawLimit = Number(call.args.limit ?? 25);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 25;

    const folders = await deps.prisma.fileFolder.findMany({
      where: {
        spaceId: run.spaceId,
        trashedAt: null,
        ...(folderId ? { parentId: folderId } : query ? {} : { parentId: null }),
        ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
      },
      orderBy: [{ name: "asc" }],
      take: 50,
      select: { id: true, parentId: true, name: true, updatedAt: true },
    });

    const candidates = await deps.prisma.artifact.findMany({
      where: {
        spaceId: run.spaceId,
        trashedAt: null,
        ...(folderId ? { folderId } : {}),
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { description: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit * 3,
      select: {
        id: true,
        folderId: true,
        botId: true,
        source: true,
        name: true,
        description: true,
        mimeType: true,
        size: true,
        version: true,
        rootArtifactId: true,
        updatedAt: true,
      },
    });

    // Keep latest version per family matching listSpaceArtifacts / Go files.list.
    const seenFamilies = new Set<string>();
    const files: Array<{
      id: string;
      folderId: string | null;
      botId: string | null;
      source: string;
      name: string;
      description: string | null;
      mimeType: string;
      size: number;
      version: number;
      updatedAt: string;
    }> = [];
    for (const row of candidates) {
      const fam = row.rootArtifactId ?? row.id;
      if (seenFamilies.has(fam)) continue;
      seenFamilies.add(fam);
      if (category !== "all" && fileCategoryForMimeType(row.mimeType) !== category) continue;
      files.push({
        id: row.id,
        folderId: row.folderId,
        botId: row.botId,
        source: row.source,
        name: row.name,
        description: row.description,
        mimeType: row.mimeType,
        size: row.size,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      });
      if (files.length >= limit) break;
    }

    return call.finish({
      folders: folders.map((f) => ({
        id: f.id,
        parentId: f.parentId,
        name: f.name,
        updatedAt: f.updatedAt.toISOString(),
      })),
      files,
    });
  },

  async drive_read(ctx, call) {
    const { deps, run, bot, context } = ctx;
    if (!deps.artifacts) return call.finish({ error: "artifact storage unavailable" });
    const fileId = typeof call.args.file_id === "string" ? call.args.file_id.trim() : "";
    if (!fileId) return call.finish({ error: "file_id is required" });

    const row = await deps.prisma.artifact.findFirst({
      where: { id: fileId, spaceId: run.spaceId, trashedAt: null },
      select: {
        id: true,
        name: true,
        mimeType: true,
        size: true,
        storageKey: true,
        folderId: true,
        version: true,
      },
    });
    if (!row) return call.finish({ error: "File not found in Space Drive" });

    const saveRelRaw =
      typeof call.args.save_to_workspace === "string" ? call.args.save_to_workspace : "";
    if (saveRelRaw.trim()) {
      const rel = normalizeWorkspaceRelPath(saveRelRaw);
      if (!rel) return call.finish({ error: "Invalid save_to_workspace path" });
      try {
        const bytes = await deps.artifacts.get(row.storageKey, context);
        const computer = await ctx.computer.get("tool", call.name);
        const workspacePath = resolveBotWorkspacePath(ctx.computer.mode, bot.id, rel);
        await deps.sandbox.writeFile(computer, { path: workspacePath, content: bytes }, context);
        return call.finish({
          ok: true,
          fileId: row.id,
          name: row.name,
          mimeType: row.mimeType,
          size: bytes.byteLength,
          savedTo: rel,
        });
      } catch (error) {
        return call.finish({
          error: error instanceof Error ? error.message : "Could not copy Drive file to workspace",
        });
      }
    }

    const rawMax = Number(call.args.max_bytes ?? DEFAULT_READ_BYTES);
    const maxBytes = Number.isFinite(rawMax)
      ? Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(rawMax)))
      : DEFAULT_READ_BYTES;

    try {
      const chunks: Buffer[] = [];
      let collected = 0;
      let truncated = false;
      if (deps.artifacts.getStream) {
        const stream = await deps.artifacts.getStream(row.storageKey, context);
        for await (const chunk of stream) {
          const remaining = maxBytes - collected;
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          if (chunk.byteLength > remaining) {
            chunks.push(Buffer.from(chunk.subarray(0, remaining)));
            collected += remaining;
            truncated = true;
            break;
          }
          chunks.push(Buffer.from(chunk));
          collected += chunk.byteLength;
        }
      } else {
        const all = await deps.artifacts.get(row.storageKey, context);
        truncated = all.byteLength > maxBytes;
        chunks.push(Buffer.from(all.subarray(0, maxBytes)));
      }
      const bytes = Buffer.concat(chunks);
      const hasNull = bytes.includes(0);
      const category = fileCategoryForMimeType(row.mimeType);
      if (
        hasNull ||
        category === "video" ||
        category === "audio" ||
        category === "archive" ||
        row.mimeType === "application/pdf"
      ) {
        return call.finish({
          fileId: row.id,
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          binary: true,
          note: "Binary media or document; pass save_to_workspace to copy it into your computer workspace.",
        });
      }
      const text = redactSecrets(
        new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        ctx.secrets,
      );
      return call.finish({
        fileId: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        truncated: truncated || row.size > bytes.byteLength,
        content: text,
      });
    } catch (error) {
      return call.finish({
        error: error instanceof Error ? error.message : "Could not read Space Drive file",
      });
    }
  },

  async drive_save(ctx, call) {
    const { deps, run, bot, context } = ctx;
    if (!deps.artifacts) return call.finish({ error: "artifact storage unavailable" });

    let name: string;
    try {
      name = validateDriveName(String(call.args.name ?? ""));
    } catch (error) {
      return call.finish({
        error: error instanceof AttachmentValidationError ? error.message : "Invalid file name",
      });
    }

    const reportedMime = typeof call.args.mime_type === "string" ? call.args.mime_type : undefined;
    const mimeType = inferAttachmentMimeType(name, reportedMime);
    if (!mimeType) {
      return call.finish({ error: `Unsupported or blocked file type for ${name}` });
    }

    const folderId =
      typeof call.args.folder_id === "string" && call.args.folder_id.trim()
        ? call.args.folder_id.trim()
        : null;
    if (folderId) {
      const folder = await deps.prisma.fileFolder.findFirst({
        where: { id: folderId, spaceId: run.spaceId, trashedAt: null },
        select: { id: true },
      });
      if (!folder) return call.finish({ error: "Destination folder not found" });
    }

    const maxBytes =
      deps.maxFileUploadSizeBytes ??
      Math.max(deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES, FILE_UPLOAD_MAX_BYTES);
    let bytes: Uint8Array;
    if (typeof call.args.workspace_path === "string" && call.args.workspace_path.trim()) {
      const rel = normalizeWorkspaceRelPath(call.args.workspace_path);
      if (!rel) return call.finish({ error: "Invalid workspace_path" });
      try {
        bytes = await deps.sandbox.readFile(
          await ctx.computer.get("tool", call.name),
          resolveBotWorkspacePath(ctx.computer.mode, bot.id, rel),
          context,
          { maxBytes },
        );
      } catch (error) {
        return call.finish({
          error:
            error instanceof Error
              ? error.message
              : `Could not read workspace file within ${attachmentSizeLabel(maxBytes)}`,
        });
      }
    } else if (typeof call.args.content === "string") {
      bytes = new TextEncoder().encode(call.args.content);
      if (bytes.byteLength > maxBytes) {
        return call.finish({ error: `Content exceeds ${attachmentSizeLabel(maxBytes)} limit` });
      }
    } else {
      return call.finish({ error: "Provide either workspace_path or content" });
    }

    const description =
      typeof call.args.description === "string" && call.args.description.trim()
        ? call.args.description.trim().slice(0, ARTIFACT_DESCRIPTION_MAX_LENGTH)
        : null;
    const groupId = await artifactGroupId(ctx);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const stored = await deps.artifacts.put({ name, mimeType, bytes }, context);

    try {
      const row = await withTransactionRetry(() =>
        withResolvedArtifactVersion(
          deps.prisma,
          {
            spaceId: run.spaceId,
            folderId,
            botId: bot.id,
            groupId,
            name,
          },
          (tx, { rootArtifactId, version }) =>
            tx.artifact.create({
              data: {
                spaceId: run.spaceId,
                userId: run.userId,
                botId: bot.id,
                groupId,
                folderId,
                runId: run.id,
                source: "bot",
                name,
                description,
                mimeType,
                size: bytes.byteLength,
                hash,
                storageKey: stored.id,
                rootArtifactId,
                version,
              },
            }),
        ),
      );
      await bestEffort(
        "drive_save space change",
        Promise.resolve(deps.events.publishSpaceChange?.(run.spaceId, "files")),
      );
      return call.finish({
        ok: true,
        fileId: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        folderId: row.folderId,
        version: row.version,
        contentUrl: fileContentPath(row.id),
      });
    } catch (error) {
      await bestEffort("drive_save cleanup orphan blob", deps.artifacts.remove(stored.id, context));
      return call.finish({
        error: error instanceof Error ? error.message : "Could not save file to Space Drive",
      });
    }
  },
};
