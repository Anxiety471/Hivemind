import type { FileCategory, HistoryToolStep, MessageBlock } from "@rakazo/contracts";
import {
  ATTACHMENT_COUNT_CEILING,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  attachmentSizeLabel,
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_MAX_CEILING_BYTES,
  isAllowedAttachmentMimeType,
  isAttachmentArchiveMimeType,
  isAttachmentAudioMimeType,
  isAttachmentImageMimeType,
  isAttachmentVideoMimeType,
  isBlockedAttachmentExtension,
  isBlockedAttachmentMimeType,
  normalizeMimeType,
} from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "../runs/action-approval.js";

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

/**
 * Validates base64 without a grouped-repetition regex over the whole string:
 * `/^(?:[A-Za-z0-9+/]{4})*(...)?$/` overflows V8's regex stack on multi-megabyte
 * inputs, which ordinary attachments reach. A flat `[chars]*` quantifier does not;
 * padding is checked separately since it can only be the trailing 0-2 characters.
 */
function isWellFormedBase64(value: string): boolean {
  const paddingMatch = /={1,2}$/.exec(value);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;
  const body = paddingLength > 0 ? value.slice(0, value.length - paddingLength) : value;
  if (body.includes("=")) return false;
  return /^[A-Za-z0-9+/]*$/.test(body);
}

export function attachmentCountFromEnv(source: { MAX_ATTACHMENTS_PER_MESSAGE?: string }): number {
  const value = source.MAX_ATTACHMENTS_PER_MESSAGE?.trim();
  if (!value) return ATTACHMENT_MAX_COUNT;
  const count = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > ATTACHMENT_COUNT_CEILING
  ) {
    throw new Error(
      `MAX_ATTACHMENTS_PER_MESSAGE must be an integer from 1 to ${ATTACHMENT_COUNT_CEILING}`,
    );
  }
  return count;
}

export function uploadSizeFromEnv(source: { MAX_UPLOAD_SIZE_MB?: string }): number {
  const value = source.MAX_UPLOAD_SIZE_MB?.trim();
  if (!value) return ATTACHMENT_MAX_BYTES;
  const mb = Number(value);
  // Leave room for base64 expansion and the JSON envelope in the HTTP body guard.
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(mb) ||
    mb <= 0 ||
    mb > Math.floor(Number.MAX_SAFE_INTEGER / (2 * 1024 * 1024))
  ) {
    throw new Error(
      "MAX_UPLOAD_SIZE_MB must be a positive integer number of MiB within the safe byte range",
    );
  }
  return mb * 1024 * 1024;
}

export function fileUploadSizeFromEnv(source: {
  MAX_FILE_UPLOAD_SIZE_MB?: string;
  MAX_UPLOAD_SIZE_MB?: string;
}): number {
  const value = source.MAX_FILE_UPLOAD_SIZE_MB?.trim();
  if (!value) return Math.max(FILE_UPLOAD_MAX_BYTES, uploadSizeFromEnv(source));
  const mb = Number(value);
  const maxMb = Math.floor(FILE_UPLOAD_MAX_CEILING_BYTES / (1024 * 1024));
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(mb) || mb <= 0 || mb > maxMb) {
    throw new Error(
      `MAX_FILE_UPLOAD_SIZE_MB must be a positive integer number of MiB up to ${maxMb}`,
    );
  }
  return mb * 1024 * 1024;
}

