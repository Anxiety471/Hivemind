// Browser-local "rice": the look of the Hivemind UI.
// A rice is a named pair of light and dark palettes plus type, corners, and density.
// The default Hive rice leaves the stylesheet in charge, including the OS color scheme.

export type Appearance = "system" | "light" | "dark";
export type FontChoice = "sans" | "serif" | "mono";
export type Density = "compact" | "cozy" | "roomy";
export type Scheme = "light" | "dark";

export type Palette = {
  bg: string;
  panel: string;
  panel2: string;
  sidebar: string;
  sidebarText: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
};

export type Rice = {
  id: string;
  name: string;
  blurb: string;
  builtin: boolean;
  appearance: Appearance;
  font: FontChoice;
  radius: number;
  density: Density;
  light: Palette;
  dark: Palette;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type RiceEnv = {
  scheme(): Scheme;
  watchScheme(onChange: () => void): () => void;
  apply(rice: Rice | null, scheme: Scheme): void;
};

export type Snapshot = {
  presets: readonly Rice[];
  custom: readonly Rice[];
  active: Rice;
  baseId: string;
  dirty: boolean;
  /** Palette currently painted, after appearance is resolved. */
  scheme: Scheme;
  /** Operating system scheme, ignoring the rice's own appearance. */
  systemScheme: Scheme;
};

const STORAGE_KEY = "hivemind.rice";
const MAX_CUSTOM = 40;

export const PALETTE_KEYS = [
  "bg",
  "panel",
  "panel2",
  "sidebar",
  "sidebarText",
  "text",
  "muted",
  "border",
  "accent",
  "accentInk",
  "accentSoft",
] as const satisfies readonly (keyof Palette)[];

const PALETTE_VARS: Record<keyof Palette, string> = {
  bg: "--bg",
  panel: "--panel",
  panel2: "--panel-2",
  sidebar: "--sidebar",
  sidebarText: "--sidebar-text",
  text: "--text",
  muted: "--muted",
  border: "--border",
  accent: "--accent",
  accentInk: "--accent-ink",
  accentSoft: "--accent-soft",
};

const LIGHT_STATUS: Record<string, string> = {
  "--ok": "#1f8a4c",
  "--ok-soft": "#e3f4ea",
  "--info": "#2763c9",
  "--info-soft": "#e5eefc",
  "--warn": "#b56b00",
  "--warn-soft": "#fdf0dc",
  "--bad": "#c2362f",
  "--bad-soft": "#fbe6e4",
};

const DARK_STATUS: Record<string, string> = {
  "--ok": "#4cc983",
  "--ok-soft": "#13301f",
  "--info": "#79a6f2",
  "--info-soft": "#172741",
  "--warn": "#f0b04a",
  "--warn-soft": "#3a2a10",
  "--bad": "#f07a72",
  "--bad-soft": "#3d1816",
};

export const FONT_STACK: Record<FontChoice, string> = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

const APPLIED_PROPS = [...Object.values(PALETTE_VARS), ...Object.keys(LIGHT_STATUS), "--font", "--radius", "--control-radius"];

function palette(p: Palette): Palette {
  return p;
}

function preset(rice: Omit<Rice, "builtin">): Rice {
  return { builtin: true, ...rice };
}

/** Built-in rices. Hive matches `styles.css`, including the dark-scheme overrides. */
export const PRESETS: readonly Rice[] = [
  preset({
    id: "hive",
    name: "Hive",
    blurb: "Honey on warm paper. The Hivemind default.",
    appearance: "system",
    font: "sans",
    radius: 10,
    density: "cozy",
    light: palette({
      bg: "#f6f6f3",
      panel: "#ffffff",
      panel2: "#fafaf8",
      sidebar: "#17181c",
      sidebarText: "#c9cad1",
      text: "#1c1d21",
      muted: "#6b6d76",
      border: "#e4e3de",
      accent: "#e8a317",
      accentInk: "#1c1d21",
      accentSoft: "#fdf3dc",
    }),
    dark: palette({
      bg: "#111215",
      panel: "#18191d",
      panel2: "#1d1e23",
      sidebar: "#0b0c0e",
      sidebarText: "#c9cad1",
      text: "#e8e8ec",
      muted: "#9497a1",
      border: "#2a2c32",
      accent: "#e8a317",
      accentInk: "#1c1d21",
      accentSoft: "#3a2e12",
    }),
  }),
  preset({
    id: "catppuccin",
    name: "Catppuccin",
    blurb: "Soft mauve. Latte by day, mocha by night.",
    appearance: "system",
    font: "sans",
    radius: 14,
    density: "cozy",
    light: palette({
      bg: "#eff1f5",
      panel: "#e6e9ef",
      panel2: "#dce0e8",
      sidebar: "#4c4f69",
      sidebarText: "#e6e9ef",
      text: "#4c4f69",
      muted: "#6c6f85",
      border: "#ccd0da",
      accent: "#8839ef",
      accentInk: "#f5f0ff",
      accentSoft: "#e4d4fa",
    }),
    dark: palette({
      bg: "#1e1e2e",
      panel: "#181825",
      panel2: "#313244",
      sidebar: "#11111b",
      sidebarText: "#cdd6f4",
      text: "#cdd6f4",
      muted: "#a6adc8",
      border: "#45475a",
      accent: "#cba6f7",
      accentInk: "#1e1e2e",
      accentSoft: "#3b3054",
    }),
  }),
  preset({
    id: "gruvbox",
    name: "Gruvbox",
    blurb: "Warm retro contrast, gold on tan.",
    appearance: "system",
    font: "sans",
    radius: 4,
    density: "cozy",
    light: palette({
      bg: "#fbf1c7",
      panel: "#f2e5bc",
      panel2: "#ebdbb2",
      sidebar: "#3c3836",
      sidebarText: "#ebdbb2",
      text: "#3c3836",
      muted: "#665c54",
      border: "#d5c4a1",
      accent: "#d79921",
      accentInk: "#282828",
      accentSoft: "#f0ddb0",
    }),
    dark: palette({
      bg: "#282828",
      panel: "#32302f",
      panel2: "#3c3836",
      sidebar: "#1d2021",
      sidebarText: "#ebdbb2",
      text: "#ebdbb2",
      muted: "#a89984",
      border: "#504945",
      accent: "#fabd2f",
      accentInk: "#282828",
      accentSoft: "#4a3f24",
    }),
  }),
  preset({
    id: "nord",
    name: "Nord",
    blurb: "Arctic blues and snow.",
    appearance: "system",
    font: "sans",
    radius: 8,
    density: "cozy",
    light: palette({
      bg: "#eceff4",
      panel: "#e5e9f0",
      panel2: "#d8dee9",
      sidebar: "#2e3440",
      sidebarText: "#e5e9f0",
      text: "#2e3440",
      muted: "#4c566a",
      border: "#d8dee9",
      accent: "#5e81ac",
      accentInk: "#eceff4",
      accentSoft: "#d5e2f1",
    }),
    dark: palette({
      bg: "#2e3440",
      panel: "#3b4252",
      panel2: "#434c5e",
      sidebar: "#242933",
      sidebarText: "#e5e9f0",
      text: "#eceff4",
      muted: "#9aa3b2",
      border: "#4c566a",
      accent: "#88c0d0",
      accentInk: "#2e3440",
      accentSoft: "#364858",
    }),
  }),
  preset({
    id: "tokyonight",
    name: "Tokyo Night",
    blurb: "Neon blue over a night city.",
    appearance: "dark",
    font: "sans",
    radius: 8,
    density: "cozy",
    light: palette({
      bg: "#e1e2e7",
      panel: "#d5d6db",
      panel2: "#c4c8da",
      sidebar: "#1a1b26",
      sidebarText: "#c0caf5",
      text: "#343b58",
      muted: "#6a7192",
      border: "#c4c6d2",
      accent: "#2e7de9",
      accentInk: "#f4f7ff",
      accentSoft: "#d4e3fa",
    }),
    dark: palette({
      bg: "#1a1b26",
      panel: "#24283b",
      panel2: "#2f3549",
      sidebar: "#16161e",
      sidebarText: "#a9b1d6",
      text: "#c0caf5",
      muted: "#9aa5ce",
      border: "#3b4261",
      accent: "#7aa2f7",
      accentInk: "#1a1b26",
      accentSoft: "#2a3358",
    }),
  }),
  preset({
    id: "rosepine",
    name: "Rosé Pine",
    blurb: "Muted florals, dawn and moon.",
    appearance: "system",
    font: "serif",
    radius: 12,
    density: "roomy",
    light: palette({
      bg: "#faf4ed",
      panel: "#fffaf3",
      panel2: "#f2e9e1",
      sidebar: "#575279",
      sidebarText: "#fffaf3",
      text: "#575279",
      muted: "#797593",
      border: "#dfdad9",
      accent: "#907aa9",
      accentInk: "#faf4ed",
      accentSoft: "#efe4f4",
    }),
    dark: palette({
      bg: "#191724",
      panel: "#1f1d2e",
      panel2: "#26233a",
      sidebar: "#13111c",
      sidebarText: "#e0def4",
      text: "#e0def4",
      muted: "#908caa",
      border: "#403d52",
      accent: "#c4a7e7",
      accentInk: "#191724",
      accentSoft: "#342d45",
    }),
  }),
  preset({
    id: "kanagawa",
    name: "Kanagawa",
    blurb: "Ink, washi, and autumn orange.",
    appearance: "system",
    font: "serif",
    radius: 6,
    density: "cozy",
    light: palette({
      bg: "#f2ecbc",
      panel: "#e7dba0",
      panel2: "#dcd3a1",
      sidebar: "#545464",
      sidebarText: "#f2ecbc",
      text: "#545464",
      muted: "#716e61",
      border: "#c7c09a",
      accent: "#d27e99",
      accentInk: "#2a1f24",
      accentSoft: "#f0d5df",
    }),
    dark: palette({
      bg: "#1f1f28",
      panel: "#2a2a37",
      panel2: "#363646",
      sidebar: "#16161d",
      sidebarText: "#dcd7ba",
      text: "#dcd7ba",
      muted: "#727169",
      border: "#54546d",
      accent: "#ffa066",
      accentInk: "#1f1f28",
      accentSoft: "#4a3428",
    }),
  }),
  preset({
    id: "dracula",
    name: "Dracula",
    blurb: "Purple night, with a pale paper day.",
    appearance: "dark",
    font: "sans",
    radius: 10,
    density: "cozy",
    light: palette({
      bg: "#f8f8f2",
      panel: "#ffffff",
      panel2: "#f0f0ea",
      sidebar: "#282a36",
      sidebarText: "#f8f8f2",
      text: "#282a36",
      muted: "#6272a4",
      border: "#e0e0d8",
      accent: "#6c4ec2",
      accentInk: "#f8f8f2",
      accentSoft: "#efe8ff",
    }),
    dark: palette({
      bg: "#282a36",
      panel: "#343746",
      panel2: "#44475a",
      sidebar: "#21222c",
      sidebarText: "#f8f8f2",
      text: "#f8f8f2",
      muted: "#a3a4b5",
      border: "#44475a",
      accent: "#bd93f9",
      accentInk: "#282a36",
      accentSoft: "#3c3454",
    }),
  }),
  preset({
    id: "everforest",
    name: "Everforest",
    blurb: "A soft green canopy.",
    appearance: "system",
    font: "sans",
    radius: 8,
    density: "cozy",
    light: palette({
      bg: "#fdf6e3",
      panel: "#f4f0d9",
      panel2: "#efebd4",
      sidebar: "#4a555b",
      sidebarText: "#fdf6e3",
      text: "#5c6a72",
      muted: "#829181",
      border: "#e0dcc7",
      accent: "#8da101",
      accentInk: "#fdf6e3",
      accentSoft: "#e8efcc",
    }),
    dark: palette({
      bg: "#2d353b",
      panel: "#343f44",
      panel2: "#3d484d",
      sidebar: "#232a2e",
      sidebarText: "#d3c6aa",
      text: "#d3c6aa",
      muted: "#859289",
      border: "#4a555b",
      accent: "#a7c080",
      accentInk: "#2d353b",
      accentSoft: "#3e4a3d",
    }),
  }),
  preset({
    id: "oxocarbon",
    name: "Oxocarbon",
    blurb: "Sharp carbon, IBM blue.",
    appearance: "dark",
    font: "sans",
    radius: 0,
    density: "compact",
    light: palette({
      bg: "#ffffff",
      panel: "#f4f4f4",
      panel2: "#e8e8e8",
      sidebar: "#161616",
      sidebarText: "#f4f4f4",
      text: "#161616",
      muted: "#525252",
      border: "#e0e0e0",
      accent: "#0f62fe",
      accentInk: "#ffffff",
      accentSoft: "#d0e2ff",
    }),
    dark: palette({
      bg: "#161616",
      panel: "#262626",
      panel2: "#393939",
      sidebar: "#0d0d0d",
      sidebarText: "#f2f4f8",
      text: "#f2f4f8",
      muted: "#adb5bd",
      border: "#393939",
      accent: "#33b1ff",
      accentInk: "#161616",
      accentSoft: "#1a3040",
    }),
  }),
  preset({
    id: "solarized",
    name: "Solarized",
    blurb: "Balanced contrast and cyan.",
    appearance: "system",
    font: "serif",
    radius: 6,
    density: "cozy",
    light: palette({
      bg: "#fdf6e3",
      panel: "#eee8d5",
      panel2: "#e6dfc8",
      sidebar: "#073642",
      sidebarText: "#eee8d5",
      text: "#657b83",
      muted: "#93a1a1",
      border: "#e0d8c0",
      accent: "#268bd2",
      accentInk: "#fdf6e3",
      accentSoft: "#d6e8f5",
    }),
    dark: palette({
      bg: "#002b36",
      panel: "#073642",
      panel2: "#0a4050",
      sidebar: "#001e26",
      sidebarText: "#eee8d5",
      text: "#839496",
      muted: "#586e75",
      border: "#0d4a57",
      accent: "#2aa198",
      accentInk: "#002b36",
      accentSoft: "#0c3d40",
    }),
  }),
  preset({
    id: "matrix",
    name: "Matrix",
    blurb: "Phosphor on a dark terminal.",
    appearance: "dark",
    font: "mono",
    radius: 2,
    density: "compact",
    light: palette({
      bg: "#f3f7f1",
      panel: "#ffffff",
      panel2: "#e7f0e4",
      sidebar: "#102410",
      sidebarText: "#d8f5d8",
      text: "#143014",
      muted: "#3d6b3d",
      border: "#d3e4cf",
      accent: "#1b8f2a",
      accentInk: "#f3f7f1",
      accentSoft: "#d9f0dc",
    }),
    dark: palette({
      bg: "#0a0f0a",
      panel: "#0e160e",
      panel2: "#132013",
      sidebar: "#050805",
      sidebarText: "#8fd48f",
      text: "#b7f5b7",
      muted: "#5d9a5d",
      border: "#1d3a1d",
      accent: "#39ff14",
      accentInk: "#041204",
      accentSoft: "#123312",
    }),
  }),
];

export function parseHex(input: string): string | null {
  const trimmed = input.trim();
  const short = /^#?([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const full = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  return full ? `#${full[1].toLowerCase()}` : null;
}

function channel(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = channel(a);
  const [br, bg, bb] = channel(b);
  const t = Math.min(1, Math.max(0, amount));
  const blend = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[blend(ar, br), blend(ag, bg), blend(ab, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const linear = channel(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.4;
}

export function accentInk(accent: string): string {
  const dark = "#1c1d21";
  const light = "#f6f6f3";
  const contrast = (ink: string) => {
    const left = luminance(accent);
    const right = luminance(ink);
    const [hi, lo] = left > right ? [left, right] : [right, left];
    return (hi + 0.05) / (lo + 0.05);
  };
  return contrast(dark) >= contrast(light) ? dark : light;
}

/** Rebuild the secondary colors from background, surface, sidebar, text, and accent. */
export function harmonize(source: Palette): Palette {
  const dark = isDark(source.bg);
  const sideDark = isDark(source.sidebar);
  return {
    ...source,
    panel2: mix(source.panel, source.text, dark ? 0.08 : 0.045),
    sidebarText: sideDark ? mix(source.sidebar, "#ffffff", 0.78) : mix(source.sidebar, "#111215", 0.78),
    muted: mix(source.text, source.bg, 0.42),
    border: mix(source.bg, source.text, dark ? 0.18 : 0.12),
    accentInk: accentInk(source.accent),
    accentSoft: mix(source.bg, source.accent, dark ? 0.28 : 0.16),
  };
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lig - c / 2;
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function shufflePalette(dark: boolean, hue = Math.floor(Math.random() * 360)): Palette {
  const accent = hslToHex(hue, dark ? 72 : 64, dark ? 64 : 38);
  const bg = hslToHex(hue, dark ? 16 : 26, dark ? 9 : 96);
  const panel = hslToHex(hue, dark ? 14 : 20, dark ? 13 : 99);
  const sidebar = hslToHex(hue, dark ? 18 : 18, dark ? 6 : 16);
  const text = hslToHex(hue, dark ? 22 : 28, dark ? 92 : 16);
  return harmonize({
    bg,
    panel,
    sidebar,
    text,
    accent,
    panel2: panel,
    sidebarText: "#ffffff",
    muted: text,
    border: bg,
    accentInk: "#000000",
    accentSoft: bg,
  });
}

function cloneRice(rice: Rice): Rice {
  return { ...rice, light: { ...rice.light }, dark: { ...rice.dark } };
}

function samePalette(a: Palette, b: Palette): boolean {
  return PALETTE_KEYS.every((key) => a[key] === b[key]);
}

function sameLook(a: Rice, b: Rice): boolean {
  return (
    a.appearance === b.appearance &&
    a.font === b.font &&
    a.radius === b.radius &&
    a.density === b.density &&
    samePalette(a.light, b.light) &&
    samePalette(a.dark, b.dark)
  );
}

function isStockHive(rice: Rice): boolean {
  return sameLook(rice, PRESETS[0]);
}

export function resolveScheme(appearance: Appearance, system: () => Scheme): Scheme {
  return appearance === "system" ? system() : appearance;
}

function cleanName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (trimmed.length < 1) return null;
  return trimmed;
}

function clampRadius(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(0, Math.min(24, Math.round(value)));
}

function asChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function parsePalette(value: unknown): Palette | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const next = {} as Palette;
  for (const key of PALETTE_KEYS) {
    if (typeof rec[key] !== "string") return null;
    const hex = parseHex(rec[key]);
    if (!hex) return null;
    next[key] = hex;
  }
  return next;
}

function parseRiceRecord(value: unknown, id: string, builtin: boolean): Rice | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const light = parsePalette(rec.light);
  const dark = parsePalette(rec.dark);
  const paletteOnly = parsePalette(rec.palette);
  const resolvedLight = light ?? dark ?? paletteOnly;
  const resolvedDark = dark ?? light ?? paletteOnly;
  if (!resolvedLight || !resolvedDark) return null;
  const name = typeof rec.name === "string" ? cleanName(rec.name) : null;
  return {
    id,
    name: name ?? "Imported rice",
    blurb: typeof rec.blurb === "string" ? rec.blurb.trim().slice(0, 120) : "",
    builtin,
    appearance: asChoice(rec.appearance, ["system", "light", "dark"] as const, "system"),
    font: asChoice(rec.font, ["sans", "serif", "mono"] as const, "sans"),
    radius: clampRadius(typeof rec.radius === "number" ? rec.radius : 10),
    density: asChoice(rec.density, ["compact", "cozy", "roomy"] as const, "cozy"),
    light: resolvedLight,
    dark: resolvedDark,
  };
}

type Persisted = { selectedId: string; draft: Rice | null; custom: Rice[] };

function blankPersisted(): Persisted {
  return { selectedId: "hive", draft: null, custom: [] };
}

function parsePersisted(data: unknown): Persisted | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (rec.version !== 1) return null;
  const custom = Array.isArray(rec.custom)
    ? rec.custom.flatMap((item, index) => {
        const rice = parseRiceRecord(item, `custom-restored-${index}`, false);
        if (!rice) return [];
        const id = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : rice.id;
        return [{ ...rice, id, builtin: false }];
      }).slice(0, MAX_CUSTOM)
    : [];
  const selectedId = typeof rec.selectedId === "string" ? rec.selectedId : "hive";
  const known = PRESETS.some((p) => p.id === selectedId) || custom.some((c) => c.id === selectedId);
  let draft: Rice | null = null;
  if (known && rec.draft && typeof rec.draft === "object") {
    const draftId = typeof (rec.draft as { id?: unknown }).id === "string" ? (rec.draft as { id: string }).id : selectedId;
    draft = parseRiceRecord(rec.draft, draftId, false);
  }
  return { selectedId: known ? selectedId : "hive", draft: known ? draft : null, custom };
}

function loadPersisted(storage: StorageLike): Persisted {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return blankPersisted();
    return parsePersisted(JSON.parse(raw)) ?? blankPersisted();
  } catch {
    return blankPersisted();
  }
}

