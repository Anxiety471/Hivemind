export function teamWorkspaceInstruction(_botId: string): string {
  return "This Team Computer workspace is shared by every bot in this Space. Relative file paths and shell working directories start at the shared root, and files stored here are accessible to everyone in the Space. Never create or write under per-bot bots/<id>/ directories — they are retired. Default to Space Drive (drive_save or attach_file) for durable deliverables, documents, media, and handoffs so they are auto-organized with searchable descriptions and slugs.";
}
