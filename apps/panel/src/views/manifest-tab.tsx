import { useMemo } from 'react'

import { CopyButton } from '../components/copy'
import { JsonTree } from '../components/json-tree'
import { MethodChip, UrlBarShell } from '../components/url-bar'
import type { Manifest } from '../lib'

/** The raw manifest document as a special read-only tab: source URL bar + collapsible tree. */
export const ManifestTab = ({
  manifest,
  sourceUrl,
}: {
  readonly manifest: Manifest
  readonly sourceUrl: string
}) => {
  const text = useMemo(() => JSON.stringify(manifest, null, 2), [manifest])

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <UrlBarShell>
        <MethodChip label='GET' textClass='text-get' />
        <div className='border-line bg-surface flex h-7 min-w-0 flex-1 items-center overflow-x-auto rounded border px-2.5 font-mono text-[12.5px] whitespace-nowrap'>
          <span className='text-ink'>{sourceUrl}</span>
        </div>
        <CopyButton label='Copy manifest JSON' text={text} />
      </UrlBarShell>
      <div className='min-h-0 flex-1 overflow-auto p-3'>
        <JsonTree value={manifest} />
      </div>
    </div>
  )
}