function nextId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && "randomUUID" in cryptoObj) return `custom-${cryptoObj.randomUUID()}`;
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function exportRice(rice: Rice): string {
  return JSON.stringify(
    {
      name: rice.name,
      blurb: rice.blurb,
      appearance: rice.appearance,
      font: rice.font,
      radius: rice.radius,
      density: rice.density,
      light: rice.light,
      dark: rice.dark,
    },
    null,
    2,
  );
}

export type RiceStore = {
  snapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  select(id: string): void;
  setAppearance(appearance: Appearance): void;
  setFont(font: FontChoice): void;
  setRadius(radius: number): void;
  setDensity(density: Density): void;
  setColor(mode: Scheme, key: keyof Palette, value: string): boolean;
  harmonize(mode: Scheme): void;
  shuffle(mode: Scheme | "both"): void;
  save(name: string): string | null;
  updateSaved(name?: string): string | null;
  remove(id: string): void;
  revert(): void;
  reset(): void;
  exportJson(): string;
  importJson(text: string): string | null;
};

export function createRiceStore(storage: StorageLike, env: RiceEnv): RiceStore {
  let { selectedId, draft, custom } = loadPersisted(storage);
  const listeners = new Set<() => void>();
  let watching = false;
  let unwatch: (() => void) | null = null;

  const find = (id: string) => PRESETS.find((p) => p.id === id) ?? custom.find((c) => c.id === id);

  const base = (): Rice => find(selectedId) ?? PRESETS[0];
  const active = (): Rice => draft ?? base();

  const snapshot = (): Snapshot => {
    const rice = active();
    return {
      presets: PRESETS,
      custom,
      active: cloneRice(rice),
      baseId: base().id,
      dirty: draft !== null && !sameLook(draft, base()),
      scheme: resolveScheme(rice.appearance, env.scheme),
      systemScheme: env.scheme(),
    };
  };

  const ensureWatch = (appearance: Appearance) => {
    if (appearance === "system") {
      if (!watching) {
        watching = true;
        unwatch = env.watchScheme(() => publish());
      }
    } else if (watching) {
      unwatch?.();
      unwatch = null;
      watching = false;
    }
  };

  const publish = () => {
    const rice = active();
    const scheme = resolveScheme(rice.appearance, env.scheme);
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, selectedId, draft, custom }));
    env.apply(isStockHive(rice) ? null : rice, scheme);
    ensureWatch(rice.appearance);
    for (const listener of [...listeners]) listener();
  };

  const edit = (mutator: (rice: Rice) => void) => {
    const next = cloneRice(draft ?? base());
    mutator(next);
    draft = sameLook(next, base()) ? null : next;
    publish();
  };

  const api: RiceStore = {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(id) {
      if (!find(id)) return;
      selectedId = id;
      draft = null;
      publish();
    },
    setAppearance(appearance) {
      edit((rice) => {
        rice.appearance = appearance;
      });
    },
    setFont(font) {
      edit((rice) => {
        rice.font = font;
      });
    },
    setRadius(radius) {
      edit((rice) => {
        rice.radius = clampRadius(radius);
      });
    },
    setDensity(density) {
      edit((rice) => {
        rice.density = density;
      });
    },
    setColor(mode, key, value) {
      const hex = parseHex(value);
      if (!hex) return false;
      if ((draft ?? base())[mode][key] === hex) return true;
      edit((rice) => {
        rice[mode] = { ...rice[mode], [key]: hex };
        if (key === "accent") {
          rice[mode].accentInk = accentInk(hex);
          rice[mode].accentSoft = mix(rice[mode].bg, hex, isDark(rice[mode].bg) ? 0.28 : 0.16);
        }
      });
      return true;
    },
    harmonize(mode) {
      edit((rice) => {
        rice[mode] = harmonize(rice[mode]);
      });
    },
    shuffle(mode) {
      const hue = Math.floor(Math.random() * 360);
      edit((rice) => {
        if (mode === "light" || mode === "both") rice.light = shufflePalette(false, hue);
        if (mode === "dark" || mode === "both") rice.dark = shufflePalette(true, hue);
      });
    },
    save(name) {
      const cleaned = cleanName(name);
      if (!cleaned) return "Use a name up to 40 characters.";
      if (custom.length >= MAX_CUSTOM) return `You can keep up to ${MAX_CUSTOM} rices. Delete one first.`;
      const source = active();
      const origin = base();
      const saved: Rice = {
        ...cloneRice(source),
        id: nextId(),
        name: cleaned,
        blurb: origin.builtin ? `Based on ${origin.name}.` : source.blurb || "Saved in this browser.",
        builtin: false,
      };
      custom = [saved, ...custom];
      selectedId = saved.id;
      draft = null;
      publish();
      return null;
    },
    updateSaved(name) {
      const current = custom.find((c) => c.id === selectedId);
      if (!current) return "Save it as a new rice first.";
      const cleaned = name === undefined || name.trim() === "" ? current.name : cleanName(name);
      if (!cleaned) return "Use a name up to 40 characters.";
      const next = cloneRice(active());
      next.id = current.id;
      next.name = cleaned;
      next.builtin = false;
      next.blurb = current.blurb;
      custom = custom.map((c) => (c.id === current.id ? next : c));
      draft = null;
      publish();
      return null;
    },
    remove(id) {
      if (!custom.some((c) => c.id === id)) return;
      custom = custom.filter((c) => c.id !== id);
      if (selectedId === id) {
        selectedId = "hive";
        draft = null;
      }
      publish();
    },
    revert() {
      draft = null;
      publish();
    },
    reset() {
      selectedId = "hive";
      draft = null;
      publish();
    },
    exportJson() {
      return exportRice(active());
    },
    importJson(text) {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return "That is not a rice file.";
      }
      const parsed = parseRiceRecord(data, nextId(), false);
      if (!parsed) return "Colors need to be hex, like #e8a317, with a light and a dark palette.";
      if (custom.length >= MAX_CUSTOM) return `You can keep up to ${MAX_CUSTOM} rices. Delete one first.`;
      if (!parsed.blurb) parsed.blurb = "Imported rice.";
      custom = [parsed, ...custom];
      selectedId = parsed.id;
      draft = null;
      publish();
      return null;
    },
  };

  publish();
  return api;
}

