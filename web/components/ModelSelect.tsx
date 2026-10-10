'use client'

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type Option = { key: string; label: string; value: string | undefined; kind: 'default' | 'model' | 'custom' }

const PANEL_MAX_HEIGHT = 340
const GAP = 4

/** Every whitespace-separated token must appear somewhere in the text, in any order. */
function matches(text: string, query: string) {
  const haystack = text.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(token => haystack.includes(token))
}

/**
 * Searchable model picker. The closed state is a select-like button; the open state is a listbox in a
 * `position: fixed` portal (so `.table-wrap`'s overflow can't clip it) with a search box that doubles
 * as the combobox input. `value === undefined` means "harness default".
 */
export default function ModelSelect({ value, models, loading, placeholder, disabled, title, label, onChange, error, onRetry }: {
  value: string | undefined
  models: string[]
  loading: boolean
  placeholder: string
  disabled: boolean
  title?: string
  label: string
  onChange: (value: string | undefined) => void
  /** Last list error, shown when the list is empty. */
  error?: string
  /** Called when the panel opens with no models, so the list can be re-fetched. */
  onRetry?: () => void
}) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const options = useMemo(() => {
    const trimmed = query.trim()
    const result: Option[] = []
    if (!trimmed || matches('harness default', trimmed)) result.push({ key: 'default', label: 'Harness default', value: undefined, kind: 'default' })
    // A custom value that isn't in the fetched list still has to show up (and be marked selected).
    const all = value && !models.includes(value) ? [value, ...models] : models
    for (const model of all) if (!trimmed || matches(model, trimmed)) result.push({ key: `m:${model}`, label: model, value: model, kind: 'model' })
    if (trimmed && !/\s/.test(trimmed) && !all.includes(trimmed)) result.push({ key: 'custom', label: `Use "${trimmed}"`, value: trimmed, kind: 'custom' })
    return result
  }, [models, query, value])
  const modelCount = options.filter(option => option.kind === 'model').length
  const clamped = Math.min(active, options.length - 1)
  const optionId = (index: number) => `${id}-opt-${index}`

  function openPanel() {
    if (disabled) return
    setQuery('')
    const selected = [undefined, ...(value && !models.includes(value) ? [value] : []), ...models].indexOf(value)
    setActive(Math.max(selected, 0))
    setOpen(true)
    if (models.length === 0 && !loading) onRetry?.()
  }
  function closePanel(refocus: boolean) {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  function choose(option: Option | undefined) {
    if (!option) return
    onChange(option.value)
    closePanel(true)
  }

  // Anchor the panel to the trigger; flip above when there is more room there.
  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const box = trigger.current?.getBoundingClientRect()
      if (!box) return
      const below = window.innerHeight - box.bottom - GAP - 8
      const above = box.top - GAP - 8
      const flip = below < Math.min(PANEL_MAX_HEIGHT, 220) && above > below
      const width = Math.max(box.width, 360)
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8))
      setRect(flip
        ? { left, width, bottom: window.innerHeight - box.top + GAP, maxHeight: Math.min(PANEL_MAX_HEIGHT, above) }
        : { left, width, top: box.bottom + GAP, maxHeight: Math.min(PANEL_MAX_HEIGHT, below) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (open && rect) search.current?.focus({ preventScroll: true })
  }, [open, rect === null]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    function away(event: PointerEvent) {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[id="${optionId(clamped)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, clamped, options.length]) // eslint-disable-line react-hooks/exhaustive-deps

  function onSearchKey(event: React.KeyboardEvent) {
    const last = options.length - 1
    switch (event.key) {
      case 'ArrowDown': setActive(Math.min(clamped + 1, last)); break
      case 'ArrowUp': setActive(Math.max(clamped - 1, 0)); break
      case 'Home': setActive(0); break
      case 'End': setActive(last); break
      case 'Enter': choose(options[clamped]); break
      case 'Escape': closePanel(true); break
      case 'Tab': setOpen(false); return
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const shown = value ?? ''
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className={`combo-trigger mono${shown ? '' : ' placeholder'}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        title={disabled ? title : shown || undefined}
        onClick={() => (open ? closePanel(false) : openPanel())}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) openPanel() }
        }}
      >
        <span className="combo-value">{shown || placeholder}</span>
        <span className="combo-caret" aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={panel}
          className="combo-panel"
          style={{ left: rect?.left ?? 0, width: rect?.width, top: rect?.top, bottom: rect?.bottom, maxHeight: rect?.maxHeight, visibility: rect ? 'visible' : 'hidden' }}
        >
          <input
            ref={search}
            className="combo-search"
            type="text"
            role="combobox"
            aria-label="Search models"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={options.length ? optionId(clamped) : undefined}
            placeholder="Search models…"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={event => { setQuery(event.target.value); setActive(0) }}
            onKeyDown={onSearchKey}
          />
          <ul ref={list} id={listId} role="listbox" aria-label="Models" className="combo-list">
            {options.map((option, index) => (
              <li
                key={option.key}
                id={optionId(index)}
                role="option"
                aria-selected={option.kind !== 'custom' && option.value === value}
                className={`combo-option${option.kind === 'model' || option.kind === 'custom' ? ' mono' : ''}${index === clamped ? ' active' : ''}`}
                onMouseDown={event => event.preventDefault()}
                onMouseMove={() => index !== clamped && setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="combo-check" aria-hidden="true">{option.kind !== 'custom' && option.value === value ? '✓' : ''}</span>
                <span className="combo-label">{option.label}</span>
              </li>
            ))}
          </ul>
          {loading && <div className="combo-status" role="status"><span className="spinner" aria-hidden="true" />Loading models…</div>}
          {!loading && modelCount === 0 && <div className="combo-status" role="status">{query.trim() ? 'No matching models' : error ? `Could not load models: ${error}` : 'No models available'}</div>}
        </div>,
        document.body,
      )}
    </>
  )
}
