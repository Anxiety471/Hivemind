import { createStoredPreference } from "./stored-preference";

export const TOOL_ACTIVITY_STORAGE_KEY = "rakazo.showToolActivity";

/**
 * Only a saved "off" hides tool cards. Missing, unreadable, or unknown storage stays on so the
 * activity panel, including reasoning cards, shows by default.
 */
export function normalizeToolActivityEnabled(raw: string | null | undefined): boolean {
  return raw?.trim().toLowerCase() !== "off";
}

export const toolActivityPreference = createStoredPreference({
  key: TOOL_ACTIVITY_STORAGE_KEY,
  parse: normalizeToolActivityEnabled,
  serialize: (enabled) => (enabled ? "on" : "off"),
});