const CUSTOM_DATASET = ["density", "rice"] as const;

/** Paint `rice` onto the document. `null` restores the stylesheet, including the OS scheme. */
export function applyRiceToDocument(rice: Rice | null, scheme: Scheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!rice) {
    for (const prop of APPLIED_PROPS) root.style.removeProperty(prop);
    for (const key of CUSTOM_DATASET) delete root.dataset[key];
    root.style.colorScheme = "";
    return;
  }
  const colors = rice[scheme];
  for (const key of PALETTE_KEYS) root.style.setProperty(PALETTE_VARS[key], colors[key]);
  const status = isDark(colors.bg) ? DARK_STATUS : LIGHT_STATUS;
  for (const [prop, value] of Object.entries(status)) root.style.setProperty(prop, value);
  root.style.setProperty("--font", FONT_STACK[rice.font]);
  root.style.setProperty("--radius", `${rice.radius}px`);
  root.style.setProperty("--control-radius", `${rice.radius}px`);
  root.dataset.density = rice.density;
  root.dataset.rice = rice.id;
  root.style.colorScheme = scheme;
}

function browserStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "__hivemind_rice_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    // Private mode and some embedded webviews reject storage.
  }
  const memory = new Map<string, string>();
  return { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
}

function browserEnv(): RiceEnv {
  let media: MediaQueryList | null = null;
  let onMedia: (() => void) | null = null;
  return {
    scheme() {
      if (typeof matchMedia !== "function") return "light";
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    },
    watchScheme(onChange) {
      if (typeof matchMedia !== "function") return () => {};
      if (onMedia && media) media.removeEventListener("change", onMedia);
      media = matchMedia("(prefers-color-scheme: dark)");
      onMedia = () => onChange();
      media.addEventListener("change", onMedia);
      return () => {
        if (onMedia && media) media.removeEventListener("change", onMedia);
        onMedia = null;
      };
    },
    apply: applyRiceToDocument,
  };
}

let singleton: RiceStore | null = null;

export function getRiceStore(): RiceStore {
  if (!singleton) singleton = createRiceStore(browserStorage(), browserEnv());
  return singleton;
}

export function bootRice() {
  getRiceStore();
}
