import { createTags } from 'std:shared'

export const DEFAULT_STATUS = 500

export const ACTION = Symbol.for('server:core:action')
export const SERVICE = Symbol.for('server:core:service')
export const SERVER = Symbol.for('server:core:server')
export const TRANSPORT = Symbol.for('server:core:transport')

export const CoreErrors = createTags(
  'server:core',
  'validation',
  'forbidden',
  'not-found',
  'unauthorized',
  'exists',
  'server-internal',
  'server-paused',
  'payload-too-large',
  'missing-settings',
  'protocol-not-cloneable',
)

export const CoreStatusMap = {
  [CoreErrors.Validation]: 400,
  [CoreErrors.Forbidden]: 403,
  [CoreErrors.NotFound]: 404,
  [CoreErrors.Unauthorized]: 401,
  [CoreErrors.Exists]: 409,
  [CoreErrors.ServerInternal]: 500,
  [CoreErrors.ServerPaused]: 503,
  [CoreErrors.PayloadTooLarge]: 413,
  [CoreErrors.MissingSettings]: 500,
  [CoreErrors.ProtocolNotCloneable]: 500,
}
