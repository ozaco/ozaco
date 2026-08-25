// oxlint-disable import/exports-last
/** The request list: newest first, live prepends, cursor-paged infinite scroll. */
import type { RequestRow } from '../lib/api'

export const nameOf = (row: RequestRow): string =>
  row.method
    ? `${row.method} ${row.path}`
    : row.socket
      ? `WS ${row.socket}`
      : row.service
        ? `${row.service}.${row.action}`
        : 'request'

export const matches = (row: RequestRow, filter: string): boolean =>
  filter.length === 0 ||
  [row.service, row.action, row.error, row.path, row.socket].some(part =>
    (part ?? '').toLowerCase().includes(filter),
  )

interface Props {
  readonly rows: readonly RequestRow[]
  readonly filter: string
  readonly selected: string | null
  readonly exhausted: boolean
  readonly loading: boolean
  readonly onOpen: (requestId: string) => void
  readonly onMore: () => void
}

export const RequestList = ({
  rows,
  filter,
  selected,
  exhausted,
  loading,
  onOpen,
  onMore,
}: Props) => (
  <section
    className='h-full overflow-auto border-r'
    style={{ borderColor: 'var(--line)' }}
    onScroll={event => {
      const el = event.currentTarget

      if (!loading && !exhausted && el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
        onMore()
      }
    }}>
    {rows
      .filter(row => matches(row, filter))
      .map(row => (
        <div
          key={row.request_id}
          className='row-hover grid cursor-pointer grid-cols-[72px_1fr_60px_64px] gap-2 border-b px-3 py-1.5'
          style={{
            borderColor: 'var(--line)',
            background: selected === row.request_id ? '#1d2230' : undefined,
          }}
          onClick={() => onOpen(row.request_id)}>
          <span style={{ color: 'var(--dim)' }}>
            {new Date(row.started_at).toLocaleTimeString()}
          </span>
          <span className='truncate'>
            {nameOf(row)} <span style={{ color: 'var(--dim)' }}>{row.lane}</span>
          </span>
          <span className='text-right' style={{ color: row.error ? 'var(--bad)' : 'var(--ok)' }}>
            {row.status ?? ''}
          </span>
          <span className='text-right' style={{ color: 'var(--dim)' }}>
            {row.duration_ms === null ? '' : `${row.duration_ms}ms`}
          </span>
        </div>
      ))}
    {!exhausted && (
      <div className='p-4' style={{ color: 'var(--dim)' }}>
        {loading ? 'loading…' : 'scroll for more'}
      </div>
    )}
    {exhausted && rows.length === 0 && (
      <div className='p-6' style={{ color: 'var(--dim)' }}>
        no requests yet
      </div>
    )}
  </section>
)
