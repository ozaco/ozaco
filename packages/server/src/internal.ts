/**
 * `@ozaco/server/internal` — the kernel-level surface the first-party edges, carriers and
 * plugins are built on: brand plumbing, trace/span plumbing, the protocol defaults, the
 * declaration guards and the shared symbols.
 *
 * Application code does not need any of it — `@ozaco/server` (service / action / stream /
 * createServer / serviceErrors) is the whole surface for writing a server. Reach in here when
 * you are writing an Edge, a Carrier or a server plugin of your own.
 */
export {
  ACTION,
  DEFAULT_OUTCOME_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  laneOf,
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
} from './core/const'
export { LocalCarrier } from './core/definition/local'
export { MemoryOutcomes } from './core/definition/outcomes'
export { ServerClient } from './core/definition/server'
export { edgeActions, openEdge } from './core/utils/edge'
export { breadcrumb } from './core/utils/failure'
export { isSchema, isSocketAction } from './core/utils/service'
export { createSink } from './core/utils/sink'
export {
  brandOf,
  brandSpecOf,
  brandStream,
  isBranded,
  isPartsDecl,
  isStreamDecl,
} from './core/utils/stream'
export {
  childTrace,
  continueTrace,
  report,
  requestId,
  rootTrace,
  spanId,
  toWire,
  withSpan,
} from './core/utils/trace'
export { validate } from './core/utils/validation'
