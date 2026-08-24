// oxlint-disable import/exports-last
/**
 * The console's data layer: ONE `@ozaco/client` over the REAL `observe` service. The client
 * bootstraps from the service's OWN manifest (`GET /_observe/api/manifest`), so the console
 * works with or without the docs plugin — and there is no schema to keep in sync here.
 */
import type { ClientDef } from '@ozaco/client'
import { connectClient } from '@ozaco/client'
import type { FutureFlow } from '@ozaco/std/effect'
import { unwrap } from '@ozaco/std/result'

declare global {
  interface Window {
    __OZACO_OBSERVE__?: { base?: string }
  }
}

export { wireFailureOf as failureOf } from '@ozaco/client'

// --- the rows as the store writes them ---------------------------------------------------------

export interface RequestRow {
  readonly requestId: string
  readonly service: string | null
  readonly action: string | null
  readonly method: string | null
  readonly path: string | null
  readonly socket: string | null
  readonly status: number | null
  readonly serviceId: string
  readonly instance: string
  readonly lane: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly durationMs: number | null
  readonly error: string | null
  readonly attrs: Readonly<Record<string, unknown>> | null

  /** captured while observing: redacted request headers + the in/out body snapshots. */
  readonly headers: Readonly<Record<string, string>> | null
  readonly input: BodySnapshot | null
  readonly output: BodySnapshot | null
}

/** What went through one plane: capped data, or a stream/flow/parts descriptor. */
export interface BodySnapshot {
  readonly kind: 'data' | 'stream' | 'flow' | 'parts'
  readonly brand?: string | null
  readonly data?: unknown
  readonly fields?: unknown
  readonly streams?: Readonly<Record<string, string>>
  readonly size?: number | null
  readonly truncated?: boolean
}

export interface SpanRow {
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly name: string
  readonly kind: string
  readonly serviceId: string
  readonly instance: string
  readonly actionId: string | null
  readonly transport: string | null
  readonly startedAt: number
  readonly endedAt: number
  readonly status: string
  readonly attrs: Readonly<Record<string, unknown>> | null
}

export interface LogRow {
  readonly level: string
  readonly msg: string
  readonly data: Readonly<Record<string, unknown>> | null
}

export interface FailureRow {
  readonly tag: string
  readonly message: string
  readonly causes: readonly string[]
  readonly where: string
}

export interface EventRow {
  readonly kind: string
  readonly name: string
  readonly size: number | null

  /** socket frames carry their FULL payload while observing — replayable. */
  readonly data?: unknown
}

export interface RequestView {
  readonly request: RequestRow
  readonly spans: readonly SpanRow[]
  readonly logs: readonly LogRow[]
  readonly failures: readonly FailureRow[]
  readonly events: readonly EventRow[]
}

export interface Page {
  readonly requests: readonly RequestRow[]
  readonly cursor: string | null
}

export interface Stats {
  readonly recorded: number
  readonly dropped: number
  readonly pending: number
}

export interface Member {
  readonly instance: string
  readonly version: string
  readonly draining: boolean
}

export interface InstanceStat {
  readonly instance: string
  readonly serviceId: string
  readonly spans: number
  readonly failed: number
  readonly p95Ms: number | null
}

export interface ClusterView {
  readonly members: Readonly<Record<string, readonly Member[]>>
  readonly instances: readonly InstanceStat[]
  readonly since: number
}

// --- the client ---------------------------------------------------------------------------------

export const base = (): string =>
  window.__OZACO_OBSERVE__?.base ?? window.location.origin.replace(/\/$/u, '')

let opened: Promise<
  ClientDef.ConnectedHandle<Record<string, Record<string, ClientDef.Ref>>>
> | null = null

const client = () => (opened ??= connectClient({ url: base(), docsPath: '/_observe/api' }))

const call = async <T>(target: string, input?: unknown): Promise<T> => {
  const handle = await client()
  return unwrap(await handle.$call(target, input)) as T
}

export interface RequestsQuery {
  readonly limit?: number
  readonly cursor?: string
}

export const fetchRequests = (query: RequestsQuery): Promise<Page> =>
  call('observe.requests', query)

export const fetchRequest = (id: string): Promise<RequestView> => call('observe.request', { id })

export const fetchStats = (): Promise<Stats> => call('observe.stats')

export const fetchCluster = (): Promise<ClusterView> => call('observe.cluster', {})

/** The live feed: one batch of freshly finished requests per iteration. */
export const liveBatches = (): Promise<FutureFlow<readonly RequestRow[]>> => call('observe.live')
