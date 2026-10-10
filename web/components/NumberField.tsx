'use client'

import { useEffect, useState } from 'react'

/** Integer input that tolerates an empty/invalid intermediate string while the user types. */
export default function NumberField({ id, value, min, max, onChange }: {
  id: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(current => (Number(current) === value ? current : String(value))) }, [value])
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      onChange={event => {
        setText(event.target.value)
        const parsed = Number(event.target.value)
        if (event.target.value.trim() !== '' && Number.isFinite(parsed)) onChange(parsed)
      }}
    />
  )
}
