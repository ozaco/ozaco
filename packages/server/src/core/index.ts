/**
 * `@ozaco/server` — the service/action kernel. Define services with `service()` / `action.*`,
 * build a node with `createServer({ services, edge, carrier, plugins })`, and every other
 * concern — HTTP/WS edges (`@ozaco/server/edge/*`), cross-node carriers
 * (`@ozaco/server/carrier/network`), observability, auth, cache, resilience, docs, resources
 * (`@ozaco/server/plugins`) — is a std plugin the kernel wires in. Streams are branded; "what
 * happened" is a db row.
 *
 * This barrel is the WHOLE surface an application needs. The plumbing the first-party edges,
 * carriers and plugins are built on lives in `@ozaco/server/internal`.
 */

export { HEADERS } from './const'
export { ServerErrors, STATUS_OF } from './errors'
export { CtxRef, TraceRef } from './context'

export { DbOutcomes } from './definition/outcomes'
export { Carrier, Edge, Observe, Outcomes, Server } from './definition/protocol'

export { serviceErrors } from './utils/errors'
export { defineEvents } from './utils/events'
export { statusOf, tagOf } from './utils/failure'
export { outcomesTable } from './utils/outcomes'
export { createServer } from './utils/server'
export { action, ref, refs, service } from './utils/service'
export { stream } from './utils/stream'

export type { Sink } from './utils/sink'

export type * from './types/carrier'
export type * from './types/edge'
export type * from './types/errors'
export type * from './types/events'
export type * from './types/helpers'
export type * from './types/observe'
export type * from './types/options'
export type * from './types/outcomes'
export type * from './types/server'
export type * from './types/service'
export type * from './types/stream'
export type * from './types/trace'
export type * from './types/wire'