export function decodeAttachmentBase64(
  contentBase64: string,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Uint8Array {
  const normalized = contentBase64.trim();
  if (!normalized) throw new AttachmentValidationError("Attachment content is empty");
  if (normalized.length > Math.ceil(maxBytes / 3) * 4) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  if (normalized.length % 4 !== 0 || !isWellFormedBase64(normalized)) {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  if (bytes.byteLength === 0) throw new AttachmentValidationError("Attachment content is empty");
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  return new Uint8Array(bytes);
}

export function validateAttachmentMimeType(mimeType: string): void {
  if (!isAllowedAttachmentMimeType(mimeType)) {
    throw new AttachmentValidationError(`Unsupported attachment type: ${mimeType}`);
  }
}

export function attachmentKindForMimeType(mimeType: string): "image" | "file" {
  return isAttachmentImageMimeType(mimeType) ? "image" : "file";
}

export function messageBlockForArtifact(artifact: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}): Extract<MessageBlock, { kind: "image" | "file" }> {
  if (attachmentKindForMimeType(artifact.mimeType) === "image") {
    return {
      kind: "image",
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
      name: artifact.name,
    };
  }
  return {
    kind: "file",
    artifactId: artifact.id,
    mimeType: artifact.mimeType,
    name: artifact.name,
    size: artifact.size,
  };
}

/** Untrusted transcript text is bounded before it reaches a prompt. */
const VOICE_TRANSCRIPT_MAX_CHARS = 4000;

/** Keeps tabs and newlines, drops C0, DEL and C1 control characters, trims and bounds the text. */
export function normalizeVoiceTranscript(value: string | null | undefined): string {
  if (!value) return "";
  const printable = Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 9 || code === 10) return true;
      return code >= 32 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("");
  return printable.trim().slice(0, VOICE_TRANSCRIPT_MAX_CHARS);
}

export function promptTextForAttachments(
  text: string | undefined,
  artifacts: Array<{
    name: string;
    mimeType: string;
    size: number;
    /** Normalized words transcribed from an inbound audio attachment. */
    transcript?: string;
  }>,
): string {
  const caption = text?.trim() ?? "";
  const notes = artifacts
    .filter((artifact) => !isAttachmentImageMimeType(artifact.mimeType))
    .map((artifact) => {
      const note = `User attached file ${JSON.stringify(artifact.name)} (${artifact.mimeType}, ${artifact.size} bytes).`;
      return artifact.transcript
        ? `${note}\n[voice note transcript: ${artifact.transcript}]`
        : note;
    });
  return [caption, ...notes].filter(Boolean).join("\n\n") || "See attached files.";
}

const TOOL_STEP_NOTE_MAX_CHARS = 300;
const TOOL_STEP_MAX_LINES = 40;
/** Tool names are at most 64 characters; only imported data could carry a longer label. */
const TOOL_STEP_LABEL_MAX_CHARS = 80;

/**
 * An earlier reply's tool steps as the bot sees them again: label, count and note. Replay caps
 * notes and steps; history reads pass `full`, since they page through long text themselves.
 */
export function toolStepsHistoryText(
  steps: Extract<MessageBlock, { kind: "steps" }>["steps"],
  { full = false }: { full?: boolean } = {},
): string {
  // Stored blocks can come from an account import, so skip malformed entries instead of throwing.
  const valid = Array.isArray(steps) ? steps.filter((step) => typeof step?.label === "string") : [];
  if (valid.length === 0) return "";
  const shown = full ? valid : valid.slice(0, TOOL_STEP_MAX_LINES);
  const lines = shown.map((step) => {
    const name =
      !full && step.label.length > TOOL_STEP_LABEL_MAX_CHARS
        ? `${step.label.slice(0, TOOL_STEP_LABEL_MAX_CHARS)}…`
        : step.label;
    const counted = Number(step.count) > 1 ? `${name} ×${step.count}` : name;
    const outcome = toolStepOutcomeText(step);
    const label = outcome ? `${counted} (${outcome})` : counted;
    const whole = typeof step.note === "string" ? step.note.replace(/\s+/g, " ").trim() : "";
    const note =
      !full && whole.length > TOOL_STEP_NOTE_MAX_CHARS
        ? `${whole.slice(0, TOOL_STEP_NOTE_MAX_CHARS)}…`
        : whole;
    return note ? `- ${label}: ${note}` : `- ${label}`;
  });
  const hidden = valid.length - shown.length;
  if (hidden > 0) lines.push(`- …and ${hidden} more`);
  // "Made" rather than "ran": a call the loop guard stopped is still recorded as a step.
  return `[tool calls this reply made]\n${lines.join("\n")}`;
}

