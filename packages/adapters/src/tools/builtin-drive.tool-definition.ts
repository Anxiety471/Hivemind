import type { ConnectorTool } from "@rakazo/adapter-kit";
import { ARTIFACT_DESCRIPTION_MAX_LENGTH, ARTIFACT_NAME_MAX_LENGTH } from "@rakazo/contracts";

export const driveTools: ConnectorTool[] = [
  {
    name: "drive_list",
    description:
      "List folders and files in this Space's Drive (Files). Filter by folder_id, search query, or category to find uploaded videos, scripts, documents, and bot outputs.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description:
            "Optional folder id to list inside; omit to search across Space Drive or list root.",
        },
        query: {
          type: "string",
          maxLength: 200,
          description:
            "Optional case-insensitive substring filter matching file or folder names and descriptions.",
        },
        category: {
          type: "string",
          enum: ["all", "video", "image", "audio", "document", "code", "archive"],
          description: "Optional media category filter.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of files to return (1-50, default 25).",
        },
      },
    },
  },
  {
    name: "drive_read",
    description:
      "Read a text preview of a file in Space Drive by file_id, or copy any Drive file (including videos or large archives over 25 MiB) directly into your computer workspace via save_to_workspace.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          minLength: 1,
          description: "The Space Drive file id returned by drive_list or an attachment prompt.",
        },
        max_bytes: {
          type: "number",
          minimum: 1,
          maximum: 1_048_576,
          description:
            "Maximum UTF-8 bytes to read for inline text inspection (default 65536, max 1048576).",
        },
        save_to_workspace: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description:
            "Optional relative path inside your computer workspace where the file should be copied (for example 'videos/clip.mp4' or 'scripts/deploy.sh').",
        },
      },
      required: ["file_id"],
    },
  },
  {
    name: "drive_save",
    description:
      "Save a file from your computer workspace or inline UTF-8 text into Space Drive without posting a chat attachment block.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: ARTIFACT_NAME_MAX_LENGTH,
          description: "Target filename in Space Drive (for example 'report.md' or 'setup.sh').",
        },
        workspace_path: {
          type: "string",
          minLength: 1,
          description:
            "Relative path of an existing file on your computer workspace to upload into Space Drive.",
        },
        content: {
          type: "string",
          description: "Inline UTF-8 file text to store when workspace_path is not provided.",
        },
        folder_id: {
          type: "string",
          description:
            "Optional destination Space Drive folder id; omit to place in the Space root.",
        },
        mime_type: {
          type: "string",
          description: "Optional MIME type override; inferred from filename when omitted.",
        },
        description: {
          type: "string",
          maxLength: ARTIFACT_DESCRIPTION_MAX_LENGTH,
          description: "Optional short description shown in Space Drive.",
        },
      },
      required: ["name"],
    },
  },
];
