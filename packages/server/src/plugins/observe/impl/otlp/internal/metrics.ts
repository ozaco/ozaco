import type { ObserveDef } from 'server:core'
import { scopeOf } from 'server:internal'
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'
import type { OtlpDef } from '../types/otlp'

import { DURATION_BUCKETS, METRIC_SERIES_LIMIT } from './const'

const pick = (
  span: TraceDef.SpanData,
  keys: readonly string[],
): Record<string, TraceDef.AttrValue> => {
  const picked: Record<string, TraceDef.AttrValue> = {}

  for (const key of keys) {
    const value = span.attributes[key]

    if (value !== undefined) {
      picked[key] = value
    }
  }

  return picked
}

const has = (span: TraceDef.SpanData, key: string): boolean => span.attributes[key] !== undefined

/** The semconv / ozaco duration metrics — from recorded spans, in SECONDS. */
const DURATIONS: readonly Helpers.DurationSource[] = [
  {
    name: 'http.server.request.duration',
    description: 'Duration of HTTP server requests.',
    accepts: span => span.kind === 'server' && has(span, 'http.request.method'),
    attributes: span => {
      const status = span.attributes['http.response.status_code']
      // `error.type` only when the request FAILED as a server (5xx, or no response at all) —
      // the same rule the span's status follows
      const failed = typeof status !== 'number' || status >= 500

      return {
        ...pick(span, [
          'http.request.method',
          'url.scheme',
          'http.route',
          'http.response.status_code',
        ]),
        'error.type': failed ? span.attributes['error.type'] : undefined,
      }
    },
  },
  {
    name: 'rpc.server.call.duration',
    description: 'Duration of RPC calls served.',
    accepts: span => span.kind === 'server' && has(span, 'rpc.system.name'),
    attributes: span =>
      pick(span, ['rpc.system.name', 'rpc.method', 'rpc.response.status_code', 'error.type']),
  },
  {
    name: 'rpc.client.call.duration',
    description: 'Duration of RPC calls made.',
    accepts: span => span.kind === 'client' && has(span, 'rpc.system.name'),
    attributes: span =>
      pick(span, ['rpc.system.name', 'rpc.method', 'rpc.response.status_code', 'error.type']),
  },
  {
    name: 'ozaco.action.duration',
    description: 'Duration of in-process action dispatches.',
    accepts: span => span.kind === 'internal' && has(span, 'code.function.name'),
    attributes: span => pick(span, ['code.function.name', 'error.type']),
  },
  {
    name: 'messaging.process.duration',
    description: 'Duration of processing one message (events, queue jobs).',
    accepts: span => span.kind === 'consumer' && has(span, 'messaging.system'),
    attributes: span =>
      pick(span, [
        'messaging.system',
        'messaging.operation.name',
        'messaging.destination.name',
        'error.type',
      ]),
  },
]

const WS_SESSION = {
  name: 'ozaco.ws.session.duration',
  description: 'Duration of WebSocket sessions.',
} as const

const WS_MESSAGES = {
  name: 'ozaco.ws.messages',
  description: 'WebSocket messages exchanged, per direction.',
} as const

const ACTIVE_REQUESTS = {
  name: 'http.server.active_requests',
  description: 'Number of active HTTP server requests.',
} as const

const SERVICE_UP = {
  name: 'ozaco.service.up',
  description: 'The service is served by this instance (1 per export beat).',
} as const

const OVERFLOW: TraceDef.Attributes = { 'otel.metric.overflow': true }

const resourceKey = (resource: OtlpDef.ResourceAttributes): string =>
  `${String(resource['service.name'] ?? '')}\u0000${String(resource['service.instance.id'] ?? '')}`

/** A series key: the attributes, keys sorted (order never splits a series). */
const seriesKey = (attributes: TraceDef.Attributes): string =>
  JSON.stringify(
    Object.keys(attributes)
      .toSorted()
      .map(key => [key, attributes[key]]),
  )

const defined = (attributes: Helpers.MaybeAttributes): TraceDef.Attributes => {
  const kept: Record<string, TraceDef.AttrValue> = {}

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      kept[key] = value
    }
  }

  return kept
}

/**
 * The exporter's metric state (CUMULATIVE since `started`), derived from what it is handed —
 * so it is the same for every OTLP-speaking sink:
 * - duration histograms (s, semconv bucket advice) of recorded SERVER / CLIENT / INTERNAL /
 *   CONSUMER spans (`http.server.request.duration`, `rpc.server.call.duration`,
 *   `rpc.client.call.duration`, `ozaco.action.duration`, `messaging.process.duration`), each over
 *   an attribute ALLOWLIST (never ids, paths, addresses);
 * - `ozaco.ws.session.duration` (s) and `ozaco.ws.messages` from the edge's `socket closed`
 *   record;
 * - `ozaco.service.up`, a gauge of 1 per served resource at every collect;
 * - `http.server.active_requests` (an up-down counter per `http.request.method` + `url.scheme`),
 *   read from the kernel's live count at every collect — the one metric no finished span can
 *   say.
 * One block per resource (the record's `service.name` / instance), at most 2000 series per
 * metric (the rest fold into one `otel.metric.overflow` series).
 */
