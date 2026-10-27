/**
 * `@ozaco/server/internal` — the kernel-level surface the first-party edges, carriers and
 * plugins are built on: brand plumbing, the kernel's std:trace spans (dispatch / carrier / edge
 * spans, the `server-tracer`, the observe fan-out), the running dispatch's span for plugins
 * (`dispatchSpan()`, `dispatchFailure`), the protocol defaults, the declaration guards and the
 * shared symbols.
 *
 * Application code does not need any of it — `@ozaco/server` (service / action / stream /
 * `Server.actions.create` / serviceErrors) is the whole surface for writing a server. Reach in
 * here when you are writing an Edge, a Carrier or a server plugin of your own; what needs the
 * running kernel (`openEdge`, `dispatchSpan`) is a `Server.actions.*` action, not an export.
 */
export {
  ACTION,
  DEFAULT_OUTCOME_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  EXCEPTION_EVENT_NAME,
  OBSERVE_CONSOLE_PATH,
  OBSERVE_PREFIX,
  PARTS_DECL,
  SERVER,
  SERVER_CARRIER,
  SERVER_EDGE,
  SERVER_OBSERVE,
  SERVER_OUTCOMES,
  SERVICE,
  serviceIdOf,
  STREAM_BRAND,
  STREAM_DECL,
  TRACE_SCOPE,
} from './core/const'
export { HEADERS } from './core/const'
export { STATUS_OF } from './core/errors'
export { ActiveRequest, CtxRef, RequestRef } from './core/context'
export { SENT_BINDING } from './core/internal/const'
export { edgeActions } from './core/utils/edge'
export { breadcrumb, statusOf, tagOf } from './core/utils/failure'
export { isSchema, isService, isSocketAction } from './core/utils/service'
export { rewrapResponse } from './core/utils/response'
export { createSink } from './core/utils/sink'
export {
  brandOf,
  brandSpecOf,
  brandStream,
  isBranded,
  isPartsDecl,
  isStreamDecl,
} from './core/utils/stream'
export { answeredBy, dispatchFailure, isRequestId, resourceOf, scopeOf } from './core/utils/trace'
export { validate } from './core/utils/validation'
