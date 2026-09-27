// oxlint-disable no-template-curly-in-string -- Grafana's own `${…}` link-template syntax
/**
 * The observe docker leg through Grafana and Prometheus (grafana/otel-lgtm) — design §11
 * assertions 8 and 10: the trace as Grafana's Tempo datasource shows it, the trace-to-logs link
 * replayed with the documented `service.namespace` datasource config (it must surface the
 * DOWNSTREAM node's exception line from the root span), Tempo's service graph (a client→server
 * edge and a database edge by `db.namespace`) and the derived HTTP metrics. Skipped unless the
 * backend urls are set.
 */
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import {
  backends,
  frameColumn,
  grafanaDatasource,
  grafanaQuery,
  poll,
  promQuery,
  TIMEOUT,
} from './helpers'
import { API, APP, scenario, SQLITE, STORE } from './scenario'

interface GrafanaSpan {
  readonly spanID: string
  readonly parentSpanID: string
  readonly operationName: string
  readonly serviceName: string
  readonly serviceNamespace: string
  readonly kind: string
  readonly statusCode: number
  readonly startTime: number
  readonly duration: number
}

/** The trace as Grafana's Tempo datasource answers it (one data-frame row per span). */
const grafanaTrace = async (traceId: string, sinceMs: number): Promise<GrafanaSpan[]> => {
  const tempo = await grafanaDatasource('tempo')
  const window = { from: sinceMs - 60_000, to: Date.now() + 60_000 }

  return poll(
    async () => {
      const frames = await grafanaQuery(
        { datasource: { uid: tempo.uid, type: 'tempo' }, queryType: 'traceId', query: traceId },
        window,
      )
      const ids = frameColumn(frames, 'spanID')

      return ids.map((spanID, at) => ({
        spanID: String(spanID),
        parentSpanID: String(frameColumn(frames, 'parentSpanID')[at] ?? ''),
        operationName: String(frameColumn(frames, 'operationName')[at]),
        serviceName: String(frameColumn(frames, 'serviceName')[at]),
        serviceNamespace: String(frameColumn(frames, 'serviceNamespace')[at] ?? ''),
        kind: String(frameColumn(frames, 'kind')[at]),
        statusCode: Number(frameColumn(frames, 'statusCode')[at] ?? 0),
        startTime: Number(frameColumn(frames, 'startTime')[at]),
        duration: Number(frameColumn(frames, 'duration')[at]),
      }))
    },
    spans => spans.some(span => span.serviceName === STORE),
    { confirm: true },
  )
}

/**
 * The documented Tempo datasource `tracesToLogsV2` config (packages/server/README.md): a custom
 * query over the span's `service.namespace` tag, the window widened by a second each way.
 */
const TRACES_TO_LOGS = {
  query: '{${__tags}} | trace_id="${__trace.traceId}"',
  tags: [{ key: 'service.namespace', value: 'service_namespace' }],
  spanStartTimeShift: -1000,
  spanEndTimeShift: 1000,
} as const

/** Replay the "Logs for this span" link of `span` the way Grafana builds it. */
const logsForSpan = async (traceId: string, span: GrafanaSpan): Promise<AnyType[]> => {
  const loki = await grafanaDatasource('loki')
  const tags = TRACES_TO_LOGS.tags.map(tag => `${tag.value}="${span.serviceNamespace}"`).join(', ')
  const expr = TRACES_TO_LOGS.query
    .replace('${__tags}', tags)
    .replace('${__trace.traceId}', traceId)
  const window = {
    from: Math.floor(span.startTime) + TRACES_TO_LOGS.spanStartTimeShift,
    to: Math.floor(span.startTime + span.duration) + TRACES_TO_LOGS.spanEndTimeShift,
  }

  return poll<AnyType[]>(
    async () => {
      const frames = await grafanaQuery(
        { datasource: { uid: loki.uid, type: 'loki' }, expr, queryType: 'range', maxLines: 100 },
        window,
      )
      const lines = frameColumn(frames, 'Line')
      const labels = frameColumn(frames, 'labels')
      return lines.map((line, at) => ({ line: String(line), labels: labels[at] ?? {} }))
    },
    lines => lines.some(entry => entry.labels.service_name === STORE),
    { confirm: true },
  )
}

