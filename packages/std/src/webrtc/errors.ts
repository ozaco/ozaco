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

/** The cause names webrtc stamps on its operations (pumps, supervisors, handles). */
export const RtcCauses = createTags(
  'std:webrtc',

  'connect',
  'close',
  'stats',
  'channel-send',
  'channel-close',
  'replace-track',
  'load-polyfill',
  'resolve-impl',
  'negotiation',
  'signal-pump',
  'candidate-pump',
  'incoming-channels',
  'stats-sampler',
  'ice-restart',
  'reconnect',
)
