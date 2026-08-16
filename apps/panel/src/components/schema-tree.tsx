import { useState } from 'react'
import { Button } from 'react-aria-components'

import { walkSchema } from '../lib'
import type { SchemaNode } from '../lib'

import { ChevronIcon } from './icons'

/** Recursive collapsible renderer for manifest schema documents (lib/schema walker). */

const NodeRow = ({ node, depth }: { readonly node: SchemaNode; readonly depth: number }) => {
  const [open, setOpen] = useState(depth < 3)
  const hasChildren = node.children.length > 0

  return (
    <div>
      <div className='flex min-h-6 items-center gap-2'>
        {hasChildren ? (
          <Button
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name ?? node.type}`}
            className='text-muted data-hovered:text-ink -ml-1 rounded p-0.5'
            onPress={() => setOpen(value => !value)}>
            <ChevronIcon className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          </Button>
        ) : (
          <span aria-hidden='true' className='w-[15px] shrink-0' />
        )}
        {node.name === undefined ? null : (
          <span className='text-ink font-mono text-[12.5px]'>{node.name}</span>
        )}
        {node.required ? <span className='text-danger -ml-1 font-bold'>*</span> : null}
        <span className='text-accent text-xs'>
          {node.declared ? 'declared — opaque' : node.type}
        </span>
        {node.description === undefined ? null : (
          <span className='text-muted truncate text-xs' title={node.description}>
            {node.description}
          </span>
        )}
      </div>
      {hasChildren && open ? (
        <div className='border-line ml-[7px] border-l pl-3.5'>
          {node.children.map((child, index) => (
            <NodeRow key={child.name ?? `#${index}`} depth={depth + 1} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const SchemaTree = ({ schema }: { readonly schema: unknown }) => (
  <div className='text-[13px]'>
    <NodeRow depth={0} node={walkSchema(schema)} />
  </div>
)
