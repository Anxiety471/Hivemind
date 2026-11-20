// Runs before first paint, as a file because the app's CSP blocks inline scripts.
(() => {
  const key = "rakazo.uiAppearance";
  let preference = "system";
  try {
    const stored = localStorage.getItem(key);
    if (/^(system|light|dark|warm|tokyo-night)$/.test(stored || "")) preference = stored;
  } catch {}
  const systemLight =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  // Named palettes draw on a light or dark base, matching the web palettes in ui-tokens.
  const palettes = { warm: ["light", "#faf6ee"], "tokyo-night": ["dark", "#1a1b26"] };
  const palette = palettes[preference];
  const theme = palette
    ? palette[0]
    : preference === "system"
      ? systemLight
        ? "light"
        : "dark"
      : preference;
  document.documentElement.dataset.theme = theme;
  if (palette) document.documentElement.dataset.palette = preference;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.setAttribute("content", palette ? palette[1] : theme === "light" ? "#ffffff" : "#0a0a0a");
  // macOS draws regular text at 420 (see --font-weight-normal); iPads report a Mac platform too.
  const nav = typeof navigator === "object" ? navigator : undefined;
  if (nav && /^Mac/.test(nav.platform || "") && !(nav.maxTouchPoints > 1)) {
    document.documentElement.dataset.os = "mac";
  }
})();
