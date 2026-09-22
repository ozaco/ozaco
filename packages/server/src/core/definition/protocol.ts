import type { Protocol } from 'std:plugin'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../../package.json'
import {
  SERVER,
  SERVER_CARRIER,
  SERVER_EDGE,
  SERVER_OBSERVE,
  SERVER_OBSERVE_EXPORTER,
  SERVER_OUTCOMES,
} from '../const'
import { ServerErrors } from '../errors'
import type { CarrierDef } from '../types/carrier'
import type { EdgeDef } from '../types/edge'
import type { ObserveDef } from '../types/observe'
import type { OutcomesDef } from '../types/outcomes'
import type { ServerDef } from '../types/server'

/**
 * The kernel protocol: service → action → dispatch. `createServer` installs its single impl
 * ({@link ServerClient}) first, then the edge, the carrier and the plugins — all of them std
 * plugins — and wires their hooks into it. Not cloneable: one server per scope.
 */
export const Server = defineProtocol<ServerDef.Context, ServerDef.Actions>({
  name: 'server',
  version: pkg.version,
  description: 'The service/action kernel: dispatch, tracing, manifest',

  subtype: SERVER,
})

/**
 * The HTTP/WebSocket face. The engine is core's; an impl (`server:impl/edge/{bun,node,deno}`)
 * only knows how to listen on its runtime. Cloneable so a test can run two edges side by side;
 * `createServer` pins the one it was given.
 */
export const Edge: Protocol<EdgeDef.Options, EdgeDef.Actions> = defineProtocol<
  EdgeDef.Options,
  EdgeDef.Actions
>({
  name: 'server-edge',
  version: pkg.version,
  description: 'HTTP + WebSocket edge over a runtime driver',

  cloneable: true,
  subtype: SERVER_EDGE,
})

/**
 * How dispatches travel between nodes. `LocalCarrier` (core) serves only this process;
 * `NetworkCarrier` rides an `@ozaco/transport`. Cloneable; `createServer` pins the one it was
 * given (or installs `LocalCarrier`).
 */
export const Carrier: Protocol<CarrierDef.Options, CarrierDef.Actions> = defineProtocol<
  CarrierDef.Options,
  CarrierDef.Actions
>({
  name: 'server-carrier',
  version: pkg.version,
  description: 'Cross-node dispatch carrier',

  cloneable: true,
  subtype: SERVER_CARRIER,
})

/** The owner-side outcome store (`MemoryOutcomes` in core, `DbOutcomes` over the db). */
export const Outcomes: Protocol<OutcomesDef.Options, OutcomesDef.Actions> = defineProtocol<
  OutcomesDef.Options,
  OutcomesDef.Actions
>({
  name: 'server-outcomes',
  version: pkg.version,
  description: 'Dispatch outcome records for timeout-pending reconciliation',

  cloneable: true,
  subtype: SERVER_OUTCOMES,
})

/**
 * Where "what happened" is kept: requests, spans, logs, failures and events as db rows. One
 * impl (`server:plugins` → `Observe`); without it the kernel still traces — it just has nowhere
 * to write, and every read action fails `server.unsupported`.
 */
export const Observe: Protocol<ObserveDef.Options, ObserveDef.Actions> = defineProtocol<
  ObserveDef.Options,
  ObserveDef.Actions
>({
  name: 'server-observe',
  version: pkg.version,
  description: 'Requests, spans, logs, failures and events as queryable rows',

  subtype: SERVER_OBSERVE,

  defaults: {
    *record() {},
    *request() {
      return yield* fail(ServerErrors.Unsupported, 'no observe store is installed')
    },
    *query() {
      return yield* fail(ServerErrors.Unsupported, 'no observe store is installed')
    },
    *prune() {
      return yield* fail(ServerErrors.Unsupported, 'no observe store is installed')
    },
    *stats() {
      return { recorded: 0, dropped: 0, pending: 0 }
    },
    *flush() {},
  },
})

/**
 * Where observations are SHIPPED: `OtlpExporter`, `OpenObserveExporter`, `StdoutExporter` (or
 * one of your own — `ObserveExporter.implement(...)`), installed side by side. Cloneable: the
 * kernel fans every event out to all installs, `start`s them with the node and `flush`es them
 * at stop — nested installs included (an exporter may install another one inside its own
 * setup and never relay a thing). Independent of the `Observe` store: exporters work with or
 * without `ObservePlugin`.
 */
export const ObserveExporter: Protocol<ObserveDef.ExporterContext, ObserveDef.ExporterActions> =
  defineProtocol<ObserveDef.ExporterContext, ObserveDef.ExporterActions>({
    name: 'server-observe-exporter',
    version: pkg.version,
    description: 'A destination the observed requests, spans, logs, failures and events go to',

    subtype: SERVER_OBSERVE_EXPORTER,
    cloneable: true,

    defaults: {
      *export() {},
      *start() {},
      *flush() {},
    },

    // every exporter sees every call, in install order — SEQUENTIALLY, in the caller's scope:
    // `start` forks age timers and beats that must outlive the call (an `all` fan-out would
    // close its child scopes and halt them on the way out)
    *exec(entries, run) {
      for (const entry of entries) {
        yield* run(entry)
      }
    },
  })
