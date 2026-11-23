export function teamWorkspaceInstruction(_botId: string): string {
  return "This Team Computer workspace is shared by every bot in this Space. Relative file paths and shell working directories start at the shared root, and files stored here are accessible to everyone in the Space.";
}
