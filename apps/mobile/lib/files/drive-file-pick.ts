import type { DriveFile } from "@rakazo/contracts";
import { createKeyedListeners } from "@rakazo/core";

const picks = createKeyedListeners<DriveFile>();

/** A file chosen in the Files screen for the chat whose composer waits for it. */
export const offerDriveFile = picks.emit;
export const subscribeDriveFilePick = picks.subscribe;
