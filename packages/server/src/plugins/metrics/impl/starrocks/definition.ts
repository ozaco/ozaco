import type { ServerDef, Sink } from 'server:core'
import { createSink, Server, ServerErrors } from 'server:core'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { requestMetric, spanMetric, streamLoad } from './internal'
import type { StarRocksDef } from './types'

/**
 * Request + span metrics into StarRocks through Stream Load: one row per request (status,
 * duration, route, error) and one per span (kind, duration, status) — the analytical mirror of
 * the `_ob_*` tables for dashboards over millions of rows. `starrocksDdl()` gives the tables.
 * Batched; delivery failures are counted (`stats()`), never raised into requests.
 */
export const StarRocksMetrics = definePlugin<StarRocksDef.Context, [options: StarRocksDef.Options]>(
  {
    name: 'server-metrics-starrocks',
    version: '0.5.0',
    description: 'Request/span metrics into StarRocks via Stream Load',

    *setup(options) {
      const kernel = yield* Server.context.get()
      if (!kernel) {
        return yield* fail(
          ServerErrors.Configuration,
          'StarRocksMetrics must be installed by createServer',
        )
      }
      if (!options?.url || !options.database) {
        return yield* fail(ServerErrors.Configuration, 'StarRocksMetrics needs url + database')
      }
      const base = options.url.replace(/\/$/u, '')
      const doFetch = options.fetch ?? fetch
      const auth =
        options.user === undefined
          ? {}
          : { authorization: `Basic ${btoa(`${options.user}:${options.password ?? ''}`)}` }
      const headers = { ...auth, ...options.headers }
      const requestsTable =
        options.tables?.requests === undefined ? 'ozaco_requests' : options.tables.requests
      const spansTable = options.tables?.spans === undefined ? 'ozaco_spans' : options.tables.spans
      let sequence = 0
      const loadOf = (table: string): StarRocksDef.Load => ({
        url: `${base}/api/${options.database}/${table}/_stream_load`,
        headers,
        fetch: doFetch,
        label: () => `ozaco-${kernel.instance}-${table}-${Date.now()}-${(sequence += 1)}`,
      })

      const requests: Sink<StarRocksDef.RequestMetric> = createSink({
        ...options.batch,
        *send(rows) {
          if (requestsTable) {
            yield* streamLoad(loadOf(requestsTable), rows)
          }
        },
      })
      const spans: Sink<StarRocksDef.SpanMetric> = createSink({
        ...options.batch,
        *send(rows) {
          if (spansTable) {
            yield* streamLoad(loadOf(spansTable), rows)
          }
        },
      })

      const hooks: ServerDef.Hooks = {
        name: 'starrocks',
        *observe(event) {
          if (event.t === 'request' && requestsTable) {
            requests.push(requestMetric(event.row))
          } else if (event.t === 'span' && spansTable) {
            spans.push(spanMetric(event.row))
          }
        },
        *start() {
          yield* requests.start()
          yield* spans.start()
        },
        *stop() {
          yield* requests.flush()
          yield* spans.flush()
        },
      }
      return { stats: () => ({ requests: requests.stats, spans: spans.stats }), hooks }
    },
  },
).build()
