import { createHash } from "node:crypto";
import path from "node:path";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  attachmentSizeLabel,
  FILE_UPLOAD_MAX_BYTES,
  fileContentPath,
} from "@rakazo/contracts";
import {
  AttachmentValidationError,
  fileCategoryForMimeType,
  inferAttachmentMimeType,
  normalizeFileSlug,
  redactSecrets,
  slugifyFileName,
  validateDriveName,
} from "@rakazo/core";
import {
  ensureBotDriveFolder,
  isUniqueViolation,
  LISTED_ARTIFACT,
  withResolvedArtifactVersion,
  withTransactionRetry,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { resolveBotWorkspacePath } from "../../computers/screens/computer-support.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { artifactGroupId } from "./run-tools-files.js";

const DEFAULT_READ_BYTES = 65_536;
const MAX_READ_BYTES = 1_048_576;
const MAX_FOLDER_DEPTH = 20;

function normalizeWorkspaceRelPath(raw: string): string | null {
  const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) return null;
  const normalized = path.posix.normalize(cleaned);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

async function folderDepth(
  prisma: {
    fileFolder: {
      findFirst: (args: {
        where: { id: string; spaceId: string };
        select: { id: boolean; parentId: boolean; trashedAt: boolean };
      }) => Promise<unknown>;
    };
  },
  spaceId: string,
  folderId: string,
): Promise<{ chain: string[]; active: boolean } | null> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  for (let depth = 0; current && depth < 30; depth++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const folder = (await prisma.fileFolder.findFirst({
      where: { id: current, spaceId },
      select: { id: true, parentId: true, trashedAt: true },
    })) as { id: string; parentId: string | null; trashedAt: Date | null } | null;
    if (!folder || folder.trashedAt) return null;
    chain.push(folder.id);
    current = folder.parentId;
  }
  return { chain, active: true };
}

async function folderSubtreeHeight(
  prisma: {
    fileFolder: {
      findMany: (args: {
        where: { spaceId: string; trashedAt: null };
        select: { id: boolean; parentId: boolean };
      }) => Promise<unknown>;
    };
  },
  spaceId: string,
  rootId: string,
): Promise<number> {
  const rows = (await prisma.fileFolder.findMany({
    where: { spaceId, trashedAt: null },
    select: { id: true, parentId: true },
  })) as Array<{ id: string; parentId: string | null }>;
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId);
    if (list) list.push(row.id);
    else children.set(row.parentId, [row.id]);
  }
  let height = 1;
  let level = [rootId];
  const seen = new Set<string>();
  while (level.length > 0) {
    const next: string[] = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...(children.get(id) ?? []));
    }
    if (next.length === 0) break;
    height += 1;
    level = next;
  }
  return height;
}