const TOOL_STEP_OUTCOMES = ["succeeded", "failed", "stopped"] as const;

/** "succeeded" when every call ended the same way, else "2 succeeded, 1 failed". */
export function toolStepOutcomeText(step: { count: number; outcomes?: unknown }): string {
  const outcomes = (step.outcomes ?? {}) as Partial<Record<string, unknown>>;
  if (typeof outcomes !== "object") return "";
  const counts = TOOL_STEP_OUTCOMES.flatMap((outcome) => {
    const count = Number(outcomes[outcome]);
    return Number.isInteger(count) && count > 0 ? [{ outcome, count }] : [];
  });
  const [only] = counts;
  if (counts.length === 1 && only?.count === Number(step.count)) return only.outcome;
  return counts.map(({ outcome, count }) => `${count} ${outcome}`).join(", ");
}

export function blocksToAgentHistoryText(blocks: MessageBlock[]): string {
  return blocks.map(blockHistoryText).filter(Boolean).join("\n");
}

/** A reply in order, with its tool steps apart from the text around them. */
export type AgentHistorySegment = { text: string } | { steps: HistoryToolStep[] };

/**
 * The same reply as blocksToAgentHistoryText, split at its tool steps so a runtime can replay
 * them as tool calls. Text between steps is joined as blocksToAgentHistoryText joins it.
 */
export function blocksToAgentHistorySegments(blocks: MessageBlock[]): AgentHistorySegment[] {
  const segments: AgentHistorySegment[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) segments.push({ text: text.join("\n") });
    text = [];
  };
  for (const block of blocks) {
    if (block.kind === "steps") {
      // Stored blocks can come from an account import, so skip malformed entries.
      const steps = Array.isArray(block.steps)
        ? (block.steps as HistoryToolStep[]).filter((step) => typeof step?.label === "string")
        : [];
      if (!steps.length) continue;
      flush();
      segments.push({ steps });
      continue;
    }
    const rendered = blockHistoryText(block);
    if (rendered) text.push(rendered);
  }
  flush();
  return segments;
}

