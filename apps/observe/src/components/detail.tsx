/** One request: the span waterfall, then failures, logs and events. */
import type { RequestView } from '../lib/api'

import { nameOf } from './list'

const Heading = ({ children }: { children: string }) => (
  <h3 className='mt-4 mb-1.5 text-[12px] tracking-wider uppercase' style={{ color: 'var(--dim)' }}>
    {children}
  </h3>
)

export const RequestDetail = ({ view }: { view: RequestView }) => {
  const { request, spans, logs, failures, events } = view
  const start = request.startedAt
  const total = Math.max(1, (request.endedAt ?? Date.now()) - start)

  return (
    <div className='p-4'>
      <h2 className='m-0 text-[14px] font-semibold'>
        {nameOf(request)}{' '}
        <span style={{ color: request.error ? 'var(--bad)' : 'var(--ok)' }}>
          {request.status ?? ''}
        </span>{' '}
        <span style={{ color: 'var(--dim)' }}>
          {request.durationMs === null ? '' : `${request.durationMs}ms`}
        </span>
      </h2>
      <div style={{ color: 'var(--dim)' }}>
        request {request.requestId} · lane {request.lane || '—'} · {request.serviceId}
        {request.error && (
          <>
            {' · '}
            <span style={{ color: 'var(--bad)' }}>{request.error}</span>
          </>
        )}
      </div>

      <Heading>spans</Heading>
      {spans.map(span => {
        const left = (((span.startedAt - start) / total) * 100).toFixed(1)
        const width = Math.max(0.5, ((span.endedAt - span.startedAt) / total) * 100).toFixed(1)

        return (
          <div
            key={span.spanId}
            className='grid grid-cols-[220px_1fr_70px] items-center gap-2 py-[3px]'>
            <span className='truncate'>
              <span className='tag'>{span.kind}</span>
              {span.name}
            </span>
            <div className='relative h-2.5 rounded-[3px]' style={{ background: '#222735' }}>
              <i
                className='absolute top-0 h-2.5 rounded-[3px]'
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  background:
                    span.status === 'failed'
                      ? 'var(--bad)'
                      : span.status === 'cancelled'
                        ? 'var(--warn)'
                        : 'var(--accent)',
                }}
              />
            </div>
            <span className='text-right' style={{ color: 'var(--dim)' }}>
              {span.endedAt - span.startedAt}ms
            </span>
          </div>
        )
      })}

      {failures.length > 0 && (
        <>
          <Heading>failures</Heading>
          {failures.map((failure, index) => (
            <pre
              key={index}
              className='my-1 overflow-auto rounded border p-2 whitespace-pre-wrap'
              style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
              <b style={{ color: 'var(--bad)' }}>{failure.tag}</b> {failure.message}
              {'\n'}
              <span style={{ color: 'var(--dim)' }}>at {failure.where}</span>
              {failure.causes.length > 0 ? `\n${failure.causes.join('\n')}` : ''}
            </pre>
          ))}
        </>
      )}

      {logs.length > 0 && (
        <>
          <Heading>logs</Heading>
          {logs.map((log, index) => (
            <pre
              key={index}
              className='my-1 overflow-auto rounded border p-2 whitespace-pre-wrap'
              style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
              <span className='tag'>{log.level}</span>
              {log.msg}
              {log.data ? `  ${JSON.stringify(log.data)}` : ''}
            </pre>
          ))}
        </>
      )}

      {events.length > 0 && (
        <>
          <Heading>events</Heading>
          {events.map((event, index) => (
            <div key={index}>
              <span className='tag'>{event.kind}</span>
              {event.name}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
