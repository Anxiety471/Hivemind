/** Starts the note a routine's prepare command adds to its prompt; what follows is not the owner's. */
export const ROUTINE_PREPARE_NOTE_START = "\n\nBefore this run, the routine ran its saved command ";

export function routinePrepareNote(
  command: string,
  outcome: { result: string } | { error: string },
): string {
  const called = `${ROUTINE_PREPARE_NOTE_START}cmd.${command}`;
  return "error" in outcome
    ? `${called}, and it failed: ${outcome.error}\nDo what you can without its data, and say what failed.`
    : `${called}. It returned:\n${outcome.result}`;
}