function blockHistoryText(block: MessageBlock): string {
  if (block.kind === "text") return block.text;
  // The tools a reply used, and what the bot wrote before each, are kept out of its text;
  // without them a later turn cannot tell what it already did.
  if (block.kind === "steps") return toolStepsHistoryText(block.steps);
  if (block.kind === "chart") return `[chart: ${block.name}]`;
  if (block.kind === "app") return `[app: ${block.server} showed ${block.tool}]`;
  if (block.kind === "image") return `[image: ${block.name}]`;
  // The id lets a later turn, or another chat, update this page instead of making a new one.
  if (block.kind === "page") {
    return `[page: ${block.title} (pageId ${block.pageId}, version ${block.version})]`;
  }
  if (block.kind === "file") {
    return `[file: ${block.name} (${block.mimeType}, ${block.size} bytes)]`;
  }
  // Keep attribution on peer messages: without it a later turn cannot tell
  // which lines came from another bot rather than the user.
  if (block.kind === "bot_message_received") return `[from ${block.fromBotName}] ${block.text}`;
  if (block.kind === "bot_message_sent") return `[to ${block.toBotName}] ${block.text}`;
  if (block.kind === "channel_message") return `[from ${block.fromLabel}] ${block.text}`;
  if (block.kind === "handoff") {
    return `[handoff ${block.fromBotId} -> ${block.toBotId}] ${block.text}`;
  }
  // Without the answer a later turn sees the question as still open and asks it again.
  if (block.kind === "ask") {
    // A question card keeps its draft in the detail, and a later turn still needs
    // it: approval cards repeat tool arguments the call itself records, and secret
    // cards keep their detail hidden. The draft is fenced so a line in it cannot
    // pass for the answer; only something that reads as a closing draft tag (any case or
    // spacing) is escaped, so the bot reads the rest of its draft verbatim (an address
    // like "Ana <ana@example.test>" stays as written).
    const detail =
      block.detail && !isApprovalAskBlock(block) && !isSecretAskBlock(block)
        ? `\n<draft>\n${block.detail.replace(/<\s*\/\s*draft\s*>/gi, "&lt;/draft&gt;")}\n</draft>`
        : "";
    if (block.status !== "answered" || !block.answer) return `${block.text}${detail}`;
    const choice = block.actions?.find((action) => action.id === block.answer);
    return `${block.text}${detail}\nAnswer: ${choice?.label ?? block.answer}`;
  }
  // The bot needs the outcome of its own call: a missed call is its cue to follow up.
  if (block.kind === "call_request") {
    const outcome = {
      ringing: "still ringing",
      answered: "the user answered",
      declined: "the user declined it",
      missed: "the user did not answer",
    }[block.status];
    return `[you called the user about: ${block.reason}; ${outcome}]${block.status === "answered" ? `\n${block.opening}` : ""}`;
  }
  if ("text" in block && typeof block.text === "string") return block.text;
  return "";
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".env": "text/plain",
  ".ini": "text/plain",
  ".conf": "text/plain",
  ".cfg": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".sql": "application/sql",
  ".sh": "application/x-sh",
  ".bash": "application/x-sh",
  ".zsh": "application/x-sh",
  ".fish": "application/x-sh",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".jsx": "application/javascript",
  ".ts": "text/typescript",
  ".mts": "text/typescript",
  ".cts": "text/typescript",
  ".tsx": "text/typescript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cc": "text/x-c++",
  ".java": "text/x-java",
  ".rb": "text/x-ruby",
  ".php": "application/x-httpd-php",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar.gz": "application/gzip",
  ".tar": "application/x-tar",
  ".bz2": "application/x-bzip2",
  ".tar.bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".tar.xz": "application/x-xz",
};

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/webm": ".weba",
  "audio/flac": ".flac",
  "audio/aac": ".aac",
  "video/mp4": ".mp4",
  "video/x-m4v": ".m4v",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/ogg": ".ogv",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/rtf": ".rtf",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "text/html": ".html",
  "text/css": ".css",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/yaml": ".yaml",
  "application/toml": ".toml",
  "application/sql": ".sql",
  "application/x-sh": ".sh",
  "application/javascript": ".js",
  "text/typescript": ".ts",
  "text/x-python": ".py",
  "text/x-go": ".go",
  "text/x-rust": ".rs",
  "text/x-c": ".c",
  "text/x-c++": ".cpp",
  "text/x-java": ".java",
  "text/x-ruby": ".rb",
  "application/x-httpd-php": ".php",
  "text/x-swift": ".swift",
  "text/x-kotlin": ".kt",
  "text/x-diff": ".diff",
  "application/zip": ".zip",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/x-bzip2": ".bz2",
  "application/x-xz": ".xz",
};

const MIME_ALIASES: Record<string, string> = {
  "application/x-zip-compressed": "application/zip",
  "application/x-zip": "application/zip",
  "multipart/x-zip": "application/zip",
  "application/x-rar-compressed": "application/vnd.rar",
  "application/x-rar": "application/vnd.rar",
  "application/rar": "application/vnd.rar",
  "application/x-7z": "application/x-7z-compressed",
  "application/x-gzip": "application/gzip",
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-flac": "audio/flac",
  "text/x-sh": "application/x-sh",
  "text/x-shellscript": "application/x-sh",
  "application/x-shellscript": "application/x-sh",
  "application/x-yaml": "application/yaml",
  "text/yaml": "application/yaml",
  "text/x-yaml": "application/yaml",
  "text/javascript": "application/javascript",
  "application/x-javascript": "application/javascript",
  "application/typescript": "text/typescript",
  "text/x-typescript": "text/typescript",
  "application/x-python": "text/x-python",
  "text/x-python-script": "text/x-python",
  "application/x-sql": "application/sql",
  "text/x-sql": "application/sql",
  "text/xml": "application/xml",
  "video/x-quicktime": "video/quicktime",
};

