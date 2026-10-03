// Pick a preset rice or build one: colors, type, corners, and density. Stored in this browser.
import { useEffect, useState, type CSSProperties } from "react";
import {
  getRiceStore,
  parseHex,
  type Appearance,
  type Density,
  type FontChoice,
  type Palette,
  type Rice,
  type Scheme,
  type Snapshot,
} from "../rice";
import { ErrorNote, PageHeader } from "../ui";

const APPEARANCE: { id: Appearance; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const FONTS: { id: FontChoice; label: string }[] = [
  { id: "sans", label: "Sans" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "cozy", label: "Cozy" },
  { id: "roomy", label: "Roomy" },
];

const PRIMARY: { key: keyof Palette; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "panel", label: "Surface" },
  { key: "sidebar", label: "Sidebar" },
  { key: "text", label: "Text" },
  { key: "accent", label: "Accent" },
];

const ADVANCED: { key: keyof Palette; label: string }[] = [
  { key: "panel2", label: "Raised surface" },
  { key: "muted", label: "Muted text" },
  { key: "border", label: "Border" },
  { key: "sidebarText", label: "Sidebar text" },
  { key: "accentSoft", label: "Accent wash" },
];

function useRice() {
  const store = getRiceStore();
  const [snap, setSnap] = useState<Snapshot>(() => store.snapshot());
  useEffect(() => store.subscribe(() => setSnap(store.snapshot())), [store]);
  return { store, snap };
}

function mockStyle(palette: Palette): CSSProperties {
  return {
    "--mock-bg": palette.bg,
    "--mock-side": palette.sidebar,
    "--mock-text": palette.text,
    "--mock-accent": palette.accent,
    "--mock-border": palette.border,
  } as CSSProperties;
}

function shownPalette(rice: Rice, scheme: Scheme): Palette {
  if (rice.appearance === "light") return rice.light;
  if (rice.appearance === "dark") return rice.dark;
  return scheme === "dark" ? rice.dark : rice.light;
}

