import type { Operation } from 'std:effect'
import type { Protocol } from 'std:plugin'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'

import { SERVER, SERVER_CARRIER, SERVER_EDGE, SERVER_OBSERVE, SERVER_OUTCOMES } from '../const'
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
  version: '0.5.0',
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
  version: '0.5.0',
  description: 'HTTP + WebSocket edge over a runtime driver',

  cloneable: true,
  subtype: SERVER_EDGE,

  defaults: {
    *describe(): Operation<EdgeDef.Options> {
      return yield* (Edge as Protocol<EdgeDef.Options>).context.expect()
    },
  },
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
  version: '0.5.0',
  description: 'Cross-node dispatch carrier',

  cloneable: true,
  subtype: SERVER_CARRIER,

  defaults: {
    *describe(): Operation<CarrierDef.Options> {
      return yield* (Carrier as Protocol<CarrierDef.Options>).context.expect()
    },
  },
})

/** The owner-side outcome store (`MemoryOutcomes` in core, `DbOutcomes` over the db). */
export const Outcomes: Protocol<OutcomesDef.Options, OutcomesDef.Actions> = defineProtocol<
  OutcomesDef.Options,
  OutcomesDef.Actions
>({
  name: 'server-outcomes',
  version: '0.5.0',
  description: 'Dispatch outcome records for timeout-pending reconciliation',

  cloneable: true,
  subtype: SERVER_OUTCOMES,

  defaults: {
    *describe(): Operation<OutcomesDef.Options> {
      return yield* (Outcomes as Protocol<OutcomesDef.Options>).context.expect()
    },
  },
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
  version: '0.5.0',
  description: 'Requests, spans, logs, failures and events as queryable rows',

  subtype: SERVER_OBSERVE,

  defaults: {
    *describe(): Operation<ObserveDef.Options> {
      return yield* (Observe as Protocol<ObserveDef.Options>).context.expect()
    },
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