const COMPOUND_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz"] as const;
const SAFE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,12}(?:\.[a-z0-9]{1,8})?$/;

function ownLookup(record: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function fileExtensionLower(name: string): string {
  const lower = name.trim().toLowerCase();
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound)) return compound;
  }
  const dot = lower.lastIndexOf(".");
  return dot < 0 ? "" : lower.slice(dot);
}

/** Short file-type badge, as a file's extension reads ("TXT", "MD", "PDF", "SH"). */
export function artifactTypeLabel(mimeType: string, name?: string): string {
  const ext = name ? fileExtensionLower(name) : "";
  if (ext && normalizeMimeType(mimeType) === "application/octet-stream") {
    return ext.slice(1).toUpperCase().slice(0, 6);
  }
  const extension = attachmentExtensionForMimeType(mimeType);
  if (extension) return extension.slice(1).toUpperCase().slice(0, 6);
  const slash = mimeType.indexOf("/");
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase().slice(0, 6);
}

const MIME_SYNTAX = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export function inferAttachmentMimeType(name: string, reportedType?: string): string | null {
  if (isBlockedAttachmentExtension(name)) return null;
  const rawReported = reportedType ? normalizeMimeType(reportedType) : "";
  if (rawReported) {
    if (!MIME_SYNTAX.test(rawReported)) return null;
    if (isBlockedAttachmentMimeType(rawReported)) return null;
  }
  const normalizedReported = rawReported
    ? (ownLookup(MIME_ALIASES, rawReported) ?? rawReported)
    : "";
  const ext = fileExtensionLower(name);
  const extensionType = ext ? ownLookup(EXTENSION_MIME_TYPES, ext) : undefined;

  if (extensionType) {
    if (!normalizedReported || normalizedReported === "application/octet-stream") {
      return extensionType;
    }
    // Browsers and document pickers often report .md, .sh, .ts, .py, .yaml, .sql, or .csv as text/plain.
    if (
      normalizedReported === "text/plain" &&
      (extensionType.startsWith("text/") ||
        extensionType === "application/x-sh" ||
        extensionType === "application/javascript" ||
        extensionType === "application/yaml" ||
        extensionType === "application/toml" ||
        extensionType === "application/sql" ||
        extensionType === "application/json" ||
        extensionType === "application/xml" ||
        extensionType === "application/x-httpd-php")
    ) {
      return extensionType;
    }
    // Windows reports .csv as an Excel file when Excel is installed.
    if (extensionType === "text/csv" && normalizedReported === "application/vnd.ms-excel") {
      return extensionType;
    }
    // M4A container reported with its AAC codec MIME.
    if (extensionType === "audio/mp4" && normalizedReported === "audio/aac") {
      return extensionType;
    }
  }

  if (normalizedReported && isAllowedAttachmentMimeType(normalizedReported)) {
    return normalizedReported;
  }
  if (extensionType) return extensionType;
  if (!normalizedReported || normalizedReported === "application/octet-stream") {
    return "application/octet-stream";
  }
  return "application/octet-stream";
}

export function attachmentExtensionForMimeType(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  return ownLookup(MIME_TYPE_EXTENSIONS, normalized) ?? "";
}

/** Where a run copies an attached file in the bot's workspace; history tools report the same path. */
export function attachmentComputerPath(
  artifactId: string,
  mimeType: string,
  name?: string,
): string {
  const mapped = attachmentExtensionForMimeType(mimeType);
  if (mapped) return `attachments/${artifactId}${mapped}`;
  if (name) {
    const ext = fileExtensionLower(name);
    if (ext && SAFE_EXTENSION_PATTERN.test(ext)) {
      return `attachments/${artifactId}${ext}`;
    }
  }
  return `attachments/${artifactId}`;
}

