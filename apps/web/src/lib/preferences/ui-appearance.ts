import type {
  ResolvedAppearance,
  WebAppearancePreference,
  WebPaletteName,
} from "@rakazo/ui-tokens";
import {
  persistAppearancePreference,
  resolveWebAppearance,
  resolveWebAppearancePreference,
  webTokensForAppearance,
} from "@rakazo/ui-tokens";

export type AppearancePreference = WebAppearancePreference;
export type { ResolvedAppearance };

const THEME_COLOR_META = 'meta[name="theme-color"]';

export function readSystemAppearance(
  media: Pick<MediaQueryList, "matches"> | null = typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null,
): ResolvedAppearance {
  return media?.matches ? "light" : "dark";
}

export function applyResolvedAppearance(
  appearance: ResolvedAppearance,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
  palette: WebPaletteName | null = null,
): void {
  if (!root) return;
  root.dataset.theme = appearance;
  if (palette) root.dataset.palette = palette;
  else delete root.dataset.palette;
  root.style.colorScheme = appearance;
  if (typeof document === "undefined") return;
  const meta = document.querySelector(THEME_COLOR_META);
  if (meta) {
    // The applied background, so an instance theme's color reaches the browser chrome too.
    const applied = getComputedStyle(root).getPropertyValue("--background").trim();
    meta.setAttribute("content", applied || webTokensForAppearance(appearance).background);
  }
}

export function applyUiAppearance(
  preference: AppearancePreference = resolveWebAppearancePreference(),
  system: ResolvedAppearance = readSystemAppearance(),
): ResolvedAppearance {
  const { scheme, palette } = resolveWebAppearance(preference, system);
  applyResolvedAppearance(scheme, undefined, palette);
  return scheme;
}

export function setUiAppearance(preference: AppearancePreference): ResolvedAppearance {
  persistAppearancePreference(preference);
  return applyUiAppearance(preference);
}

export function getUiAppearancePreference(): AppearancePreference {
  return resolveWebAppearancePreference();
}

/** Keep `data-theme` in sync when the OS scheme changes and preference is System. */
export function watchSystemAppearance(
  onChange: (system: ResolvedAppearance) => void = () => {
    if (resolveWebAppearancePreference() === "system") applyUiAppearance("system");
  },
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => onChange(media.matches ? "light" : "dark");
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}
