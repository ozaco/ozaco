// oxlint-disable import/exports-last
/**
 * The observe docker leg's backend readers (design §11): Tempo (trace by id + TraceQL search),
 * Loki, Grafana (`/api/ds/query`), Prometheus and OpenObserve. Ingestion is asynchronous — the
 * collector batches, Tempo's search index lags 15–30 s, the service graph waits for its pairs — so
 * every reader POLLS until its condition holds or its deadline passes, then hands back what it
 * last saw (the test's `expect` reports the difference).
 *
 * Tempo's v2 API answers base64 ids and enum strings (`SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`)
 * and its search drops a trace id's leading zeros: everything is normalized to what ozaco exports
 * (lowercase hex, `server`, `error`) before a test sees it.
 *
 * `scripts/test-observe.sh` starts the backends and exports the `SERVER_TEST_*` urls; without
 * `SERVER_TEST_OTLP_URL` every suite of this directory is skipped (the fast `bun test` stays
 * green).
 */
import type { AnyType } from 'std:shared'

const env = (name: string): string | undefined => process.env[name] || undefined

/** The backends' base urls (no trailing slash). */
export const backends = {
  otlp: env('SERVER_TEST_OTLP_URL'),
  tempo: env('SERVER_TEST_TEMPO_URL'),
  loki: env('SERVER_TEST_LOKI_URL'),
  grafana: env('SERVER_TEST_GRAFANA_URL'),
  prometheus: env('SERVER_TEST_PROM_URL'),
  openobserve: env('SERVER_TEST_OPENOBSERVE_URL'),
} as const

export const grafanaAuth = {
  user: env('SERVER_TEST_GRAFANA_USER') ?? 'admin',
  pass: env('SERVER_TEST_GRAFANA_PASS') ?? 'admin',
} as const

export const openobserveAuth = {
  user: env('SERVER_TEST_OPENOBSERVE_USER') ?? 'root@ozaco.dev',
  // OpenObserve refuses to boot on a weak root password (8-128, upper+lower+digit+special)
  pass: env('SERVER_TEST_OPENOBSERVE_PASS') ?? 'Ozaco-pass1!',
  org: env('SERVER_TEST_OPENOBSERVE_ORG') ?? 'default',
} as const

/** Per-test timeout of the leg. */
export const TIMEOUT = 120_000

/** The placeholder Tempo shows while a trace's root span is missing. */
export const NO_ROOT = '<root span not yet received>'

const basic = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

const need = (url: string | undefined, name: string): string => {
  if (!url) {
    throw new Error(`${name} is not set — run the leg through scripts/test-observe.sh`)
  }

  return url.replace(/\/+$/u, '')
}

// --- polling ------------------------------------------------------------------------------------

export interface PollOptions {
  /** give up after this long (default 60 s) and return what was seen last. */
  readonly timeoutMs?: number | undefined
  readonly intervalMs?: number | undefined

  /** once `done` holds, read ONCE more an interval later and return that read (while it still
   * holds) — an "exactly one" assertion then cannot pass on a half-ingested answer. */
  readonly confirm?: boolean | undefined
}

interface PollState<T> {
  readonly seen: { readonly value: T } | null
  readonly failure: unknown
  readonly confirming: boolean
}

/**
 * Read until `done` holds or the deadline passes; resolves the LAST value read either way (a
 * read that throws counts as nothing seen). Throws only when no read ever succeeded.
 */
export const poll = <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions = {},
): Promise<T> => {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  const interval = options.intervalMs ?? 1000

  const round = async (state: PollState<T>): Promise<T> => {
    let next: PollState<T>

    try {
      const value = await read()
      const holds = done(value)

      if (holds && (state.confirming || !options.confirm)) {
        return value
      }

      next = { seen: { value }, failure: state.failure, confirming: holds }
    } catch (error) {
      next = { seen: state.seen, failure: error, confirming: false }
    }

    if (Date.now() < deadline) {
      await Bun.sleep(interval)

      return round(next)
    }

    if (next.seen) {
      return next.seen.value
    }

    throw next.failure instanceof Error ? next.failure : new Error(`nothing read: ${next.failure}`)
  }

  return round({ seen: null, failure: null, confirming: false })
}

