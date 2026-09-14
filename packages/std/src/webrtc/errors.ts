import { createTags } from 'std:shared'

export const RtcErrors = createTags(
  'std:webrtc',

  'unsupported',
  'connect',
  'connection',
  'negotiation',
  'signal',
  'ice-exhausted',
  'reconnect-exhausted',

  'channel',
  'timeout',
  'track',
  'stats',
)
