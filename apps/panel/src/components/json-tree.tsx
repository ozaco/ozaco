/** A collapsible JSON view; huge payloads fall back to flat text. */
import { useState } from 'react'

const LIMIT = 300_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const Leaf = ({ value }: { value: unknown }) => {
  const color =
    typeof value === 'string'
      ? 'var(--ok)'
      : typeof value === 'number'
        ? 'var(--accent)'
        : typeof value === 'boolean'
          ? 'var(--warn)'
          : 'var(--dim)'
  return <span style={{ color }}>{JSON.stringify(value)}</span>
}

const Node = ({ name, value, depth }: { name: string | null; value: unknown; depth: number }) => {
  const [open, setOpen] = useState(depth < 2)
  const container = isRecord(value) || Array.isArray(value)
  const entries = container
    ? Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value)
    : []
  const label = name === null ? null : <span style={{ color: 'var(--fg)' }}>{name}: </span>
  if (!container) {
    return (
      <div style={{ paddingLeft: depth * 14 }}>
        {label}
        <Leaf value={value} />
      </div>
    )
  }
  const brackets = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  return (
    <div>
      <div style={{ paddingLeft: depth * 14, cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <span style={{ color: 'var(--dim)', display: 'inline-block', width: 12 }}>
          {open ? '▾' : '▸'}
        </span>
        {label}
        <span style={{ color: 'var(--dim)' }}>
          {brackets[0]}
          {open ? '' : ` ${entries.length} ${brackets[1]}`}
        </span>
      </div>
      {open &&
        entries.map(([key, item]) => <Node key={key} name={key} value={item} depth={depth + 1} />)}
      {open && <div style={{ paddingLeft: depth * 14, color: 'var(--dim)' }}>{brackets[1]}</div>}
    </div>
  )
}

export const JsonTree = ({ value }: { value: unknown }) => {
  const text = JSON.stringify(value, null, 2) ?? 'undefined'
  if (text.length > LIMIT) {
    return <pre className='mono break-all whitespace-pre-wrap'>{text}</pre>
  }
  return (
    <div className='mono'>
      <Node name={null} value={value} depth={0} />
    </div>
  )
}