const getJson = async (url: string, init?: RequestInit): Promise<AnyType> => {
  const response = await fetch(url, init)
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} → ${response.status}: ${text.slice(0, 400)}`)
  }

  return JSON.parse(text)
}

// --- ids ----------------------------------------------------------------------------------------

/** A Tempo id as lowercase hex: the v2 API answers base64 (`AFY5…==`), search/hex stays. */
export const hexId = (id: unknown): string | null => {
  if (typeof id !== 'string' || id === '') {
    return null
  }

  if (/^[0-9a-f]+$/u.test(id) && (id.length === 16 || id.length === 32)) {
    return id
  }

  return Buffer.from(id, 'base64').toString('hex')
}

/** A search hit's trace id: Tempo drops leading zero nibbles — pad it back to 32. */
export const traceIdOf = (id: string): string => id.toLowerCase().padStart(32, '0')

// --- OTLP values (Tempo answers OTLP/JSON-shaped traces) ----------------------------------------

interface OtlpValue {
  readonly stringValue?: string
  readonly intValue?: string | number
  readonly doubleValue?: number
  readonly boolValue?: boolean
  readonly arrayValue?: { readonly values?: readonly OtlpValue[] }
  readonly kvlistValue?: { readonly values?: readonly OtlpKeyValue[] }
  readonly bytesValue?: string
}

interface OtlpKeyValue {
  readonly key: string
  readonly value?: OtlpValue
}

const valueOf = (value: OtlpValue | undefined): unknown => {
  if (!value) {
    return null
  }

  if (value.stringValue !== undefined) {
    return value.stringValue
  }

  if (value.intValue !== undefined) {
    return Number(value.intValue)
  }

  if (value.doubleValue !== undefined) {
    return value.doubleValue
  }

  if (value.boolValue !== undefined) {
    return value.boolValue
  }

  if (value.arrayValue) {
    return (value.arrayValue.values ?? []).map(item => valueOf(item))
  }

  if (value.kvlistValue) {
    return attributesOf(value.kvlistValue.values)
  }

  return value.bytesValue ?? null
}

const attributesOf = (list: readonly OtlpKeyValue[] | undefined): Record<string, unknown> =>
  Object.fromEntries((list ?? []).map(entry => [entry.key, valueOf(entry.value)]))

const msOf = (nanos: unknown): number => Number(nanos ?? 0) / 1e6

// --- Tempo --------------------------------------------------------------------------------------

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer' | 'unspecified'

export interface TempoEvent {
  readonly name: string
  readonly time: number
  readonly attributes: Record<string, unknown>
}

export interface TempoLink {
  readonly traceId: string | null
  readonly spanId: string | null
  readonly attributes: Record<string, unknown>
}

/** One span as Tempo stored it — ids hex, kind/status lowercase, times epoch ms. */
export interface TempoSpan {
  readonly traceId: string | null
  readonly spanId: string | null
  readonly parentSpanId: string | null
  readonly name: string
  readonly kind: SpanKind
  readonly status: 'unset' | 'ok' | 'error'
  readonly statusMessage: string | null
  readonly service: string
  readonly resource: Record<string, unknown>
  readonly scope: string
  readonly start: number
  readonly end: number
  readonly attributes: Record<string, unknown>
  readonly events: readonly TempoEvent[]
  readonly links: readonly TempoLink[]
}

const kindOf = (kind: unknown): SpanKind => {
  const name = String(kind ?? '')
    .replace(/^SPAN_KIND_/u, '')
    .toLowerCase()
  const numbered: Record<string, SpanKind> = {
    '1': 'internal',
    '2': 'server',
    '3': 'client',
    '4': 'producer',
    '5': 'consumer',
  }
  const found = numbered[name] ?? name

  return ['internal', 'server', 'client', 'producer', 'consumer'].includes(found)
    ? (found as SpanKind)
    : 'unspecified'
}

const statusOf = (code: unknown): TempoSpan['status'] => {
  const name = String(code ?? '')

  if (name === 'STATUS_CODE_ERROR' || name === '2') {
    return 'error'
  }

  return name === 'STATUS_CODE_OK' || name === '1' ? 'ok' : 'unset'
}

/** Flatten a Tempo v2 `trace.resourceSpans[]` into normalized spans. */
const spansOf = (body: AnyType): TempoSpan[] => {
  const spans: TempoSpan[] = []

  for (const block of body?.trace?.resourceSpans ?? body?.batches ?? []) {
    const resource = attributesOf(block.resource?.attributes)

    for (const scoped of block.scopeSpans ?? block.instrumentationLibrarySpans ?? []) {
      for (const span of scoped.spans ?? []) {
        spans.push({
          traceId: hexId(span.traceId),
          spanId: hexId(span.spanId),
          parentSpanId: hexId(span.parentSpanId),
          name: String(span.name),
          kind: kindOf(span.kind),
          status: statusOf(span.status?.code),
          statusMessage: span.status?.message ?? null,
          service: String(resource['service.name'] ?? ''),
          resource,
          scope: String(scoped.scope?.name ?? scoped.instrumentationLibrary?.name ?? ''),
          start: msOf(span.startTimeUnixNano),
          end: msOf(span.endTimeUnixNano),
          attributes: attributesOf(span.attributes),
          events: (span.events ?? []).map((event: AnyType) => ({
            name: String(event.name),
            time: msOf(event.timeUnixNano),
            attributes: attributesOf(event.attributes),
          })),
          links: (span.links ?? []).map((link: AnyType) => ({
            traceId: hexId(link.traceId),
            spanId: hexId(link.spanId),
            attributes: attributesOf(link.attributes),
          })),
        })
      }
    }
  }

  return spans
}

const fetchTrace = async (traceId: string): Promise<TempoSpan[]> => {
  const response = await fetch(
    `${need(backends.tempo, 'SERVER_TEST_TEMPO_URL')}/api/v2/traces/${traceId}`,
  )

  // 404 until the trace is ingested
  if (response.status === 404) {
    return []
  }

  if (!response.ok) {
    throw new Error(`tempo trace ${traceId} → ${response.status}: ${await response.text()}`)
  }

  return spansOf(await response.json())
}

/**
 * The trace `traceId` as Tempo holds it — polled until every name in `names` is there AND two
 * reads a second apart agree on the span count (a late span of the other node would otherwise
 * slip past a count assertion).
 */
export const tempoTrace = (
  traceId: string,
  names: readonly string[] = [],
  options: PollOptions = {},
): Promise<TempoSpan[]> => {
  let previous = -1

  return poll(
    () => fetchTrace(traceId),
    spans => {
      const complete =
        spans.length > 0 && names.every(name => spans.some(span => span.name === name))
      const stable = complete && spans.length === previous

      previous = spans.length

      return stable
    },
    options,
  )
}

/** One TraceQL search hit (trace id padded back to 32 hex). */
export interface TempoHit {
  readonly traceId: string
  readonly rootServiceName: string | undefined
  readonly rootTraceName: string | undefined
}

/** TraceQL search since `sinceMs`, polled until `done` holds (the index lags 15–30 s). */
export const tempoSearch = (
  query: string,
  done: (hits: readonly TempoHit[]) => boolean,
  options: PollOptions & { readonly sinceMs: number },
): Promise<TempoHit[]> => {
  const base = need(backends.tempo, 'SERVER_TEST_TEMPO_URL')
  const start = Math.floor(options.sinceMs / 1000) - 60
  const end = Math.floor(Date.now() / 1000) + 600

  return poll<TempoHit[]>(
    async () => {
      const url = `${base}/api/search?q=${encodeURIComponent(query)}&start=${start}&end=${end}&limit=500&spss=100`
      const body = await getJson(url)

      return (body.traces ?? []).map((trace: AnyType) => ({
        traceId: traceIdOf(String(trace.traceID)),
        rootServiceName: trace.rootServiceName,
        rootTraceName: trace.rootTraceName,
      }))
    },
    done,
    { timeoutMs: 90_000, intervalMs: 2000, ...options },
  )
}

// --- Loki ---------------------------------------------------------------------------------------

/** One Loki line with its stream labels AND structured metadata merged (`trace_id`, `span_id`,
 * `severity_number`, `exception_type`, … — dots become `_`). */
export interface LokiLine {
  readonly line: string
  readonly time: number
  readonly labels: Readonly<Record<string, string>>
}

const linesOf = (result: AnyType): LokiLine[] =>
  (result ?? []).flatMap((stream: AnyType) =>
    (stream.values ?? []).map(([time, line]: [string, string]) => ({
      line,
      time: Number(time) / 1e6,
      labels: stream.stream ?? {},
    })),
  )

/** A LogQL range query over `[sinceMs - 1 min, now + 10 min]`, polled until `done` holds. */
export const lokiQuery = (
  expr: string,
  done: (lines: readonly LokiLine[]) => boolean,
  options: PollOptions & { readonly sinceMs: number },
): Promise<LokiLine[]> => {
  const base = need(backends.loki, 'SERVER_TEST_LOKI_URL')
  const start = BigInt(options.sinceMs - 60_000) * 1_000_000n
  const end = BigInt(Date.now() + 600_000) * 1_000_000n

  return poll(
    async () => {
      const url = `${base}/loki/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${start}&end=${end}&limit=1000&direction=forward`
      const body = await getJson(url)

      return linesOf(body.data?.result)
    },
    done,
    options,
  )
}

/** The exception records among `lines` (an `exception.type` attribute). */
export const exceptionLines = (lines: readonly LokiLine[]): LokiLine[] =>
  lines.filter(line => line.labels['exception_type'] !== undefined)

// --- Grafana ------------------------------------------------------------------------------------

const grafanaHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: basic(grafanaAuth.user, grafanaAuth.pass),
})

/** The uid of Grafana's (first) datasource of `type` (`loki`, `tempo`, `prometheus`). */
export const grafanaDatasource = async (type: string): Promise<AnyType> => {
  const base = need(backends.grafana, 'SERVER_TEST_GRAFANA_URL')
  const list: AnyType[] = await getJson(`${base}/api/datasources`, { headers: grafanaHeaders() })
  const found = list.find(source => source.type === type)

  if (!found) {
    throw new Error(`grafana has no ${type} datasource: ${JSON.stringify(list.map(s => s.type))}`)
  }

  return found
}

/** One `/api/ds/query` round trip: the frames Grafana answered for refId `A`. */
export const grafanaQuery = async (
  query: Record<string, unknown>,
  window: { readonly from: number; readonly to: number },
): Promise<AnyType[]> => {
  const base = need(backends.grafana, 'SERVER_TEST_GRAFANA_URL')
  const body = await getJson(`${base}/api/ds/query`, {
    method: 'POST',
    headers: grafanaHeaders(),
    body: JSON.stringify({
      queries: [{ refId: 'A', ...query }],
      from: String(Math.floor(window.from)),
      to: String(Math.floor(window.to)),
    }),
  })
  const result = body.results?.A

  if (result?.error) {
    throw new Error(`grafana query failed: ${result.error}`)
  }

  return result?.frames ?? []
}

/** The values of field `name` across `frames` (Grafana's data-frame columns). */
export const frameColumn = (frames: readonly AnyType[], name: string): unknown[] =>
  frames.flatMap(frame => {
    const index = (frame.schema?.fields ?? []).findIndex((field: AnyType) => field.name === name)

    return index === -1 ? [] : (frame.data?.values?.[index] ?? [])
  })

// --- Prometheus ---------------------------------------------------------------------------------

export interface PromSeries {
  readonly metric: Readonly<Record<string, string>>
  readonly value: number
}

/** An instant PromQL query, polled until `done` holds. */
export const promQuery = (
  query: string,
  done: (series: readonly PromSeries[]) => boolean,
  options: PollOptions = {},
): Promise<PromSeries[]> => {
  const base = need(backends.prometheus, 'SERVER_TEST_PROM_URL')

  return poll<PromSeries[]>(
    async () => {
      const body = await getJson(`${base}/api/v1/query?query=${encodeURIComponent(query)}`)

      return (body.data?.result ?? []).map((entry: AnyType) => ({
        metric: entry.metric ?? {},
        value: Number(entry.value?.[1]),
      }))
    },
    done,
    { timeoutMs: 100_000, intervalMs: 2000, ...options },
  )
}

// --- OpenObserve --------------------------------------------------------------------------------

/** An OpenObserve SQL search over the `traces` or `logs` streams since `sinceMs`, polled until
 * `done` holds. Columns are flattened attribute keys (`error_type`, `otel_event_name`, …); span
 * `events` / `links` are JSON strings. */
export const openobserveSearch = (
  type: 'traces' | 'logs',
  sql: string,
  options: PollOptions & {
    readonly sinceMs: number
    readonly done: (hits: readonly AnyType[]) => boolean
  },
): Promise<AnyType[]> => {
  const base = need(backends.openobserve, 'SERVER_TEST_OPENOBSERVE_URL')
  const org = encodeURIComponent(openobserveAuth.org)

  return poll<AnyType[]>(
    async () => {
      const body = await getJson(`${base}/api/${org}/_search?type=${type}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: basic(openobserveAuth.user, openobserveAuth.pass),
        },
        body: JSON.stringify({
          query: {
            sql,
            start_time: (options.sinceMs - 60_000) * 1000,
            end_time: (Date.now() + 600_000) * 1000,
            from: 0,
            size: 500,
          },
        }),
      })

      return body.hits ?? []
    },
    options.done,
    options,
  )
}