export const createMeter = (started: number): Helpers.Meter => {
  const resources = new Map<string, Helpers.ResourceState>()

  const instrument = (
    resource: OtlpDef.ResourceAttributes,
    spec: Omit<Helpers.Instrument, 'series'>,
  ): Helpers.Instrument => {
    const key = resourceKey(resource)
    let state = resources.get(key)

    if (!state) {
      state = { resource, instruments: new Map() }
      resources.set(key, state)
    }

    let found = state.instruments.get(spec.name)

    if (!found) {
      found = { ...spec, series: new Map() }
      state.instruments.set(spec.name, found)
    }

    return found
  }

  const seriesOf = <S extends Helpers.HistogramSeries | Helpers.SumSeries>(
    target: Helpers.Instrument,
    input: Helpers.MaybeAttributes,
    create: (attributes: TraceDef.Attributes) => S,
  ): S => {
    let attributes = defined(input)
    let key = seriesKey(attributes)
    let series = target.series.get(key)

    if (!series && target.series.size >= METRIC_SERIES_LIMIT) {
      attributes = OVERFLOW
      key = seriesKey(attributes)
      series = target.series.get(key)
    }

    if (!series) {
      series = create(attributes)
      target.series.set(key, series)
    }

    return series as S
  }

  const observe = (
    target: Helpers.Instrument,
    attributes: Helpers.MaybeAttributes,
    seconds: number,
  ) => {
    const series = seriesOf<Helpers.HistogramSeries>(target, attributes, kept => ({
      attributes: kept,
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      buckets: Array.from({ length: DURATION_BUCKETS.length + 1 }, () => 0),
    }))
    const slot = DURATION_BUCKETS.findIndex(bound => seconds <= bound)
    const index = slot === -1 ? DURATION_BUCKETS.length : slot

    series.buckets[index] = (series.buckets[index] ?? 0) + 1
    series.count += 1
    series.sum += seconds
    series.min = Math.min(series.min, seconds)
    series.max = Math.max(series.max, seconds)
  }

  const add = (target: Helpers.Instrument, attributes: Helpers.MaybeAttributes, value: number) => {
    seriesOf<Helpers.SumSeries>(target, attributes, kept => ({
      attributes: kept,
      value: 0,
    })).value += value
  }

  const histogram = (
    resource: OtlpDef.ResourceAttributes,
    spec: { name: string; description: string },
  ) => instrument(resource, { kind: 'histogram', unit: 's', monotonic: false, ...spec })

  const recordSpan = (event: ObserveDef.Event & { readonly t: 'span' }) => {
    const { span } = event
    const seconds = Math.max(0, span.end - span.start) / 1000

    for (const source of DURATIONS) {
      if (source.accepts(span)) {
        observe(histogram(event.resource, source), source.attributes(span), seconds)
      }
    }
  }

  /** The edge's `socket closed` record (scope `@ozaco/server`) carries the session's totals. */
  const recordLog = (event: ObserveDef.Event & { readonly t: 'log' }) => {
    const { attributes, scope } = event.log
    const duration = attributes['ozaco.ws.session.duration']

    if (typeof duration !== 'number' || !scope.name.startsWith('@ozaco/server')) {
      return
    }

    observe(
      histogram(event.resource, WS_SESSION),
      { 'http.route': attributes['http.route'] },
      duration,
    )

    const messages = instrument(event.resource, {
      kind: 'sum',
      unit: '{message}',
      monotonic: true,
      ...WS_MESSAGES,
    })

    for (const direction of ['received', 'sent'] as const) {
      const value = attributes[`ozaco.ws.messages.${direction}`]

      if (typeof value === 'number' && value > 0) {
        add(messages, { 'ozaco.ws.message.direction': direction }, value)
      }
    }
  }

  const render = (target: Helpers.Instrument, now: number): Helpers.Metric => {
    const head = { name: target.name, unit: target.unit, description: target.description }

    if (target.kind === 'histogram') {
      return {
        kind: 'histogram',
        ...head,
        points: [...target.series.values()].map(entry => {
          const series = entry as Helpers.HistogramSeries

          return {
            attributes: series.attributes,
            start: started,
            time: now,
            count: series.count,
            sum: series.sum,
            min: series.min,
            max: series.max,
            bucketCounts: [...series.buckets],
            bounds: DURATION_BUCKETS,
          }
        }),
      }
    }

    return {
      kind: 'sum',
      ...head,
      monotonic: target.monotonic,
      points: [...target.series.values()].map(entry => ({
        attributes: entry.attributes,
        start: started,
        time: now,
        value: (entry as Helpers.SumSeries).value,
      })),
    }
  }

  return {
    record: event => {
      if (event.t === 'span') {
        recordSpan(event)
      } else {
        recordLog(event)
      }
    },
    collect: (now, up, active) => {
      const scope = scopeOf()
      const entries: Helpers.Entry<Helpers.Metric>[] = []

      if (active && active.requests.length > 0) {
        entries.push({
          resource: active.resource,
          scope,
          item: {
            kind: 'sum',
            ...ACTIVE_REQUESTS,
            unit: '{request}',
            monotonic: false,
            points: active.requests.map(entry => ({
              attributes: { 'http.request.method': entry.method, 'url.scheme': entry.scheme },
              start: started,
              time: now,
              value: entry.count,
            })),
          },
        })
      }

      for (const state of resources.values()) {
        for (const target of state.instruments.values()) {
          if (target.series.size > 0) {
            entries.push({ resource: state.resource, scope, item: render(target, now) })
          }
        }
      }

      const seen = new Set<string>()

      for (const resource of up) {
        const key = resourceKey(resource)

        if (seen.has(key)) {
          continue
        }

        seen.add(key)
        entries.push({
          resource,
          scope,
          item: {
            kind: 'gauge',
            ...SERVICE_UP,
            unit: '1',
            points: [{ attributes: {}, start: started, time: now, value: 1 }],
          },
        })
      }

      return entries
    },
  }
}
