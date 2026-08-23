import type { ObserveDef, TraceDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { until } from 'std:effect'
import { fail } from 'std:result'

import type { StarRocksDef } from './types'

/** `DATETIME` text StarRocks accepts (UTC, millisecond precision). */
const datetimeOf = (ms: number): string =>
  new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

export const requestMetric = (row: ObserveDef.RequestRow): StarRocksDef.RequestMetric => ({
  ts: datetimeOf(row.startedAt),
  request_id: row.requestId,
  origin: row.origin,
  service: row.service,
  action: row.action,
  edge: row.edge,
  method: row.method,
  path: row.path,
  status: row.status,
  duration_ms: row.durationMs,
  service_id: row.serviceId,
  instance: row.instance,
  error: row.error,
})

export const spanMetric = (span: TraceDef.Span): StarRocksDef.SpanMetric => ({
  ts: datetimeOf(span.startedAt),
  request_id: span.requestId,
  span_id: span.spanId,
  parent_span_id: span.parentSpanId,
  kind: span.kind,
  name: span.name,
  service_id: span.serviceId,
  action: span.actionId,
  transport: span.transport,
  duration_ms: span.endedAt - span.startedAt,
  status: span.status,
  instance: span.instance,
})

/** One Stream Load: JSON array body, `strip_outer_array`, a unique label; FE's 307 to a BE is
 * followed by fetch (PUT keeps its body on 307). */
export function* streamLoad(load: StarRocksDef.Load, rows: readonly unknown[]): Operation<void> {
  let response: Response

  try {
    response = yield* until(
      load.fetch(load.url, {
        method: 'PUT',
        headers: {
          ...load.headers,
          'content-type': 'application/json',
          expect: '100-continue',
          format: 'json',
          strip_outer_array: 'true',
          label: load.label(),
        },
        body: JSON.stringify(rows),
        redirect: 'follow',
      }),
    )
  } catch (error) {
    return yield* fail(ServerErrors.Unavailable, `starrocks: ${String(error)}`)
  }

  if (!response.ok) {
    return yield* fail(ServerErrors.Unavailable, `starrocks: ${response.status} from ${load.url}`)
  }

  // Stream Load answers 200 with a JSON status; `Fail` is still a failed batch
  const text = yield* until(response.text().catch(() => ''))

  try {
    const body = JSON.parse(text) as { Status?: string; Message?: string }

    if (body.Status && body.Status !== 'Success' && body.Status !== 'Publish Timeout') {
      return yield* fail(
        ServerErrors.Unavailable,
        `starrocks: ${body.Status} ${body.Message ?? ''}`,
      )
    }
  } catch {
    // a non-JSON 200 (proxies) counts as delivered
  }
}