export const driveTools: Record<string, ToolHandler> = {
  async drive_list(ctx, call) {
    const { deps, run } = ctx;
    const folderId =
      typeof call.args.folder_id === "string" && call.args.folder_id.trim()
        ? call.args.folder_id.trim()
        : undefined;
    const botId =
      typeof call.args.bot_id === "string" && call.args.bot_id.trim()
        ? call.args.bot_id.trim()
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
        ...(botId ? { botId } : {}),
        ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
      },
      orderBy: [{ name: "asc" }],
      take: 50,
      select: { id: true, parentId: true, botId: true, name: true, updatedAt: true },
    });

    const candidates = await deps.prisma.artifact.findMany({
      where: {
        spaceId: run.spaceId,
        trashedAt: null,
        ...LISTED_ARTIFACT,
        ...(folderId ? { folderId } : {}),
        ...(botId ? { botId } : {}),
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { description: { contains: query, mode: "insensitive" } },
                { slug: { contains: query, mode: "insensitive" } },
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
        slug: true,
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
      slug: string | null;
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
        slug: row.slug ?? null,
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
        botId: f.botId ?? null,
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
      where: { id: fileId, spaceId: run.spaceId, trashedAt: null, ...LISTED_ARTIFACT },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
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
          slug: row.slug ?? null,
          description: row.description ?? null,
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
          slug: row.slug ?? null,
          description: row.description ?? null,
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
        slug: row.slug ?? null,
        description: row.description ?? null,
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

    let slug: string;
    if (typeof call.args.slug === "string" && call.args.slug.trim()) {
      try {
        slug = normalizeFileSlug(call.args.slug);
      } catch (error) {
        return call.finish({
          error: error instanceof AttachmentValidationError ? error.message : "Invalid file slug",
        });
      }
    } else {
      slug = slugifyFileName(name);
    }

    const explicitFolderId =
      typeof call.args.folder_id === "string" && call.args.folder_id.trim()
        ? call.args.folder_id.trim()
        : null;
    if (explicitFolderId) {
      const folder = await deps.prisma.fileFolder.findFirst({
        where: { id: explicitFolderId, spaceId: run.spaceId, trashedAt: null },
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
    const folderId =
      explicitFolderId ??
      ("fileFolder" in deps.prisma && deps.prisma.fileFolder
        ? await ensureBotDriveFolder(deps.prisma, {
            spaceId: run.spaceId,
            userId: run.userId,
            botId: bot.id,
            botName: bot.name,
          })
        : null);
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
                slug,
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
        slug: row.slug ?? slug,
        description: row.description ?? description,
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

  async drive_create_folder(ctx, call) {
    const { deps, run } = ctx;
    let name: string;
    try {
      name = validateDriveName(String(call.args.name ?? ""));
    } catch (error) {
      return call.finish({
        error: error instanceof AttachmentValidationError ? error.message : "Invalid folder name",
      });
    }
    const parentId =
      typeof call.args.parent_id === "string" && call.args.parent_id.trim()
        ? call.args.parent_id.trim()
        : null;
    if (parentId) {
      const parentInfo = await folderDepth(deps.prisma, run.spaceId, parentId);
      if (!parentInfo) return call.finish({ error: "Parent folder not found" });
      if (parentInfo.chain.length >= MAX_FOLDER_DEPTH) {
        return call.finish({ error: "Folder nesting limit reached" });
      }
    }

    const existing = await deps.prisma.fileFolder.findFirst({
      where: {
        spaceId: run.spaceId,
        parentId,
        trashedAt: null,
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true, parentId: true, botId: true, name: true },
    });
    if (existing) {
      return call.finish({
        ok: true,
        created: false,
        folder: {
          id: existing.id,
          parentId: existing.parentId,
          botId: existing.botId ?? null,
          name: existing.name,
        },
      });
    }

    try {
      const created = await deps.prisma.fileFolder.create({
        data: {
          spaceId: run.spaceId,
          parentId,
          createdByUserId: run.userId,
          name,
        },
        select: { id: true, parentId: true, botId: true, name: true },
      });
      await bestEffort(
        "drive_create_folder space change",
        Promise.resolve(deps.events.publishSpaceChange?.(run.spaceId, "files")),
      );
      return call.finish({
        ok: true,
        created: true,
        folder: {
          id: created.id,
          parentId: created.parentId,
          botId: created.botId ?? null,
          name: created.name,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await deps.prisma.fileFolder.findFirst({
          where: {
            spaceId: run.spaceId,
            parentId,
            trashedAt: null,
            name: { equals: name, mode: "insensitive" },
          },
          select: { id: true, parentId: true, botId: true, name: true },
        });
        if (raced) {
          return call.finish({
            ok: true,
            created: false,
            folder: {
              id: raced.id,
              parentId: raced.parentId,
              botId: raced.botId ?? null,
              name: raced.name,
            },
          });
        }
      }
      return call.finish({
        error: error instanceof Error ? error.message : "Could not create folder in Space Drive",
      });
    }
  },

  async drive_move(ctx, call) {
    const { deps, run } = ctx;
    const fileId =
      typeof call.args.file_id === "string" && call.args.file_id.trim()
        ? call.args.file_id.trim()
        : null;
    const folderId =
      typeof call.args.folder_id === "string" && call.args.folder_id.trim()
        ? call.args.folder_id.trim()
        : null;
    if ((fileId && folderId) || (!fileId && !folderId)) {
      return call.finish({ error: "Provide exactly one of file_id or folder_id" });
    }
    const destinationFolderId =
      typeof call.args.destination_folder_id === "string" && call.args.destination_folder_id.trim()
        ? call.args.destination_folder_id.trim()
        : null;

    let destinationDepth = 0;
    if (destinationFolderId) {
      const destInfo = await folderDepth(deps.prisma, run.spaceId, destinationFolderId);
      if (!destInfo) return call.finish({ error: "Destination folder not found" });
      if (folderId && destInfo.chain.includes(folderId)) {
        return call.finish({ error: "Cannot move a folder into one of its descendants" });
      }
      destinationDepth = destInfo.chain.length;
    }

    if (fileId) {
      const row = await deps.prisma.artifact.findFirst({
        where: { id: fileId, spaceId: run.spaceId, trashedAt: null, ...LISTED_ARTIFACT },
        select: { id: true, rootArtifactId: true },
      });
      if (!row) return call.finish({ error: "File not found in Space Drive" });
      const root = row.rootArtifactId ?? row.id;
      await deps.prisma.artifact.updateMany({
        where: { spaceId: run.spaceId, OR: [{ id: root }, { rootArtifactId: root }] },
        data: { folderId: destinationFolderId, updatedAt: new Date() },
      });
      await bestEffort(
        "drive_move file space change",
        Promise.resolve(deps.events.publishSpaceChange?.(run.spaceId, "files")),
      );
      return call.finish({ ok: true, fileId, folderId: destinationFolderId });
    }

    if (folderId === destinationFolderId) {
      return call.finish({ error: "Cannot move a folder into itself" });
    }
    const targetFolder = await deps.prisma.fileFolder.findFirst({
      where: { id: folderId!, spaceId: run.spaceId, trashedAt: null },
      select: { id: true },
    });
    if (!targetFolder) return call.finish({ error: "Folder not found in Space Drive" });
    const height = await folderSubtreeHeight(deps.prisma, run.spaceId, folderId!);
    if (destinationDepth + height > MAX_FOLDER_DEPTH) {
      return call.finish({ error: "Folder nesting limit reached" });
    }
    try {
      await deps.prisma.fileFolder.update({
        where: { id: folderId! },
        data: { parentId: destinationFolderId },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return call.finish({ error: "A folder with that name already exists in the destination" });
      }
      return call.finish({
        error: error instanceof Error ? error.message : "Could not move folder",
      });
    }
    await bestEffort(
      "drive_move folder space change",
      Promise.resolve(deps.events.publishSpaceChange?.(run.spaceId, "files")),
    );
    return call.finish({ ok: true, folderId, parentId: destinationFolderId });
  },

  async drive_update(ctx, call) {
    const { deps, run } = ctx;
    const fileId = typeof call.args.file_id === "string" ? call.args.file_id.trim() : "";
    if (!fileId) return call.finish({ error: "file_id is required" });

    let nextName: string | undefined;
    if (call.args.name !== undefined) {
      try {
        nextName = validateDriveName(String(call.args.name ?? ""));
      } catch (error) {
        return call.finish({
          error: error instanceof AttachmentValidationError ? error.message : "Invalid file name",
        });
      }
      if (nextName.length > ARTIFACT_NAME_MAX_LENGTH) {
        return call.finish({ error: `Name exceeds ${ARTIFACT_NAME_MAX_LENGTH} characters` });
      }
    }

    let nextDescription: string | null | undefined;
    if (call.args.description !== undefined) {
      if (call.args.description === null) {
        nextDescription = null;
      } else if (typeof call.args.description === "string") {
        const trimmed = call.args.description.trim();
        if ([...trimmed].length > ARTIFACT_DESCRIPTION_MAX_LENGTH) {
          return call.finish({
            error: `Description exceeds ${ARTIFACT_DESCRIPTION_MAX_LENGTH} characters`,
          });
        }
        nextDescription = trimmed || null;
      } else {
        return call.finish({ error: "description must be a string or null" });
      }
    }

    let nextSlug: string | null | undefined;
    if (call.args.slug !== undefined) {
      if (call.args.slug === null) {
        nextSlug = null;
      } else if (typeof call.args.slug === "string") {
        const trimmed = call.args.slug.trim();
        if (!trimmed) {
          nextSlug = null;
        } else {
          try {
            nextSlug = normalizeFileSlug(trimmed);
          } catch (error) {
            return call.finish({
              error:
                error instanceof AttachmentValidationError ? error.message : "Invalid file slug",
            });
          }
        }
      } else {
        return call.finish({ error: "slug must be a string or null" });
      }
    }

    if (nextName === undefined && nextDescription === undefined && nextSlug === undefined) {
      return call.finish({ error: "Provide at least one of name, description, or slug" });
    }

    const row = await deps.prisma.artifact.findFirst({
      where: { id: fileId, spaceId: run.spaceId, trashedAt: null, ...LISTED_ARTIFACT },
      select: {
        id: true,
        rootArtifactId: true,
        name: true,
        description: true,
        slug: true,
        folderId: true,
      },
    });
    if (!row) return call.finish({ error: "File not found in Space Drive" });

    const root = row.rootArtifactId ?? row.id;
    const now = new Date();
    await deps.prisma.artifact.updateMany({
      where: { spaceId: run.spaceId, OR: [{ id: root }, { rootArtifactId: root }] },
      data: {
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
        ...(nextSlug !== undefined ? { slug: nextSlug } : {}),
        updatedAt: now,
      },
    });

    await bestEffort(
      "drive_update space change",
      Promise.resolve(deps.events.publishSpaceChange?.(run.spaceId, "files")),
    );
    return call.finish({
      ok: true,
      fileId: row.id,
      name: nextName !== undefined ? nextName : row.name,
      description: nextDescription !== undefined ? nextDescription : row.description,
      slug: nextSlug !== undefined ? nextSlug : row.slug,
      folderId: row.folderId,
    });
  },
};
