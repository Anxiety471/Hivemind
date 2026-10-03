// Appearance: follow the system, or force light or dark (stored in this browser).
import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "hivemind.theme";
const listeners = new Set<(theme: Theme) => void>();

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme, persist = true) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Only a preference.
    }
  }
  listeners.forEach((fn) => fn(theme));
}

/** The theme actually on screen once "system" is resolved. */
export function effectiveTheme(theme = storedTheme()): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState(storedTheme);
  useEffect(() => {
    listeners.add(setTheme);
    return () => {
      listeners.delete(setTheme);
    };
  }, []);
  return [theme, applyTheme];
}