function RiceCard({
  rice,
  selected,
  scheme,
  onSelect,
  onDelete,
}: {
  rice: Rice;
  selected: boolean;
  scheme: Scheme;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className={selected ? "rice-card on" : "rice-card"}>
      <button type="button" className="rice-card-hit" onClick={onSelect} aria-pressed={selected}>
        <span className="rice-mock" style={mockStyle(shownPalette(rice, scheme))}>
          <span className="rice-mock-side" />
          <span className="rice-mock-main">
            <span className="rice-mock-chip" />
            <span className="rice-mock-line" />
            <span className="rice-mock-line short" />
          </span>
        </span>
        <span className="rice-card-copy">
          <span className="rice-card-name">{rice.name}</span>
          <span className="rice-card-blurb">{rice.blurb}</span>
        </span>
      </button>
      {onDelete && (
        <button type="button" className="ghost small danger" onClick={onDelete}>
          Delete
        </button>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="rice-field">
      <span className="rice-field-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button type="button" key={option.id} className={value === option.id ? "on" : ""} aria-pressed={value === option.id} onClick={() => onChange(option.id)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const parsed = parseHex(text);
    if (parsed) onChange(parsed);
    else setText(value);
  };
  return (
    <label className="rice-swatch">
      {label}
      <span className="rice-swatch-input">
        <input type="color" value={value} aria-label={`${label} color`} onChange={(e) => onChange(e.target.value)} />
        <input
          className="mono"
          value={text}
          spellCheck={false}
          aria-label={`${label} hex`}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </span>
    </label>
  );
}

export function RiceView() {
  const { store, snap } = useRice();
  const [paletteMode, setPaletteMode] = useState<Scheme>(snap.scheme);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [copied, setCopied] = useState(false);
  const baseIsCustom = snap.custom.some((rice) => rice.id === snap.baseId);
  const suggested = baseIsCustom ? snap.active.name : `${snap.active.name} custom`;
  const palette = snap.active[paletteMode];

  const report = (err: string | null, ok: string) => {
    setError(err);
    setNotice(err ? null : ok);
  };

  return (
    <div className="page">
      <PageHeader
        title="Rice"
        sub="Make this UI yours. Pick a preset or tune colors, type, corners, and density. Saved in this browser only."
      >
        {snap.dirty && <span className="badge tone-warn">Unsaved</span>}
      </PageHeader>

      <section className="rice-block">
        <h2>Presets</h2>
        <p className="muted small">Choosing one applies it immediately. The rest of the app is the preview.</p>
        <div className="rice-grid">
          {snap.presets.map((rice) => (
            <RiceCard
              key={rice.id}
              rice={snap.baseId === rice.id ? snap.active : rice}
              scheme={snap.scheme}
              selected={snap.baseId === rice.id}
              onSelect={() => {
                store.select(rice.id);
                setError(null);
                setNotice(null);
              }}
            />
          ))}
        </div>
      </section>

      <section className="rice-block">
        <h2>Your rices</h2>
        {snap.custom.length === 0 ? (
          <p className="muted">Nothing saved yet. Tune a look below and save it under your own name.</p>
        ) : (
          <div className="rice-grid">
            {snap.custom.map((rice) => (
              <RiceCard
                key={rice.id}
                rice={snap.baseId === rice.id ? snap.active : rice}
                scheme={snap.scheme}
                selected={snap.baseId === rice.id}
                onSelect={() => {
                  store.select(rice.id);
                  setError(null);
                  setNotice(null);
                }}
                onDelete={() => store.remove(rice.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card form rice-editor">
        <div className="rice-editor-head">
          <div>
            <h2>Tune</h2>
            <p className="muted small">
              Editing <strong>{snap.active.name}</strong>
              {snap.dirty ? " with unsaved changes" : ""}. Light and dark can differ. Appearance chooses which one you see.
            </p>
          </div>
        </div>

        <Segmented label="Appearance" value={snap.active.appearance} options={APPEARANCE} onChange={(id) => store.setAppearance(id)} />
        <Segmented label="Type" value={snap.active.font} options={FONTS} onChange={(id) => store.setFont(id)} />
        <Segmented label="Density" value={snap.active.density} options={DENSITIES} onChange={(id) => store.setDensity(id)} />

        <div className="rice-field">
          <span className="rice-field-label">Corners · {snap.active.radius}px</span>
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={snap.active.radius}
            aria-label="Corner radius"
            onChange={(e) => store.setRadius(Number(e.target.value))}
          />
        </div>

        <Segmented
          label="Palette"
          value={paletteMode}
          options={[
            { id: "light", label: "Light colors" },
            { id: "dark", label: "Dark colors" },
          ]}
          onChange={setPaletteMode}
        />

        <div className="rice-swatches">
          {PRIMARY.map((field) => (
            <ColorField key={field.key} label={field.label} value={palette[field.key]} onChange={(hex) => store.setColor(paletteMode, field.key, hex)} />
          ))}
        </div>
        <details className="rice-advanced">
          <summary>More colors</summary>
          <div className="rice-swatches">
            {ADVANCED.map((field) => (
              <ColorField key={field.key} label={field.label} value={palette[field.key]} onChange={(hex) => store.setColor(paletteMode, field.key, hex)} />
            ))}
          </div>
        </details>

        <div className="row">
          <button type="button" onClick={() => store.harmonize(paletteMode)}>
            Harmonize {paletteMode}
          </button>
          <button type="button" onClick={() => store.shuffle(paletteMode)}>
            Shuffle {paletteMode}
          </button>
          <button type="button" onClick={() => store.shuffle("both")}>
            Shuffle both
          </button>
          <button type="button" onClick={() => store.revert()} disabled={!snap.dirty}>
            Revert
          </button>
          <button type="button" className="ghost" onClick={() => store.reset()}>
            Hivemind default
          </button>
        </div>

        <div className="rice-save">
          <label>
            Name
            <input value={name} placeholder={suggested} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => {
                const err = store.save(name.trim() || suggested);
                report(err, `Saved "${name.trim() || suggested}".`);
                if (!err) setName("");
              }}
            >
              Save as new
            </button>
            {baseIsCustom && (
              <button
                type="button"
                onClick={() => report(store.updateSaved(name), name.trim() ? "Updated." : `Updated "${snap.active.name}".`)}
                disabled={!snap.dirty && name.trim() === ""}
              >
                Update saved
              </button>
            )}
          </div>
        </div>
        <ErrorNote error={error} />
        {notice && <div className="ok-note">{notice}</div>}

        <details className="rice-advanced">
          <summary>Share this rice</summary>
          <p className="muted small">Copy the JSON into another browser, or paste one you were given. Only colors and type come along.</p>
          <textarea className="mono" readOnly rows={8} value={store.exportJson()} aria-label="Rice JSON" />
          <div className="row">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  .writeText(store.exportJson())
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy JSON"}
            </button>
          </div>
          <label>
            Import JSON
            <textarea
              className="mono"
              rows={5}
              value={importText}
              placeholder="Paste a rice JSON export"
              onChange={(e) => setImportText(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                const err = store.importJson(importText);
                report(err, "Imported.");
                if (!err) setImportText("");
              }}
              disabled={importText.trim() === ""}
            >
              Import
            </button>
            <label className="rice-file">
              Load a file
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  file
                    .text()
                    .then((text) => report(store.importJson(text), `Imported ${file.name}.`))
                    .catch(() => report("Could not read that file.", ""));
                }}
              />
            </label>
          </div>
        </details>
      </section>
    </div>
  );
}
