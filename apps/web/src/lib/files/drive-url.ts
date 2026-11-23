/** Query parameter that carries the Space the Files item was opened from to the Drive app. */
export const DRIVE_SPACE_PARAM = "space";

/** The Drive app's Files page for a Space, which the menu opens in a new tab. */
export function driveFilesUrl(driveUrl: string, spaceId: string): string {
  const url = new URL("/app/files", driveUrl);
  url.searchParams.set(DRIVE_SPACE_PARAM, spaceId);
  return url.toString();
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
