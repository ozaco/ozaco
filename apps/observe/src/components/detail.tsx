// oxlint-disable import/exports-last
/**
 * One trace: its failures (the exception records, each with its cause chain), then the span
 * waterfall — indented by parent, a service badge per span, span events and the span's log
 * records inline under it; a span expands into its attributes, links (same trace ⇒ scroll to the
 * span, another trace ⇒ open it) and resource.
 */
import { useEffect, useMemo, useState } from 'react'

import type { Attributes, Link, LogRow, SpanEvent, SpanRow, TraceView } from '../lib/api'
import { isExceptionLog } from '../lib/api'
import {
  fmtMs,
  fmtTime,
  fmtValue,
  outcomeColor,
  serviceColor,
  severityColor,
  severityOf,
  statusText,
} from '../lib/format'
import type { Placed } from '../lib/trace'
import { inlineEvents, treeOf } from '../lib/trace'

import { ServiceBadge } from './list'

const Heading = ({ children }: { children: string }) => (
  <h3 className='mt-4 mb-1.5 text-[12px] tracking-wider uppercase' style={{ color: 'var(--dim)' }}>
    {children}
  </h3>
)

const Pre = ({ children }: { children: string }) => (
  <pre
    className='my-1 overflow-auto rounded border p-2 whitespace-pre-wrap'
    style={{ background: 'var(--bg)', borderColor: 'var(--line)' }}>
    {children}
  </pre>
)