describe.skipIf(!backends.otlp || !backends.grafana)('observe leg — Grafana', () => {
  it(
    "(1) Grafana's Tempo datasource: one root, a service per ozaco service, the failure marked",
    async () => {
      const run = await scenario()
      const spans = await grafanaTrace(run.traces.chain, run.startedAt)

      expect(spans.filter(span => span.parentSpanID === '')).toHaveLength(1)
      expect(new Set(spans.map(span => span.serviceName))).toEqual(new Set([APP, API, STORE]))
      expect(new Set(spans.map(span => span.serviceNamespace))).toEqual(new Set([APP]))

      const owner = spans.find(span => span.serviceName === STORE)!
      expect(owner).toMatchObject({ operationName: `${STORE}.save`, kind: 'server', statusCode: 2 })
    },
    TIMEOUT,
  )

  it(
    "(8) trace-to-logs by service.namespace from the ROOT span shows the downstream node's exception",
    async () => {
      const run = await scenario()
      const spans = await grafanaTrace(run.traces.chain, run.startedAt)
      const root = spans.find(span => span.parentSpanID === '')!
      expect(root.serviceName).toBe(APP)

      const lines = await logsForSpan(run.traces.chain, root)
      const downstream = lines.filter(entry => entry.labels.service_name === STORE)
      expect(downstream).toHaveLength(1)
      expect(downstream[0].line.startsWith('store.save: the note could not be saved')).toBe(true)
      expect(downstream[0].line).toContain(
        'Caused by: std:result.unknown: TypeError: sector 7 is unreadable',
      )
      expect(downstream[0].labels).toMatchObject({
        exception_type: 'store.save',
        trace_id: run.traces.chain,
        detected_level: 'error',
      })
    },
    TIMEOUT,
  )
})

describe.skipIf(!backends.otlp || !backends.prometheus)('observe leg — Prometheus', () => {
  it(
    '(10) the service graph: a client→server edge between the services and a database edge',
    async () => {
      await scenario()

      const edge = await promQuery(
        `traces_service_graph_request_total{client="${API}", server="${STORE}"}`,
        // two calls crossed: `save` and `put`
        series => series.some(entry => entry.value >= 2),
      )
      expect(Math.max(0, ...edge.map(entry => entry.value))).toBeGreaterThanOrEqual(2)

      // a CLIENT db span with `db.namespace` is a database node (sqlite: the file's basename)
      const database = await promQuery(
        `traces_service_graph_request_total{client="${STORE}", server="${SQLITE}"}`,
        series => series.length > 0,
      )
      expect(database.length).toBeGreaterThan(0)
      expect(database[0]!.metric['connection_type']).toBe('database')
    },
    TIMEOUT,
  )

  it(
    '(10) the derived HTTP metric http.server.request.duration reaches Prometheus',
    async () => {
      await scenario()

      const routes = ['save', 'me', 'flaky', 'note', 'ping'].map(action => `/${API}/${action}`)
      const series = await promQuery(
        `http_server_request_duration_seconds_count{service_namespace="${APP}"}`,
        found => routes.every(route => found.some(entry => entry.metric['http_route'] === route)),
      )
      const seen = new Set(series.map(entry => entry.metric['http_route']))
      expect(routes.filter(route => !seen.has(route))).toEqual([])
      const failed = series.find(entry => entry.metric['http_route'] === `/${API}/save`)!
      expect(failed.metric).toMatchObject({
        http_request_method: 'POST',
        http_response_status_code: '500',
        error_type: 'store.save',
      })
    },
    TIMEOUT,
  )
})
