import { createTags } from 'std:shared'

export const DEFAULT_STATUS = 500

export const ACTION = Symbol.for('server:core:action')
export const SERVICE = Symbol.for('server:core:service')
export const BROKER = Symbol.for('server:core:broker')
export const TRANSPORT = Symbol.for('broker:core:transport')
export const TRACER = Symbol.for('server:core:tracer')
export const CODEC = Symbol.for('server:core:codec')

export const CoreErrors = createTags(
  'server:core',

  'validation',
  'random-hex',

  'forbidden',
  'not-found',
  'unauthorized',
  'exists',
  'broker-internal',
  'broker-paused',
  'payload-too-large',
  'missing-settings',
  'protocol-not-cloneable',

  'codec-encode',
  'codec-decode',
  'codec-encode-stream',
  'codec-decode-stream',

  'transport-dispatch',
  'transport-emit',
  'transport-broadcast',
)

export const CoreStatusMap = {
  [CoreErrors.Validation]: 400,
  [CoreErrors.RandomHex]: 500,

  [CoreErrors.Forbidden]: 403,
  [CoreErrors.NotFound]: 404,
  [CoreErrors.Unauthorized]: 401,
  [CoreErrors.Exists]: 409,
  [CoreErrors.BrokerInternal]: 500,
  [CoreErrors.BrokerPaused]: 503,
  [CoreErrors.PayloadTooLarge]: 413,
  [CoreErrors.MissingSettings]: 500,
  [CoreErrors.ProtocolNotCloneable]: 500,

  [CoreErrors.CodecEncode]: 500,
  [CoreErrors.CodecDecode]: 400,

  [CoreErrors.TransportDispatch]: 502,
  [CoreErrors.TransportEmit]: 502,
  [CoreErrors.TransportBroadcast]: 502,
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
