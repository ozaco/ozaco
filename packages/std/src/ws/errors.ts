import { createTags } from 'std:shared'

export const WsErrors = createTags(
  'std:ws',

  'connect',
  'unsupported',
  'reconnect-exhausted',
)

/** The cause names ws stamps on its operations. */
export const WsCauses = createTags(
  'std:ws',

  'connect',
  'dial',
  'send',
  'close',
  'keepalive',
  'reconnect',
  'open',
  'state-change',
)
