// oxlint-disable import/exports-last
/** The trace list: one ROOT span per trace, newest first, live prepends, cursor-paged. */
import type { SpanRow } from '../lib/api'
import { fmtMs, outcomeColor, serviceColor, statusText } from '../lib/format'

export const matches = (row: SpanRow, filter: string): boolean =>
  filter.length === 0 ||
  [
    row.name,
    row.service_name,
    row.service_instance_id,
    row.error_type,
    row.http_route,
    row.trace_id,
    row.request_id,
  ].some(part => (part ?? '').toLowerCase().includes(filter))

/** A service badge: the `service.name`, colored per service; the instance on hover (or shown
 * when asked). */
export const ServiceBadge = ({ span, instance }: { span: SpanRow; instance?: boolean }) => (
  <span
    className='tag'
    title={`${span.service_name} @ ${span.service_instance_id}`}
    style={{ color: serviceColor(span.service_name) }}>
    {span.service_name}
    {instance ? `@${span.service_instance_id}` : ''}
  </span>
)

interface Props {
  readonly rows: readonly SpanRow[]
  readonly filter: string
  readonly selected: string | null
  readonly exhausted: boolean
  readonly loading: boolean
  readonly onOpen: (traceId: string) => void
  readonly onMore: () => void
}

export const TraceList = ({
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
          key={row.trace_id}
          className='row-hover grid cursor-pointer grid-cols-[88px_1fr_56px_64px] items-center gap-2 border-b px-3 py-1.5'
          style={{
            borderColor: 'var(--line)',
            background: selected === row.trace_id ? '#1d2230' : undefined,
          }}
          onClick={() => onOpen(row.trace_id)}>
          <span style={{ color: 'var(--dim)' }}>
            {new Date(row.start).toLocaleTimeString([], { hour12: false })}
          </span>
          <span className='truncate'>
            <ServiceBadge span={row} />
            {row.name}
          </span>
          <span className='truncate text-right' style={{ color: outcomeColor(row) }}>
            {statusText(row)}
          </span>
          <span className='text-right' style={{ color: 'var(--dim)' }}>
            {fmtMs(row.duration_ms)}
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
        no traces yet
      </div>
    )}
  </section>
)
