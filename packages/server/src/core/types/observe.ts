import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { CarrierDef } from './carrier'
import type { ServerDef } from './server'
import type { TraceDef } from './trace'

/**
 * What the kernel reports and what the observe store answers. The store is a db: every event
 * becomes a row in `_ob_*` tables, queryable and watchable with the db's own tools.
 */
export namespace ObserveDef {
  export type Level = 'debug' | 'info' | 'warn' | 'error'

  export interface RequestRow {
    readonly request_id: string
    readonly origin: TraceDef.Origin

    /** the root action (`service.action`) when the request entered through one. */
    readonly service: string | null
    readonly action: string | null
    readonly edge: string | null
    readonly method: string | null
    readonly path: string | null
    readonly socket: string | null
    readonly status: number | null
    readonly service_id: string

    /** the node that answered. */
    readonly instance: string
    readonly lane: string
    readonly started_at: number
    readonly ended_at: number | null
    readonly duration_ms: number | null
    readonly error: string | null
    readonly attrs: Readonly<Record<string, unknown>> | null

    /** Captured only while an observer is installed: the request headers, secrets redacted. */
    readonly headers: Readonly<Record<string, string>> | null

    /** What went in / came out — `{ kind: 'data'|'stream'|'flow'|'parts', brand?, contentType?,
     * data?, size?, truncated?, streams? }`; `data` is capped, big bodies keep only the size. */
    readonly input: Readonly<Record<string, unknown>> | null
    readonly output: Readonly<Record<string, unknown>> | null
  }

  export interface LogRow {
    readonly request_id: string | null
    readonly span_id: string | null
    readonly level: Level
    readonly msg: string
    readonly data: Readonly<Record<string, unknown>> | null
    readonly ts: number
  }

  export interface FailureRow {
    readonly request_id: string | null
    readonly span_id: string | null
    readonly tag: string
    readonly message: string
    readonly causes: readonly string[]
    readonly status: number | null
    readonly where: string
    readonly ts: number
  }

  export type EventKind = 'emit' | 'socket-in' | 'socket-out' | 'lane-open' | 'lane-close'

  export interface EventRow {
    readonly request_id: string | null
    readonly kind: EventKind
    readonly name: string
    readonly size: number | null
    readonly ts: number

    /** socket frames keep their FULL payload (captured while observing) — replayable. */
    readonly data?: unknown
  }

  /** A streamed body finished AFTER its request row went out: the final size and duration. */
  export interface RequestUpdate {
    readonly request_id: string

    readonly patch: {
      readonly input?: Readonly<Record<string, unknown>> | null
      readonly output?: Readonly<Record<string, unknown>> | null
      readonly duration_ms?: number
      readonly ended_at?: number
    }
  }

  /** One thing the kernel observed. */
  export type Event =
    | { readonly t: 'request'; readonly row: RequestRow }
    | { readonly t: 'request-update'; readonly update: RequestUpdate }
    | { readonly t: 'span'; readonly row: TraceDef.Span }
    | { readonly t: 'log'; readonly row: LogRow }
    | { readonly t: 'failure'; readonly row: FailureRow }
    | { readonly t: 'event'; readonly row: EventRow }

  /** A request with everything that happened under it. */
  export interface RequestView {
    readonly request: RequestRow
    readonly spans: readonly TraceDef.Span[]
    readonly logs: readonly LogRow[]
    readonly failures: readonly FailureRow[]
    readonly events: readonly EventRow[]
  }

  export interface Query {
    readonly service?: string | undefined
    readonly action?: string | undefined
    readonly status?: 'ok' | 'failed' | undefined
    readonly tag?: string | undefined

    /** only requests slower than this many ms. */
    readonly slowerThan?: number | undefined

    /** only requests started at/after this epoch ms. */
    readonly since?: number | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
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

  export interface Options extends ServerDef.PluginContext {
    readonly store: string
  }

  /** One node as the store has seen it lately: its edge/dispatch/carrier spans in the window. */
  export interface InstanceStats {
    readonly instance: string
    readonly service_id: string
    readonly spans: number
    readonly failed: number
    readonly p95_ms: number | null
    readonly last_seen: number
  }

  /** The cluster as observed: presence members per service + per-instance request stats. */
  export interface ClusterView {
    readonly members: Readonly<Record<string, readonly CarrierDef.Member[]>>
    readonly instances: readonly InstanceStats[]

    /** the stats window (epoch ms). */
    readonly since: number
  }

  export interface Actions {
    describe(): Operation<Options>
    record(event: Event): Operation<void>

    /** Presence members + per-instance stats over the last `windowMs` (default 15 min). */
    cluster(windowMs?: number): Operation<ClusterView>
    request(requestId: string): Operation<RequestView | null>
    query(query?: Query): Operation<Page>

    /** Live requests as they finish (delta-mode watch on the requests table). */
    watch(query?: Query): Flow<readonly RequestRow[], never>

    /** Delete rows older than `before` (epoch ms); resolves how many went. */
    prune(before: number): Operation<number>
    stats(): Operation<Stats>

    /** Flush whatever the collector still holds. */
    flush(): Operation<void>
  }

  export type Handle = Plugin<Options, AnyType[], Actions>
}
