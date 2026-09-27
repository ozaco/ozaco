// oxlint-disable import/exports-last
/**
 * The console's data layer: ONE `@ozaco/client` over the REAL `observe` service. The client
 * bootstraps from the service's OWN manifest (`GET /_observe/api/manifest`), so the console
 * works with or without the docs plugin — and there is no schema to keep in sync here. An API
 * gated by `ObservePlugin.use({ auth })` refuses a call without a fitting bearer token: the
 * console asks for one (`isRefused`), keeps it for this tab only and sends it on every call.
 */
import type { ClientDef } from 'client:core'
import { connectClient, wireFailureOf } from 'client:core'
import type { FutureFlow } from 'std:effect'
import { unwrap } from 'std:result'

declare global {
  interface Window {
    __OZACO_OBSERVE__?: { base?: string }
  }
}

export { wireFailureOf as failureOf } from 'client:core'

// --- the rows as the store writes them (`_ob2_spans` / `_ob2_logs`) ------------------------------

export type AttrValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[]

export type Attributes = Readonly<Record<string, AttrValue>>

export interface SpanContext {
  readonly traceId: string
  readonly spanId: string
  readonly flags: number
}

export interface Link {
  readonly context: SpanContext
  readonly attributes?: Attributes
}

export interface SpanEvent {
  readonly name: string
  readonly time: number
  readonly attributes?: Attributes
}

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

/** One finished span, with the resource it belongs to. `root` = a LOCAL root (no parent, or a
 * remote one). */
export interface SpanRow {
  readonly trace_id: string
  readonly span_id: string
  readonly parent_span_id: string | null
  readonly name: string
  readonly kind: SpanKind
  readonly scope: string
  readonly scope_version: string | null
  readonly service_name: string
  readonly service_instance_id: string
  readonly start: number
  readonly end: number
  readonly duration_ms: number
  readonly status_code: 'unset' | 'error'
  readonly status_message: string | null
  readonly error_type: string | null
  readonly root: boolean
  readonly http_route: string | null
  readonly http_status: number | null
  readonly request_id: string | null
  readonly attributes: Attributes
  readonly events: readonly SpanEvent[]
  readonly links: readonly Link[]
  readonly resource: Attributes
}

/** One log record: a log line, an exception (an `…exception` event name), an event, a domain
 * record. */
export interface LogRow {
  readonly trace_id: string | null
  readonly span_id: string | null
  readonly time: number
  readonly severity_number: number
  readonly severity_text: string | null
  readonly body: string
  readonly event_name: string | null
  readonly service_name: string
  readonly service_instance_id: string
  readonly scope: string
  readonly attributes: Attributes
}

export interface TraceView {
  readonly trace_id: string
  readonly spans: readonly SpanRow[]
  readonly logs: readonly LogRow[]
}

export interface TracesPage {
  readonly traces: readonly SpanRow[]
  readonly cursor: string | null
}

export interface Stats {
  readonly recorded: number
  readonly dropped: number
  readonly pending: number
  readonly forwarded?: number
  readonly received?: number
  readonly fellBack?: number
}

export interface Member {
  readonly instance: string
  readonly version: string
  readonly draining: boolean
}

export interface InstanceStat {
  readonly instance: string
  readonly services: readonly string[]
  readonly spans: number
  readonly failed: number
  readonly p95_ms: number | null
  readonly last_seen: number
}

export interface ClusterView {
  readonly members: Readonly<Record<string, readonly Member[]>>
  readonly instances: readonly InstanceStat[]
  readonly since: number
}

/** Whether a log record is an EXCEPTION record (the failures list). */
export const isExceptionLog = (log: LogRow): boolean =>
  log.event_name !== null && /(?:^|\.)exception$/u.test(log.event_name)

// --- the client ---------------------------------------------------------------------------------

export const base = (): string =>
  window.__OZACO_OBSERVE__?.base ?? window.location.origin.replace(/\/$/u, '')

let opened: Promise<
  ClientDef.ConnectedHandle<Record<string, Record<string, ClientDef.Ref>>>
> | null = null

/** Where the bearer token the API asked for is kept: this tab only (`sessionStorage`) — never
 * the url, never a cookie. */
const TOKEN_KEY = 'ozaco.observe.token'

/** The token the client sends (`authorization: Bearer …`), read at every call. */
export const storedToken = (): string | undefined => {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Keep `token` for the calls from here on — `null` (or blank) forgets it. */
export const setToken = (token: string | null): void => {
  const value = token?.trim() ?? ''

  try {
    if (value) {
      window.sessionStorage.setItem(TOKEN_KEY, value)
    } else {
      window.sessionStorage.removeItem(TOKEN_KEY)
    }
  } catch {
    // no storage (a private window): the token lives as long as this page does
  }
}

/** Whether the API refused a call for WHO asked (401 / 403): the console asks for a token. */
export const isRefused = (error: unknown): boolean => {
  const { status, tag } = wireFailureOf(error)

  return (
    status === 401 ||
    status === 403 ||
    tag === 'client.refused' ||
    tag === 'server.unauthorized' ||
    tag === 'server.forbidden'
  )
}

const client = () =>
  (opened ??= connectClient({ url: base(), docsPath: '/_observe/api', token: storedToken }).catch(
    (error: unknown) => {
      // a refused manifest (no token yet) must not stick: the next call connects again
      opened = null
      throw error
    },
  ))

const call = async <T>(target: string, input?: unknown): Promise<T> => {
  const handle = await client()
  return unwrap(await handle.$call(target, input)) as T
}

export interface TracesQuery {
  readonly limit?: number
  readonly cursor?: string
}

export const fetchTraces = (query: TracesQuery): Promise<TracesPage> =>
  call('observe.traces', query)

export const fetchTrace = (id: string): Promise<TraceView> => call('observe.trace', { id })

/** A request id (`x-request-id`) — or a trace id — to its trace. */
export const fetchRequest = (id: string): Promise<TraceView> => call('observe.request', { id })

export const fetchStats = (): Promise<Stats> => call('observe.stats')

export const fetchCluster = (): Promise<ClusterView> => call('observe.cluster', {})

/** The live feed: one batch of freshly stored root spans per iteration. */
export const liveBatches = (): Promise<FutureFlow<readonly SpanRow[]>> => call('observe.live')
