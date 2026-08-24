/**
 * One request: the span waterfall (rows expand into their attrs/meta), then what actually went
 * through — headers, input and output bodies (data · stream · flow · parts) — and failures,
 * logs, events.
 */
import { useState } from 'react'

import type { BodySnapshot, EventRow, RequestView, SpanRow } from '../lib/api'
import { base } from '../lib/api'

import { nameOf } from './list'

const fmtBytes = (size: number): string =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(2)} MB`

const Heading = ({ children }: { children: string }) => (
  <h3 className='mt-4 mb-1.5 text-[12px] tracking-wider uppercase' style={{ color: 'var(--dim)' }}>
    {children}
  </h3>
)

const Pretty = ({ value }: { value: unknown }) => (
  <pre
    className='my-1 overflow-auto rounded border p-2 whitespace-pre-wrap'
    style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
    {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
  </pre>
)

/** One body snapshot: data pretty-printed, streams/flows/parts as their shape. */
const Body = ({ label, body }: { label: string; body: BodySnapshot }) => (
  <div>
    <Heading>{label}</Heading>
    <div className='mb-1'>
      <span className='tag'>{body.kind}</span>
      {typeof body.brand === 'string' && <span className='tag'>{body.brand}</span>}
      {body.truncated === true && (
        <span style={{ color: 'var(--warn)' }}>
          truncated · {body.size} bytes total, first 8 KB kept
        </span>
      )}
    </div>
    {body.kind === 'data' && <Pretty value={body.data} />}
    {body.kind === 'parts' && (
      <>
        <Pretty value={body.fields} />
        {body.streams &&
          Object.entries(body.streams).map(([name, brand]) => (
            <div key={name}>
              <span className='tag'>stream</span>
              {name} <span style={{ color: 'var(--dim)' }}>{brand}</span>
            </div>
          ))}
      </>
    )}
    {(body.kind === 'stream' || body.kind === 'flow') && (
      <div style={{ color: 'var(--dim)' }}>
        a {body.kind} —{' '}
        {typeof body.size === 'number' ? `${fmtBytes(body.size)} streamed` : 'still streaming'};
        items pass through untouched, only the shape and the size are recorded
      </div>
    )}
  </div>
)

const SpanMeta = ({ span }: { span: SpanRow }) => (
  <div
    className='mb-1 rounded border p-2'
    style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
    <div style={{ color: 'var(--dim)' }}>
      span {span.span_id}
      {span.parent_span_id ? ` · parent ${span.parent_span_id}` : ''} · {span.service_id} ·{' '}
      {span.instance}
      {span.action_id ? ` · ${span.action_id}` : ''}
      {span.transport ? ` · via ${span.transport}` : ''}
    </div>
    {span.attrs && Object.keys(span.attrs).length > 0 ? (
      <Pretty value={span.attrs} />
    ) : (
      <div style={{ color: 'var(--dim)' }}>no attributes</div>
    )}
  </div>
)

/** The captured socket exchange: every frame's payload, and a client-side REPLAY — the
 * inbound (`socket-in`) frames are re-sent to the live socket in their original order. */
const Frames = ({ socket, frames }: { socket: string; frames: readonly EventRow[] }) => {
  const [log, setLog] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)

  const replay = () => {
    const inbound = frames.filter(frame => frame.kind === 'socket-in' && frame.data !== undefined)
    const url = `${base().replace(/^http/u, 'ws')}${socket}`
    const ws = new WebSocket(url)
    setBusy(true)
    setLog([`connect ${url}`])

    ws.addEventListener('open', () => {
      // oxlint-disable-next-line array-callback-return
      inbound.map((frame, index) => {
        setTimeout(() => {
          const payload = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)
          ws.send(payload)
          setLog(prior => [...prior, `→ ${payload.slice(0, 200)}`])

          if (index === inbound.length - 1) {
            setTimeout(() => {
              ws.close()
            }, 500)
          }
        }, index * 50)
      })

      if (inbound.length === 0) {
        ws.close()
      }
    })

    ws.addEventListener('message', event => {
      setLog(prior => [...prior, `← ${String(event.data).slice(0, 200)}`])
    })

    ws.addEventListener('close', () => {
      setLog(prior => [...prior, 'closed'])
      setBusy(false)
    })

    ws.addEventListener('error', () => {
      setLog(prior => [...prior, 'socket error'])
      setBusy(false)
    })
  }

  return (
    <>
      <Heading>frames</Heading>
      <div className='mb-1'>
        <button className='btn' disabled={busy} onClick={replay}>
          ▶ replay {frames.filter(frame => frame.kind === 'socket-in').length} inbound frame(s)
        </button>
      </div>
      {frames.map((frame, index) => (
        <div key={index} className='grid grid-cols-[46px_1fr] items-start gap-2 py-[2px]'>
          <span
            className='text-right'
            style={{ color: frame.kind === 'socket-in' ? 'var(--ok)' : 'var(--accent)' }}>
            {frame.kind === 'socket-in' ? '→ in' : '← out'}
          </span>
          <span className='break-all'>
            {frame.data === undefined
              ? `(payload not captured${frame.size === null ? '' : ` · ${fmtBytes(frame.size)}`})`
              : typeof frame.data === 'string'
                ? frame.data
                : JSON.stringify(frame.data)}
          </span>
        </div>
      ))}
      {log.length > 0 && (
        <>
          <Heading>replay</Heading>
          {log.map((line, index) => (
            <div key={index} className='break-all' style={{ color: 'var(--dim)' }}>
              {line}
            </div>
          ))}
        </>
      )}
    </>
  )
}

export const RequestDetail = ({ view }: { view: RequestView }) => {
  const { request, spans, logs, failures, events } = view
  const start = request.started_at
  const total = Math.max(1, (request.ended_at ?? Date.now()) - start)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  const toggle = (spanId: string) => {
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

  return (
    <div className='p-4'>
      <h2 className='m-0 text-[14px] font-semibold'>
        {nameOf(request)}{' '}
        <span style={{ color: request.error ? 'var(--bad)' : 'var(--ok)' }}>
          {request.status ?? ''}
        </span>{' '}
        <span style={{ color: 'var(--dim)' }}>
          {request.duration_ms === null ? '' : `${request.duration_ms}ms`}
        </span>
      </h2>
      <div style={{ color: 'var(--dim)' }}>
        request {request.request_id} · lane {request.lane || '—'} · {request.service_id}
        {request.error && (
          <>
            {' · '}
            <span style={{ color: 'var(--bad)' }}>{request.error}</span>
          </>
        )}
      </div>

      <Heading>spans</Heading>
      <div className='mb-1' style={{ color: 'var(--dim)' }}>
        click a span for its attributes
      </div>
      {spans.map(span => {
        const left = (((span.started_at - start) / total) * 100).toFixed(1)
        const width = Math.max(0.5, ((span.ended_at - span.started_at) / total) * 100).toFixed(1)

        return (
          <div key={span.span_id}>
            <div
              className='row-hover grid cursor-pointer grid-cols-[220px_1fr_70px] items-center gap-2 py-[3px]'
              onClick={() => toggle(span.span_id)}>
              <span className='truncate'>
                <span style={{ color: 'var(--dim)' }}>{open.has(span.span_id) ? '▾' : '▸'}</span>{' '}
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
                {span.ended_at - span.started_at}ms
              </span>
            </div>
            {open.has(span.span_id) && <SpanMeta span={span} />}
          </div>
        )
      })}

      {request.headers && Object.keys(request.headers).length > 0 && (
        <>
          <Heading>headers</Heading>
          <div
            className='grid grid-cols-[220px_1fr] gap-x-3 gap-y-0.5 rounded border p-2'
            style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
            {Object.entries(request.headers).map(([name, value]) => (
              <div key={name} className='contents'>
                <span className='truncate' style={{ color: 'var(--dim)' }}>
                  {name}
                </span>
                <span className='break-all'>{value}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {request.input && <Body label='input' body={request.input} />}
      {request.output && <Body label='output' body={request.output} />}

      {request.attrs && Object.keys(request.attrs).length > 0 && (
        <>
          <Heading>attributes</Heading>
          <Pretty value={request.attrs} />
        </>
      )}

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

      {request.socket &&
        events.some(event => event.kind === 'socket-in' || event.kind === 'socket-out') && (
          <Frames
            socket={request.socket}
            frames={events.filter(
              event => event.kind === 'socket-in' || event.kind === 'socket-out',
            )}
          />
        )}

      {events.some(event => event.kind !== 'socket-in' && event.kind !== 'socket-out') && (
        <>
          <Heading>events</Heading>
          {events
            .filter(event => event.kind !== 'socket-in' && event.kind !== 'socket-out')
            .map((event, index) => (
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
