import { DRIVE_OPEN_PATH, DRIVE_SPACE_PARAM } from "@rakazo/contracts";

/** The server hop that hands the session to the Drive app and redirects to its Files page. */
export function driveOpenPath(spaceId: string): string {
  const params = new URLSearchParams({ [DRIVE_SPACE_PARAM]: spaceId });
  return `${DRIVE_OPEN_PATH}?${params}`;
}

/**
 * Selects the Space the Files item was opened from and drops it from the address, so a reload
 * or a shared link keeps the Space the person last used here.
 */
export function applyDriveSpaceLink(
  location: Pick<Location, "href">,
  history: Pick<History, "replaceState" | "state">,
  select: (spaceId: string) => unknown,
) {
  const url = new URL(location.href);
  const spaceId = url.searchParams.get(DRIVE_SPACE_PARAM);
  if (!spaceId) return;
  select(spaceId);
  url.searchParams.delete(DRIVE_SPACE_PARAM);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
