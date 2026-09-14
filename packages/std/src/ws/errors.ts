import { createTags } from 'std:shared'

export const WsErrors = createTags(
  'std:ws',

  'connect',
  'unsupported',
  'reconnect-exhausted',
)