/** Attributes as a key / value grid (`exception.*` keys are the exception block's). */
const AttrTable = ({ attributes, skip }: { attributes: Attributes; skip?: RegExp }) => {
  const entries = Object.entries(attributes).filter(([key]) => !skip?.test(key))

  if (entries.length === 0) {
    return null
  }

  return (
    <div className='grid grid-cols-[minmax(160px,auto)_1fr] gap-x-3 gap-y-0.5'>
      {entries.map(([key, value]) => (
        <div key={key} className='contents'>
          <span className='truncate' style={{ color: 'var(--dim)' }}>
            {key}
          </span>
          <span className='break-all whitespace-pre-wrap'>{fmtValue(value)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * An exception: `type: message`, then the cause chain — the record's body (the failure rendered
 * with its whole chain) and, when it says more, the budgeted `exception.stacktrace`.
 */
const ExceptionBlock = ({
  title,
  attributes,
  body,
  color,
}: {
  title: string
  attributes: Attributes
  body?: string
  color: string
}) => {
  const stack = attributes['exception.stacktrace']
  const chain = attributes['ozaco.failure.chain']

  return (
    <div
      className='my-1 rounded border p-2'
      style={{ background: 'var(--panel)', borderColor: color }}>
      <div>
        <b style={{ color }}>{fmtValue(attributes['exception.type']) || title}</b>{' '}
        {fmtValue(attributes['exception.message'])}{' '}
        <span style={{ color: 'var(--dim)' }}>{title}</span>
      </div>
      {body !== undefined && body.length > 0 && <Pre>{body}</Pre>}
      {body === undefined && Array.isArray(chain) && chain.length > 1 && (
        <Pre>{(chain as readonly string[]).join('\ncaused by ')}</Pre>
      )}
      {typeof stack === 'string' && stack !== body && (
        <details>
          <summary className='cursor-pointer' style={{ color: 'var(--dim)' }}>
            stacktrace
          </summary>
          <Pre>{stack}</Pre>
        </details>
      )}
    </div>
  )
}

/** A span event, inline under its span: offset from the span's start + its attributes. */
const EventLine = ({ event, span }: { event: SpanEvent; span: SpanRow }) =>
  event.name === 'exception' ? (
    <ExceptionBlock
      title={`event +${fmtMs(event.time - span.start)}`}
      attributes={event.attributes ?? {}}
      color='var(--bad)'
    />
  ) : (
    <div className='flex gap-2'>
      <span style={{ color: 'var(--accent)' }}>◆</span>
      <span>{event.name}</span>
      <span style={{ color: 'var(--dim)' }}>+{fmtMs(event.time - span.start)}</span>
      <span className='truncate' style={{ color: 'var(--dim)' }}>
        {Object.entries(event.attributes ?? {})
          .map(([key, value]) => `${key}=${fmtValue(value)}`)
          .join(' ')}
      </span>
    </div>
  )

/**
 * A log record, inline under its span: time, severity, body. An exception record is ONE line
 * here (`type: message`) — its whole chain is its block in the failures list, shown once.
 */
const LogLine = ({ log }: { log: LogRow }) => {
  const severity = log.severity_text ?? severityOf(log.severity_number)
  const color = severityColor(log.severity_number)

  if (isExceptionLog(log)) {
    return (
      <div className='flex gap-2'>
        <span style={{ color: 'var(--dim)' }}>{fmtTime(log.time)}</span>
        <span className='tag' style={{ color }}>
          {severity}
        </span>
        <span className='truncate'>
          <span style={{ color: 'var(--accent)' }}>{log.event_name} </span>
          <b style={{ color }}>{fmtValue(log.attributes['exception.type'])}</b>{' '}
          {fmtValue(log.attributes['exception.message'])}
        </span>
      </div>
    )
  }

  const data = Object.entries(log.attributes)

  return (
    <div className='flex gap-2'>
      <span style={{ color: 'var(--dim)' }}>{fmtTime(log.time)}</span>
      <span className='tag' style={{ color }}>
        {severity}
      </span>
      <span className='break-all whitespace-pre-wrap'>
        {log.event_name ? <span style={{ color: 'var(--accent)' }}>{log.event_name} </span> : null}
        {log.body}
        {data.length > 0 && (
          <span style={{ color: 'var(--dim)' }}>
            {'  '}
            {data.map(([key, value]) => `${key}=${fmtValue(value)}`).join(' ')}
          </span>
        )}
      </span>
    </div>
  )
}

interface SpanNodeProps {
  readonly placed: Placed
  readonly logs: readonly LogRow[]
  readonly range: { readonly start: number; readonly total: number }
  readonly traceId: string
  readonly open: boolean
  readonly several: boolean
  readonly onToggle: () => void
  readonly onLink: (link: Link) => void
}

const SpanNode = ({
  placed,
  logs,
  range,
  traceId,
  open,
  several,
  onToggle,
  onLink,
}: SpanNodeProps) => {
  const { span, depth } = placed
  const events = inlineEvents(span, logs)
  const left = ((span.start - range.start) / range.total) * 100
  const width = Math.max(0.4, (span.duration_ms / range.total) * 100)
  const indent = { paddingLeft: `${depth * 14}px` }

  return (
    <div id={`span-${span.span_id}`}>
      <div
        className='row-hover grid cursor-pointer grid-cols-[minmax(260px,2fr)_3fr_70px] items-center gap-2 py-[3px]'
        onClick={onToggle}>
        <span className='truncate' style={indent}>
          <span style={{ color: 'var(--dim)' }}>{open ? '▾' : '▸'}</span>{' '}
          <span className='tag'>{span.kind}</span>
          <ServiceBadge span={span} instance={several} />
          <span style={{ color: span.error_type === null ? undefined : outcomeColor(span) }}>
            {span.name}
          </span>
          {span.links.length > 0 && <span style={{ color: 'var(--accent)' }}> ↗</span>}
        </span>
        <div className='relative h-2.5 rounded-[3px]' style={{ background: '#222735' }}>
          <i
            className='absolute top-0 h-2.5 rounded-[3px]'
            style={{
              left: `${left.toFixed(2)}%`,
              width: `${Math.min(width, 100 - left).toFixed(2)}%`,
              background:
                span.status_code === 'error' ? 'var(--bad)' : serviceColor(span.service_name),
            }}
          />
          {span.events.map((event, index) => (
            <i
              key={index}
              className='absolute top-[-2px] h-3.5 w-[2px]'
              title={event.name}
              style={{
                left: `${(((event.time - range.start) / range.total) * 100).toFixed(2)}%`,
                background: event.name === 'exception' ? 'var(--bad)' : 'var(--fg)',
              }}
            />
          ))}
        </div>
        <span className='text-right' style={{ color: 'var(--dim)' }}>
          {fmtMs(span.duration_ms)}
        </span>
      </div>

      {(events.length > 0 || logs.length > 0) && (
        <div className='mb-1' style={{ paddingLeft: `${depth * 14 + 18}px` }}>
          {events.map((event, index) => (
            <EventLine key={`e${index}`} event={event} span={span} />
          ))}
          {logs.map((log, index) => (
            <LogLine key={`l${index}`} log={log} />
          ))}
        </div>
      )}

      {open && (
        <div
          className='mb-2 rounded border p-2'
          style={{
            marginLeft: `${depth * 14 + 18}px`,
            background: 'var(--panel)',
            borderColor: 'var(--line)',
          }}>
          <div className='mb-1' style={{ color: 'var(--dim)' }}>
            span {span.span_id}
            {span.parent_span_id ? ` · parent ${span.parent_span_id}` : ''} · {span.service_name} @{' '}
            {span.service_instance_id} · {span.scope}
            {span.scope_version ? `@${span.scope_version}` : ''}
            {span.status_message ? ` · ${span.status_code}: ${span.status_message}` : ''}
          </div>
          <AttrTable attributes={span.attributes} />
          {span.links.length > 0 && (
            <>
              <Heading>links</Heading>
              {span.links.map((link, index) => (
                <div key={index} className='flex gap-2'>
                  <button className='btn' onClick={() => onLink(link)}>
                    {link.context.traceId === traceId ? 'this trace' : 'open trace'} ·{' '}
                    {link.context.spanId.slice(0, 8)}
                  </button>
                  <span style={{ color: 'var(--dim)' }}>
                    {Object.entries(link.attributes ?? {})
                      .map(([key, value]) => `${key}=${fmtValue(value)}`)
                      .join(' ')}
                  </span>
                </div>
              ))}
            </>
          )}
          <Heading>resource</Heading>
          <AttrTable attributes={span.resource} />
        </div>
      )}
    </div>
  )
}

interface Props {
  readonly view: TraceView
  readonly focus: string | null
  readonly onOpenTrace: (traceId: string, spanId: string | null) => void
}

export const TraceDetail = ({ view, focus, onOpenTrace }: Props) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const placed = useMemo(() => treeOf(view.spans), [view])
  const spanIds = useMemo(() => new Set(view.spans.map(span => span.span_id)), [view])
  const instances = new Set(view.spans.map(span => span.service_instance_id))
  const root = placed[0]?.span ?? null
  const start = Math.min(...view.spans.map(span => span.start), ...view.logs.map(log => log.time))
  const end = Math.max(...view.spans.map(span => span.end), start + 1)
  const range = { start, total: Math.max(1, end - start) }
  const failures = view.logs.filter(log => isExceptionLog(log))
  const orphans = view.logs.filter(log => log.span_id === null || !spanIds.has(log.span_id))
  const requestId = view.spans.find(span => span.request_id !== null)?.request_id ?? null
  const services = [...new Set(view.spans.map(span => span.service_name))]

  const logsOf = (spanId: string): readonly LogRow[] =>
    view.logs.filter(log => log.span_id === spanId)

  const reveal = (spanId: string): void => {
    setOpen(prior => new Set([...prior, spanId]))
    requestAnimationFrame(() => {
      document.querySelector(`#span-${spanId}`)?.scrollIntoView({ block: 'center' })
    })
  }

  // a trace opened from a link elsewhere lands on the linked span
  useEffect(() => {
    setOpen(new Set())

    if (focus !== null && spanIds.has(focus)) {
      reveal(focus)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per opened trace
  }, [view, focus])

  const toggle = (spanId: string): void => {
    setOpen(prior => {
      const next = new Set(prior)

      if (next.has(spanId)) {
        next.delete(spanId)
      } else {
        next.add(spanId)
      }

      return next
    })
  }

  const onLink = (link: Link): void => {
    if (link.context.traceId === view.trace_id) {
      reveal(link.context.spanId)
    } else {
      onOpenTrace(link.context.traceId, link.context.spanId)
    }
  }

  return (
    <div className='p-4'>
      {root && (
        <h2 className='m-0 text-[14px] font-semibold'>
          {root.name} <span style={{ color: outcomeColor(root) }}>{statusText(root)}</span>{' '}
          <span style={{ color: 'var(--dim)' }}>{fmtMs(root.duration_ms)}</span>
        </h2>
      )}
      <div style={{ color: 'var(--dim)' }}>
        trace {view.trace_id}
        {requestId ? ` · request ${requestId}` : ''} · {view.spans.length} spans ·{' '}
        {view.logs.length} records
        {root ? ` · ${new Date(root.start).toLocaleString()}` : ''}
      </div>
      <div className='mt-1'>
        {services.map(service => (
          <span key={service} className='tag' style={{ color: serviceColor(service) }}>
            {service}
          </span>
        ))}
      </div>

      {failures.length > 0 && (
        <>
          <Heading>failures</Heading>
          {failures.map((log, index) => {
            const at = view.spans.find(span => span.span_id === log.span_id)

            return (
              <div key={index}>
                <ExceptionBlock
                  title={`${severityOf(log.severity_number)} ${log.event_name}`}
                  attributes={log.attributes}
                  body={log.body}
                  color={severityColor(log.severity_number)}
                />
                {at && (
                  <button className='btn mb-2' onClick={() => reveal(at.span_id)}>
                    at {at.name} · {at.service_name}
                  </button>
                )}
              </div>
            )
          })}
        </>
      )}

      <Heading>spans</Heading>
      <div className='mb-1' style={{ color: 'var(--dim)' }}>
        click a span for its attributes, links and resource
      </div>
      {placed.map(entry => (
        <SpanNode
          key={entry.span.span_id}
          placed={entry}
          logs={logsOf(entry.span.span_id)}
          range={range}
          traceId={view.trace_id}
          open={open.has(entry.span.span_id)}
          several={instances.size > 1}
          onToggle={() => toggle(entry.span.span_id)}
          onLink={onLink}
        />
      ))}

      {orphans.length > 0 && (
        <>
          <Heading>other records of this trace</Heading>
          {orphans.map((log, index) => (
            <LogLine key={index} log={log} />
          ))}
        </>
      )}
    </div>
  )
}
