// oxlint-disable import/exports-last
import { MethodTag, WsTag } from './badges'

export interface TabSpec {
  readonly id: string
  readonly kind: 'http' | 'socket' | 'manifest'
  readonly title: string
  readonly method?: string | undefined
}

interface Props {
  readonly tabs: readonly TabSpec[]
  readonly active: string | null
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
}

export const TabStrip = ({ tabs, active, onSelect, onClose }: Props) => (
  <div
    className='flex h-[34px] shrink-0 items-stretch overflow-x-auto border-b'
    style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
    {tabs.map(tab => (
      <div
        key={tab.id}
        className='flex max-w-[220px] cursor-pointer items-center gap-2 border-r px-3 text-[12px]'
        style={{
          borderColor: 'var(--line)',
          background: tab.id === active ? 'var(--bg)' : 'transparent',
          color: tab.id === active ? 'var(--fg)' : 'var(--dim)',
        }}
        onClick={() => onSelect(tab.id)}
        onAuxClick={event => {
          if (event.button === 1) {
            onClose(tab.id)
          }
        }}>
        {tab.kind === 'http' && tab.method && <MethodTag method={tab.method} />}
        {tab.kind === 'socket' && <WsTag />}
        <span className='truncate'>{tab.title}</span>
        <button
          className='ml-1 opacity-60 hover:opacity-100'
          onClick={event => {
            event.stopPropagation()
            onClose(tab.id)
          }}>
          ×
        </button>
      </div>
    ))}
    {tabs.length === 0 && (
      <div className='self-center px-3 text-[12px]' style={{ color: 'var(--dim)' }}>
        pick a request on the left
      </div>
    )}
  </div>
)
