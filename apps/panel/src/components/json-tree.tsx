import { useMemo, useState } from 'react'
import { Button } from 'react-aria-components'

import { ChevronIcon } from './icons'

/**
 * Collapsible pretty-JSON tree: objects/arrays fold (open to depth 3 by default), primitives get
 * lightweight syntax color. Documents past the size budget render as flat preformatted text.
 */

const FLAT_LIMIT = 300_000

const primitiveClass = (value: unknown): string => {
  if (typeof value === 'string') {
    return 'text-ok'
  }

  return typeof value === 'number' ? 'text-post' : 'text-stream'
}

const pairsOf = (value: object): readonly (readonly [string, unknown])[] =>
  Array.isArray(value)
    ? (value as readonly unknown[]).map((item, index) => [String(index), item] as const)
    : Object.entries(value)

const JsonNode = ({
  name,
  value,
  depth,
}: {
  readonly name: string | undefined
  readonly value: unknown
  readonly depth: number
}) => {
  const [open, setOpen] = useState(depth < 3)
  const composite = typeof value === 'object' && value !== null
  const pairs = composite ? pairsOf(value) : []

  const label =
    name === undefined ? null : (
      <span className='shrink-0'>
        <span className='text-accent'>{name}</span>
        <span className='text-muted'>: </span>
      </span>
    )

  if (!composite) {
    return (
      <div className='flex min-w-0 items-start pl-4'>
        {label}
        <span className={`min-w-0 break-all whitespace-pre-wrap ${primitiveClass(value)}`}>
          {JSON.stringify(value) ?? 'undefined'}
        </span>
      </div>
    )
  }

  if (pairs.length === 0) {
    return (
      <div className='flex min-w-0 items-start pl-4'>
        {label}
        <span className='text-muted'>{Array.isArray(value) ? '[]' : '{}'}</span>
      </div>
    )
  }

  return (
    <div>
      <div className='flex items-center'>
        <Button
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${name ?? 'root'}`}
          className='text-muted data-hovered:text-ink w-4 shrink-0 rounded outline-none'
          onPress={() => setOpen(prev => !prev)}>
          <ChevronIcon className={open ? 'rotate-90' : ''} height={11} width={11} />
        </Button>
        {label}
        <span className='text-muted'>
          {Array.isArray(value) ? `array · ${pairs.length}` : `object · ${pairs.length}`}
        </span>
      </div>
      {open ? (
        <div className='border-line ml-[5px] border-l pl-2.5'>
          {pairs.map(([key, item]) => (
            <JsonNode key={key} depth={depth + 1} name={key} value={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const JsonTree = ({ value }: { readonly value: unknown }) => {
  const flat = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? 'undefined'
    } catch {
      return String(value)
    }
  }, [value])

  if (flat.length > FLAT_LIMIT) {
    return (
      <pre className='font-mono text-[12.5px] leading-5 whitespace-pre-wrap'>
        <code>{flat}</code>
      </pre>
    )
  }

  return (
    <div className='font-mono text-[12.5px] leading-5'>
      <JsonNode depth={0} name={undefined} value={value} />
    </div>
  )
}
