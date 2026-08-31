import type { ObserveDef, TraceDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail } from 'std:result'

import type { OpenObserveDef } from './types'

/** OpenObserve reads `_timestamp` in MICROSECONDS since the epoch. */
const micros = (ms: number): number => Math.round(ms) * 1000

/** Drop null/undefined fields — absent beats `null` in a schemaless stream. */
const compact = (record: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  )

export const ooRequest = (row: ObserveDef.RequestRow, bodies: boolean): Record<string, unknown> =>
  compact({
    _timestamp: micros(row.started_at),
    request_id: row.request_id,
    origin: row.origin,
    service: row.service,
    action: row.action,
    edge: row.edge,
    method: row.method,
    path: row.path,
    socket: row.socket,
    status: row.status,
    service_id: row.service_id,
    instance: row.instance,
    lane: row.lane,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    error: row.error,
    attrs: row.attrs,
    // `bodies`: the captured request content — success included (headers redacted upstream)
    ...(bodies ? { headers: row.headers, input: row.input, output: row.output } : {}),
  })

/** A streamed body settled AFTER its request row shipped: a compact `phase: 'update'` record
 * (streams are append-only — consumers reduce by `requestId`, last write wins). */
export const ooRequestUpdate = (
  update: ObserveDef.RequestUpdate,
  bodies: boolean,
): Record<string, unknown> =>
  compact({
    _timestamp: micros(update.patch.ended_at ?? Date.now()),
    request_id: update.request_id,
    phase: 'update',
    duration_ms: update.patch.duration_ms,
    ended_at: update.patch.ended_at,
    ...(bodies ? { input: update.patch.input, output: update.patch.output } : {}),
  })

export const ooSpan = (span: TraceDef.Span): Record<string, unknown> =>
  compact({
    _timestamp: micros(span.started_at),
    request_id: span.request_id,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    name: span.name,
    kind: span.kind,
    status: span.status,
    service_id: span.service_id,
    instance: span.instance,
    action_id: span.action_id,
    transport: span.transport,
    started_at: span.started_at,
    ended_at: span.ended_at,
    duration_ms: span.ended_at - span.started_at,
    attrs: span.attrs,
  })

export const ooLog = (row: ObserveDef.LogRow): Record<string, unknown> =>
  compact({
    _timestamp: micros(row.ts),
    level: row.level,
    msg: row.msg,
    request_id: row.request_id,
    span_id: row.span_id,
    data: row.data,
  })

export const ooFailure = (row: ObserveDef.FailureRow): Record<string, unknown> =>
  compact({
    _timestamp: micros(row.ts),
    level: 'error',
    tag: row.tag,
    message: row.message,
    causes: row.causes.length > 0 ? row.causes : undefined,
    status: row.status,
    where: row.where,
    request_id: row.request_id,
    span_id: row.span_id,
  })

export const ooEvent = (row: ObserveDef.EventRow): Record<string, unknown> =>
  compact({
    _timestamp: micros(row.ts),
    kind: row.kind,
    name: row.name,
    size: row.size,
    request_id: row.request_id,
    span_id: row.span_id,
    data: row.data,
  })

/** A domain record ships as-is (free-form fields under a logical `stream`), timestamped. */
export const ooDomain = (row: ObserveDef.DomainRow): Record<string, unknown> =>
  compact({ ...row, _timestamp: micros(row.ts ?? Date.now()) })

/** POST one `_json` bulk payload (an ARRAY of records); non-2xx fails `server.unavailable`. */
export function* post(
  target: OpenObserveDef.Target,
  rows: readonly Record<string, unknown>[],
): Operation<void> {
  let response: Response

  try {
    response = yield* until(
      target.fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...target.headers },
        body: JSON.stringify(rows),
      }),
    )
  } catch (error) {
    return yield* fail(ServerErrors.Unavailable, `openobserve: ${String(error)}`)
  }

  if (!response.ok) {
    return yield* fail(
      ServerErrors.Unavailable,
      `openobserve: ${response.status} from ${target.url}`,
    )
  }
}
