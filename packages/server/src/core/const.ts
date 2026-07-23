import { CodecErrors } from 'std:codec'
import { createTags } from 'std:shared'

export const DEFAULT_STATUS = 500

export const ACTION = Symbol.for('server:core:action')
export const SERVICE = Symbol.for('server:core:service')
export const BROKER = Symbol.for('server:core:broker')
export const TRANSPORT = Symbol.for('broker:core:transport')
export const TRACER = Symbol.for('server:core:tracer')
export const POLICY = Symbol.for('server:core:policy')
export const POLICY_SETTING = Symbol.for('server:core:policy-setting')

export const GATEWAY = Symbol.for('server:core:gateway')

// Default layering of the built-in policies. Policies are applied as an onion sorted ascending by
// priority: the LOWEST number is the OUTERMOST layer. Timeout is innermost (highest) on purpose —
// a timeout must surface as a normal thrown CoreErrors.Timeout that the outer stateful policies
// (circuit-breaker, metrics, retry, fallback) observe through their catch blocks. If timeout sat
// outside them it would HALT their generators, and a halt runs neither catch nor finally (only
// scope `ensure` cleanup) — so they could neither record the failure nor release their state.
export const PolicyPriority = {
  Cache: 0,
  Fallback: 5,
  Bucket: 10,
  Bulk: 20,
  Retry: 30,
  CircuitBreaker: 40,
  Metrics: 50,
  Timeout: 60,
} as const

export const CoreErrors = createTags(
  'server:core',

  'validation',
  'random-hex',

  'forbidden',
  'not-found',
  'unauthorized',
  'exists',
  'precondition-failed',
  'broker-internal',
  'broker-paused',
  'payload-too-large',
  'missing-settings',
  'protocol-not-cloneable',

  'transport-dispatch',
  'transport-emit',
  'transport-broadcast',

  'circuit-open',
  'bulk-queue-full',
  'bulk-queue-timeout',
  'timeout',
)

export const CoreStatusMap = {
  [CoreErrors.Validation]: 400,
  [CoreErrors.RandomHex]: 500,

  [CoreErrors.Forbidden]: 403,
  [CoreErrors.NotFound]: 404,
  [CoreErrors.Unauthorized]: 401,
  [CoreErrors.Exists]: 409,
  [CoreErrors.PreconditionFailed]: 412,
  [CoreErrors.BrokerInternal]: 500,
  [CoreErrors.BrokerPaused]: 503,
  [CoreErrors.PayloadTooLarge]: 413,
  [CoreErrors.MissingSettings]: 500,
  [CoreErrors.ProtocolNotCloneable]: 500,

  [CodecErrors.Encode]: 500,
  [CodecErrors.Decode]: 400,

  [CoreErrors.TransportDispatch]: 502,
  [CoreErrors.TransportEmit]: 502,
  [CoreErrors.TransportBroadcast]: 502,

  [CoreErrors.CircuitOpen]: 503,
  [CoreErrors.BulkQueueFull]: 503,
  [CoreErrors.BulkQueueTimeout]: 504,
  [CoreErrors.Timeout]: 504,
}

export const OTEL_RPC_SYSTEM = 'ozaco-broker'
export const OTEL_MESSAGING_SYSTEM = 'ozaco-broker'

export const OtelSpanKind = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const

export const OtelSpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const

export const OtelAttrs = {
  RPC_SYSTEM: 'rpc.system',
  RPC_SERVICE: 'rpc.service',
  RPC_METHOD: 'rpc.method',

  MESSAGING_SYSTEM: 'messaging.system',
  MESSAGING_OPERATION: 'messaging.operation',
  MESSAGING_DESTINATION_NAME: 'messaging.destination.name',

  BROKER_NAME: 'broker.name',
  BROKER_NODE_ID: 'broker.node_id',

  SERVICE_NAME: 'service.name',
  SERVICE_VERSION: 'service.version',
  SERVICE_INSTANCE_ID: 'service.instance.id',

  EXCEPTION_MESSAGE: 'exception.message',
} as const
