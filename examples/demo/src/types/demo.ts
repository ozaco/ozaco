import type { ServerDef } from 'server:core'

import type { OpenObserveDef } from 'server:plugins/observe/openobserve'
import type { OtlpDef } from 'server:plugins/observe/otlp'

import type { services } from '../const'

/** Where a node ships OTLP/HTTP (`scripts/lgtm.ts`): an OpenTelemetry collector — the
 * `grafana/otel-lgtm` image's `:4318` feeds Tempo, Loki and Prometheus behind Grafana. The
 * `OtlpExporter`'s own options, TRANSPORT only: what lands there is exactly what the `/_observe`
 * console (and every other sink) holds. */
export interface OtlpTarget extends Omit<OtlpDef.Options, 'url'> {
  /** the OTLP/HTTP base url (`/v1/{traces,logs,metrics}` is appended). Default
   * `http://localhost:4318`. */
  readonly url?: string | undefined
}

/** Where a node ships to OpenObserve (`scripts/openobserve.ts`, `scripts/lgtm.ts`): its OTLP
 * endpoints — the Traces/Logs/Metrics panels. The `OpenObserveExporter`'s own options (`url`,
 * `org`, `auth: { user, pass } | { token }`, …), TRANSPORT only, like {@link OtlpTarget}. */
export type OpenObserveTarget = OpenObserveDef.Options

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

  /** ship every span, log record and metric to an OTLP/HTTP collector. */
  readonly otlp?: OtlpTarget | undefined

  /** ship every span, log record and metric to an OpenObserve deployment. */
  readonly openobserve?: OpenObserveTarget | undefined

  /** capture request/response bodies AND WS frame bodies into the telemetry — decided once
   * for the node, so every sink (console, OpenObserve, …) carries them alike. Default off. */
  readonly capture?: boolean | undefined

  /** development: watch `src/` and swap the services into the running node on every save. */
  readonly hot?: boolean | undefined

  /** draw every trace in the terminal as a timeline block (`cli:trace` `TerminalTracer`) when
   * it completes — next to the Logger's lines. Default off. */
  readonly timeline?: boolean | undefined
}

/** the typed api of one demo node — what `createClient<Api>` speaks. */
export type Api = ServerDef.Handle<typeof services>['api']

/** One step of the client walk-through (`utils/walk.ts`) — the e2e test asserts on these. */
export interface Step {
  readonly name: string
  readonly detail: unknown
}
