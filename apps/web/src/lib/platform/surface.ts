/**
 * The Drive app is this same bundle served from its own host with `drive.html`, whose root
 * element names the surface. It runs the Files page alone, and never registers the service
 * worker, which belongs to the main app's origin.
 */
export function isDriveSurface(root: Pick<HTMLElement, "dataset"> = document.documentElement) {
  return root.dataset.rakazoSurface === "drive";
}
