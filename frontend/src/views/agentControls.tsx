// Form controls for the agent editor: a searchable model picker, single-choice chips, check lists
// and a server-side folder browser.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, type DirListing, type ModelOption } from "../api";

/* ---------- Single choice ---------- */

export type ChoiceOption<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean };

/** One of a few options, shown as radio cards. */
export function Choice<T extends string>(props: {
  legend: string;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  note?: string;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={`field choice ${props.className ?? ""}`}>
      <legend>{props.legend}</legend>
      <div className="choice-row">
        {props.options.map((o) => (
          <label key={o.value} className="choice-item" data-on={o.value === props.value} data-disabled={o.disabled === true}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === props.value}
              disabled={o.disabled}
              onChange={() => props.onChange(o.value)}
            />
            <span className="choice-label">{o.label}</span>
            {o.hint && <span className="choice-hint">{o.hint}</span>}
          </label>
        ))}
      </div>
      {props.note && <p className="field-note">{props.note}</p>}
    </fieldset>
  );
}

/* ---------- Check list ---------- */

export type CheckOption = { value: string; label?: string; hint?: string };

/** Pick any number of options; `addLabel` also lets the user add values that are not listed yet. */
export function CheckList(props: {
  legend: string;
  description?: string;
  options: CheckOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  addLabel?: string;
  columns?: "wide" | "narrow";
}) {
  const [draft, setDraft] = useState("");
  const listed = new Set(props.options.map((o) => o.value));
  // Values saved on the agent but absent from the catalog stay visible so they are not lost silently.
  const all: CheckOption[] = [...props.options, ...props.selected.filter((v) => !listed.has(v)).map((value) => ({ value }))];
  const toggle = (value: string) =>
    props.onChange(props.selected.includes(value) ? props.selected.filter((v) => v !== value) : [...props.selected, value]);
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!props.selected.includes(value)) props.onChange([...props.selected, value]);
    setDraft("");
  };
  return (
    <fieldset className="field checklist">
      <legend>
        {props.legend}
        <span className="count" data-empty={props.selected.length === 0}>
          {props.selected.length} selected
        </span>
        {props.selected.length > 0 && (
          <button type="button" className="link" onClick={() => props.onChange([])}>
            Clear
          </button>
        )}
      </legend>
      {props.description && <p className="field-note">{props.description}</p>}
      <div className="check-grid" data-columns={props.columns ?? "wide"}>
        {all.map((o) => {
          const on = props.selected.includes(o.value);
          return (
            <label key={o.value} className="check-item" data-on={on} title={o.hint}>
              <input type="checkbox" checked={on} onChange={() => toggle(o.value)} />
              <span className="check-text">
                <span className="check-name">{o.label || o.value}</span>
                {o.hint && <span className="check-hint">{o.hint}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {props.addLabel && (
        <div className="check-add">
          <input
            aria-label={props.addLabel}
            placeholder={props.addLabel}
            value={draft}
            onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>
      )}
    </fieldset>
  );
}

/* ---------- Model picker ---------- */

/** A searchable list of the runtime's models. Any text is still accepted, for models it does not list. */
export function ModelPicker(props: {
  value: string;
  onChange: (id: string, model: ModelOption | undefined) => void;
  models: ModelOption[] | null;
  loading: boolean;
  error: string | null;
  source: string;
  onReload: () => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(0);
  const { value, models } = props;

  const shown = useMemo(() => {
    if (!models) return [];
    const q = typed ? value.trim().toLowerCase() : "";
    return q ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : models;
  }, [models, value, typed]);
  const groups = useMemo(() => {
    const by = new Map<string, ModelOption[]>();
    for (const m of shown) by.set(m.provider, [...(by.get(m.provider) ?? []), m]);
    return [...by];
  }, [shown]);
  const current = models?.find((m) => m.id === value);

  useEffect(() => setActive(0), [shown]);
  useEffect(() => {
    if (open) root.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (model: ModelOption) => {
    props.onChange(model.id, model);
    setOpen(false);
    setTyped(false);
  };

  return (
    <div
      className="field combo"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) (setOpen(false), setTyped(false));
      }}
    >
      <label htmlFor={id}>Model</label>
      <div className="combo-input">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={models ? "Runtime default · type to search" : "provider/model-id (optional)"}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            props.onChange((e.target as HTMLInputElement).value, undefined);
            setTyped(true);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(Math.max(a + (e.key === "ArrowDown" ? 1 : -1), 0), Math.max(shown.length - 1, 0)));
            } else if (e.key === "Enter" && open && shown[active]) {
              e.preventDefault();
              pick(shown[active]);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
        {value && (
          <button
            type="button"
            className="clear"
            aria-label="Clear selection"
            onClick={() => {
              props.onChange("", undefined);
              setTyped(false);
            }}
          >
            ×
          </button>
        )}
      </div>
      {open && models && (
        <div className="combo-list" id={`${id}-list`} role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {groups.length === 0 && <div className="combo-empty">No listed model matches. The text is used as typed.</div>}
          {groups.map(([provider, items]) => (
            <div key={provider} role="group" aria-label={provider}>
              <div className="combo-group">{provider}</div>
              {items.map((m) => (
                <div
                  key={m.id}
                  role="option"
                  aria-selected={m.id === value}
                  data-active={shown[active]?.id === m.id}
                  className="combo-option"
                  onMouseMove={() => setActive(shown.indexOf(m))}
                  onClick={() => pick(m)}
                >
                  <span className="combo-name">{m.name}</span>
                  <span className="combo-id mono">{m.id.slice(provider.length + 1)}</span>
                  {m.reasoning.length > 0 && <span className="combo-tag">reasoning</span>}
                  {m.id === value && <span className="combo-check">✓</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <p className="field-note" data-tone={props.error ? "bad" : undefined}>
        {props.loading
          ? `Loading ${props.source} models…`
          : props.error
            ? `Could not list ${props.source} models (${props.error}). You can still type a model id.`
            : !value
              ? `${props.source} picks its own default model.`
              : models && !current
                ? "Not in the runtime's list. It is used exactly as typed."
                : current && current.context_window
                  ? `${current.provider} · ${Math.round(current.context_window / 1000)}K context`
                  : current?.provider}
        {models && !props.loading && (
          <>
            {" "}
            <button type="button" className="link" onClick={props.onReload}>
              Reload list
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/* ---------- Folder browser ---------- */

/** Browse the folders of the machine Hivemind runs on and choose one. */
export function FolderPicker(props: { start: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [target, setTarget] = useState(props.start.startsWith("/") ? props.start : "");
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .dirs(target, hidden)
      .then((l) => live && (setListing(l), setError(null)))
      .catch((e: Error) => {
        if (!live) return;
        setError(e.message);
        // A stale or mistyped starting path falls back to the default folder once.
        if (target) setTarget("");
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [target, hidden]);

  const crumbs = useMemo(() => {
    if (!listing) return [];
    const parts = listing.path.split("/").filter(Boolean);
    return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
  }, [listing]);

  return (
    <div className="folder-picker" role="dialog" aria-label="Choose a folder">
      <div className="folder-bar">
        <button type="button" className="small" disabled={!listing?.parent} onClick={() => listing?.parent && setTarget(listing.parent)}>
          ↑ Up
        </button>
        <button type="button" className="small" disabled={!listing?.home} onClick={() => listing?.home && setTarget(listing.home)}>
          Home
        </button>
        <nav className="crumbs" aria-label="Current folder">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 1 && <span className="sep">/</span>}
              {(listing?.roots ?? []).length === 0 || listing?.roots.some((r) => c.path === r || c.path.startsWith(`${r}/`)) ? (
                <button type="button" className="link" onClick={() => setTarget(c.path)}>
                  {c.name}
                </button>
              ) : (
                <span className="muted">{c.name}</span>
              )}
            </span>
          ))}
        </nav>
        <label className="inline-check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden((e.target as HTMLInputElement).checked)} />
          Hidden
        </label>
      </div>
      {error && <div className="error-note">{error}</div>}
      <ul className="folder-list" aria-label="Folders" data-loading={loading}>
        {listing?.entries.length === 0 && <li className="muted empty-row">No subfolders here.</li>}
        {listing?.entries.map((e) => (
          <li key={e.path}>
            <button type="button" onClick={() => setTarget(e.path)}>
              <span aria-hidden>📁</span> {e.name}
            </button>
          </li>
        ))}
        {listing?.truncated && <li className="muted empty-row">Only the first folders are shown. Type the path instead.</li>}
      </ul>
      <div className="folder-foot">
        <span className="mono small grow ellipsis" title={listing?.path}>
          {listing?.path ?? ""}
        </span>
        {listing?.native_picker && (
          <button
            type="button"
            disabled={dialog}
            title="Opens your desktop's folder dialog"
            onClick={() => {
              setDialog(true);
              setError(null);
              api
                .pickFolder(listing.path)
                .then((r) => r.path && props.onPick(r.path))
                .catch((e: Error) => setError(e.message))
                .finally(() => setDialog(false));
            }}
          >
            {dialog ? "Waiting for dialog…" : "System dialog…"}
          </button>
        )}
        <button type="button" className="ghost" onClick={props.onClose}>
          Close
        </button>
        <button type="button" className="primary" disabled={!listing} onClick={() => listing && props.onPick(listing.path)}>
          Use this folder
        </button>
      </div>
    </div>
  );
}
