import { Button } from 'react-aria-components'

import { CloseIcon } from './icons'

/**
 * Postman-style strip of open request tabs. Every open request is a closable tab: colored
 * protocol/method dot + name, close X on hover (always on the active tab), middle-click close,
 * horizontal overflow scrolls. Opening from the sidebar adds or refocuses a tab.
 */

/** What a tab points at — the workspace renders one live view per open spec. */
export type TabSpec =
  | { readonly kind: 'http'; readonly fnId: string }
  | { readonly kind: 'ws'; readonly service: string | null }
  | { readonly kind: 'sse'; readonly service: string }
  | { readonly kind: 'manifest' }

/** Stable identity of a spec — one tab per target, reopening focuses it. */
export const tabIdOf = (spec: TabSpec): string => {
  switch (spec.kind) {
    case 'http': {
      return `http:${spec.fnId}`
    }
    case 'ws': {
      return `ws:${spec.service ?? '~custom'}`
    }
    case 'sse': {
      return `sse:${spec.service}`
    }
    default: {
      return 'manifest'
    }
  }
}

export interface TabItem {
  readonly id: string
  readonly label: string
  /** Method/protocol dot color utility (`bg-get`, `bg-socket`, ...). */
  readonly dotClass: string
  readonly hint: string
}

export const TabStrip = ({
  tabs,
  activeId,
  onSelect,
  onClose,
}: {
  readonly tabs: readonly TabItem[]
  readonly activeId: string | null
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
}) => (
  <div className='border-line bg-panel flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b'>
    {tabs.map(tab => {
      const active = tab.id === activeId

      return (
        <div
          key={tab.id}
          className={`group border-line relative flex shrink-0 items-center border-r ${
            active ? 'bg-surface' : ''
          }`}
          onAuxClick={event => {
            if (event.button === 1) {
              onClose(tab.id)
            }
          }}>
          {active ? (
            <span aria-hidden='true' className='bg-accent absolute inset-x-0 top-0 h-0.5' />
          ) : null}
          <Button
            {...(active ? { 'aria-current': 'true' as const } : {})}
            aria-label={`Open tab ${tab.hint}`}
            className={`flex h-full items-center gap-2 py-0 pr-1 pl-3 text-[12.5px] outline-none ${
              active ? 'text-ink' : 'text-muted data-hovered:text-ink'
            }`}
            onPress={() => onSelect(tab.id)}>
            <span aria-hidden='true' className={`h-2 w-2 shrink-0 rounded-full ${tab.dotClass}`} />
            <span className='max-w-44 truncate' title={tab.hint}>
              {tab.label}
            </span>
          </Button>
          <Button
            aria-label={`Close tab ${tab.hint}`}
            className={`text-muted data-hovered:text-danger mr-1.5 rounded p-0.5 group-hover:opacity-100 data-focus-visible:opacity-100 ${
              active ? 'opacity-60' : 'opacity-0'
            }`}
            onPress={() => onClose(tab.id)}>
            <CloseIcon height={11} width={11} />
          </Button>
        </div>
      )
    })}
  </div>
)
