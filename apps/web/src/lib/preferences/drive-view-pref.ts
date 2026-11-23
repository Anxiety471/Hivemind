import { createStoredPreference } from "./stored-preference";

export type DriveView = "list" | "grid";

export const DRIVE_VIEW_STORAGE_KEY = "rakazo.driveView";

/** How the Drive app lays out files on this device: rows, or a grid of cards with thumbnails. */
export const driveViewPreference = createStoredPreference<DriveView>({
  key: DRIVE_VIEW_STORAGE_KEY,
  parse: (raw) => (raw?.trim().toLowerCase() === "grid" ? "grid" : "list"),
  serialize: (view) => view,
});
