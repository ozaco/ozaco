import type { ServerDef } from 'server:core'

import type { services } from '../const'

/** Where a node ships its observability (`scripts/openobserve.ts`): one exporter covers the
 * raw per-kind streams AND the Traces/Logs/Metrics panels (its embedded OTLP leg). */
export interface OpenObserveTarget {
  /** the OpenObserve base url (`http://localhost:5080`). */
  readonly url: string

  /** the organization. Default `default`. */
  readonly org?: string | undefined

  /** `user:pass` → HTTP basic, anything else → a bearer token. */
  readonly auth?: string | undefined

  /** carry request bodies AND WS frame / emit payloads into the streams + traces. */
  readonly bodies?: boolean | undefined
}

export interface DemoOptions {
  /** what this node is. Default: a monolith running everything. */
  readonly role?: ServerDef.Role | undefined

  /** the services THIS node hosts (service role). */
  readonly hosted?: readonly string[] | undefined

  /** this node's name in presence and traces. */
  readonly instance?: string | undefined

  /** the edge port (`0` = ephemeral). A service node only gets an edge when a port is given. */
  readonly port?: number | undefined

  /** a shared in-process memory link — nodes holding the same link are one cluster. */
  readonly link?: unknown

  /** the sqlite file (one file shared by every node of a cluster). Default: in-memory. */
  readonly dbPath?: string | undefined

  /** cluster observe: service nodes `'forward'` their rows to the node that runs as
   * `'collect'` (`'and-local'` forwards AND keeps a local copy). Default: rows stay local. */
  readonly observe?: 'forward' | 'and-local' | 'collect' | undefined

  /** ship every row and trace to an OpenObserve deployment. */
  readonly openobserve?: OpenObserveTarget | undefined
}

/** the typed api of one demo node — what `createClient<Api>` speaks. */
export type Api = ServerDef.Handle<typeof services>['api']

/** One step of the client walk-through (`utils/walk.ts`) — the e2e test asserts on these. */
export interface Step {
  readonly name: string
  readonly detail: unknown
}