export function validateDriveName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255 || trimmed === "." || trimmed === "..") {
    throw new AttachmentValidationError("Invalid file or folder name");
  }
  for (const character of trimmed) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || character === "/" || character === "\\") {
      throw new AttachmentValidationError(
        "File or folder name cannot contain slashes or control characters",
      );
    }
  }
  return trimmed;
}

const CODE_MIME_TYPES = new Set([
  "application/x-sh",
  "application/javascript",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/x-httpd-php",
  "text/html",
  "text/css",
  "text/typescript",
  "text/x-python",
  "text/x-go",
  "text/x-rust",
  "text/x-c",
  "text/x-c++",
  "text/x-java",
  "text/x-ruby",
  "text/x-swift",
  "text/x-kotlin",
  "text/x-diff",
]);

const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
]);

export function fileCategoryForMimeType(mimeType: string): Exclude<FileCategory, "all"> | "other" {
  const type = normalizeMimeType(mimeType);
  if (isAttachmentVideoMimeType(type) || type.startsWith("video/")) return "video";
  if (isAttachmentImageMimeType(type) || type.startsWith("image/")) return "image";
  if (isAttachmentAudioMimeType(type) || type.startsWith("audio/")) return "audio";
  if (isAttachmentArchiveMimeType(type)) return "archive";
  if (CODE_MIME_TYPES.has(type)) return "code";
  if (DOCUMENT_MIME_TYPES.has(type) || type.startsWith("text/")) return "document";
  return "other";
}

export function attachmentsForThread<T extends { threadKey: string }>(
  attachments: readonly T[],
  threadKey: string | undefined,
): T[] {
  if (!threadKey) return [];
  return attachments.filter((attachment) => attachment.threadKey === threadKey);
}

export function attachmentsForBot<T extends { botId: string }>(
  attachments: readonly T[],
  botId: string | undefined,
): T[] {
  if (!botId) return [];
  return attachments.filter((attachment) => attachment.botId === botId);
}

/**
 * The message whose attachments this run receives: a person's message, or a message or
 * handoff another bot delivered, whose files arrive the same way.
 */
export function userTurnMessageForRun<
  T extends { id?: string; role: string; runId?: string | null; blocks: MessageBlock[] },
>(trigger: string, runId: string, messages: T[], sourceMessageId?: string | null): T | undefined {
  if (trigger === "bot_message" || trigger === "follow_up") {
    if (!sourceMessageId) return undefined;
    return messages.find(
      (message) =>
        message.id === sourceMessageId &&
        message.blocks.some(
          (block) => block.kind === "bot_message_received" || block.kind === "handoff",
        ),
    );
  }
  if (trigger === "helper")
    return messages.find((message) => message.role === "user" && message.runId === runId);
  if (trigger !== "user" && trigger !== "messaging" && trigger !== "reaction") return undefined;
  return messages.find(
    (message) =>
      message.role === "user" &&
      (sourceMessageId ? message.id === sourceMessageId : message.runId === runId),
  );
}

/** Bound PNG inspection before image decoding on every client. */
export const PNG_ANIMATION_HEADER_BYTES = 64 * 1024;

/** Only re-encode PNGs whose header confirms they are static; unknown stays original. */
export function isStaticPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 33 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeAt = (offset: number) => String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (view.getUint32(8) !== 13 || typeAt(8) !== "IHDR") return false;
  const end = Math.min(bytes.length, PNG_ANIMATION_HEADER_BYTES);
  for (let offset = 33; offset + 8 <= end; ) {
    const type = typeAt(offset);
    // An APNG must declare acTL before its first IDAT, even with one animation frame.
    if (type === "acTL" || type === "IEND") return false;
    if (type === "IDAT") return true;
    const next = offset + 12 + view.getUint32(offset);
    if (next > end) return false;
    offset = next;
  }
  return false;
}
