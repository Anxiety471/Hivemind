import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ARTIFACT_SLUG_MAX_LENGTH,
} from "@rakazo/contracts";

export const driveTools: ConnectorTool[] = [
  {
    name: "drive_list",
    description:
      "List folders and files in this Space's Drive (Files). Filter by folder_id, bot_id, search query (matching names, descriptions, and slugs), or category to find uploaded videos, scripts, documents, and bot outputs.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description:
            "Optional folder id to list inside; omit to search across Space Drive or list root.",
        },
        bot_id: {
          type: "string",
          description: "Optional bot id to filter files and folders belonging to a specific bot.",
        },
        query: {
          type: "string",
          maxLength: 200,
          description:
            "Optional case-insensitive substring filter matching file/folder names, descriptions, and slugs.",
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
      "Read a file in Space Drive by file_id: text files, and text previews of PDF, DOCX, XLSX and PPTX documents. Or copy any Drive file (including videos or large archives over 25 MiB) directly into your computer workspace via save_to_workspace.",
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
            "Optional destination Space Drive folder id; omit to place in your bot's folder.",
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
        slug: {
          type: "string",
          maxLength: ARTIFACT_SLUG_MAX_LENGTH,
          description:
            "Optional lowercase kebab-case search slug (for example 'q3-revenue-report'); auto-generated from name when omitted.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "drive_create_folder",
    description:
      "Create a folder in Space Drive (or return the existing active folder with the same name in that parent).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: ARTIFACT_NAME_MAX_LENGTH,
          description: "Folder name.",
        },
        parent_id: {
          type: ["string", "null"],
          description: "Optional parent folder id; omit or pass null to create at Space root.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "drive_move",
    description:
      "Move a Space Drive file or folder into another folder (or pass null for destination_folder_id to move to Space root).",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          minLength: 1,
          description: "Id of the Space Drive file to move (provide either file_id or folder_id).",
        },
        folder_id: {
          type: "string",
          minLength: 1,
          description:
            "Id of the Space Drive folder to move (provide either file_id or folder_id).",
        },
        destination_folder_id: {
          type: ["string", "null"],
          description: "Destination folder id, or null to move to Space root.",
        },
      },
    },
  },
  {
    name: "drive_update",
    description: "Rename a Space Drive file and/or update its searchable description and slug.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          minLength: 1,
          description: "The Space Drive file id to update.",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: ARTIFACT_NAME_MAX_LENGTH,
          description: "Optional new filename.",
        },
        description: {
          type: ["string", "null"],
          maxLength: ARTIFACT_DESCRIPTION_MAX_LENGTH,
          description: "Optional new short description, or null to clear.",
        },
        slug: {
          type: ["string", "null"],
          maxLength: ARTIFACT_SLUG_MAX_LENGTH,
          description: "Optional lowercase kebab-case search slug, or null to clear.",
        },
      },
      required: ["file_id"],
    },
  },
];
