import { createTags } from 'std:shared'

export const DEFAULT_STATUS = 500

export const ACTION = Symbol.for('server:core:action')
export const SERVICE = Symbol.for('server:core:service')
export const BROKER = Symbol.for('server:core:broker')
export const TRANSPORT = Symbol.for('broker:core:transport')

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
}
