import { readFile } from "node:fs/promises";
import { bestEffort } from "@rakazo/logging";

/**
 * Text the operator of this deployment adds to every run's instructions, right after the built-in
 * context-tools block: the file named by `RAKAZO_RUN_INSTRUCTIONS_FILE`. Unset, empty or
 * unreadable adds nothing. It is read per run, so an edit applies to the next run without a
 * restart.
 */
export async function operatorInstruction(): Promise<string | undefined> {
  const path = process.env.RAKAZO_RUN_INSTRUCTIONS_FILE?.trim();
  if (!path) return undefined;
  const text = (await bestEffort("read operator run instructions", readFile(path, "utf8")))?.trim();
  return text || undefined;
}
