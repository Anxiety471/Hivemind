export function href(page: string, arg?: string) {
  return `#/${page}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
}

export function navigate(page: string, arg?: string) {
  location.hash = href(page, arg);
}

// Opening the new-issue composer from anywhere (sidebar, command palette, `C`).
let pendingNewIssue = false;
const newIssueListeners = new Set<() => void>();

export function requestNewIssue() {
  pendingNewIssue = true;
  if (!location.hash.startsWith("#/issues") && !location.hash.startsWith("#/tasks")) navigate("issues");
  newIssueListeners.forEach((fn) => fn());
}

/** Subscribe to new-issue requests; returns whether one was already waiting, which is consumed. */
export function onNewIssue(fn: () => void): { pending: boolean; off: () => void } {
  newIssueListeners.add(fn);
  const pending = pendingNewIssue;
  pendingNewIssue = false;
  return { pending, off: () => newIssueListeners.delete(fn) };
}

export function consumeNewIssue() {
  pendingNewIssue = false;
}
