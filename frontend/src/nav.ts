export function href(page: string, arg?: string) {
  return `#/${page}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
}

export function navigate(page: string, arg?: string) {
  location.hash = href(page, arg);
}
