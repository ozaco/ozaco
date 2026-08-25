import type { AnyType } from 'std:shared'

import type { RtcDef } from '../types/rtc'

// Signal-frame helpers: everything that travels over the signaling duplex is a small tagged
// object (`t: 'rtc:*'`), so a shared socket's other traffic (keepalive pings, app frames) is
// simply ignored by the peer's signal pump.

/** Validate an incoming signal value into a frame — `undefined` for anything that is not ours. */
export const frameOf = (value: unknown): RtcDef.SignalFrame | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const frame = value as AnyType
  if (frame.t === 'rtc:description' && typeof frame.description?.type === 'string') {
    return frame as RtcDef.DescriptionFrame
  }
  if (frame.t === 'rtc:candidate' && 'candidate' in frame) {
    return frame as RtcDef.CandidateFrame
  }
  if (frame.t === 'rtc:bye') {
    return frame as RtcDef.ByeFrame
  }
  return undefined
}

/** Whether a description slot is genuinely SET. Never truthiness-test `localDescription` /
 * `remoteDescription` directly: the node-datachannel polyfill returns a truthy `{ sdp: '' }`
 * object for UNSET slots where the browser returns `null`. */
export const hasDescription = (description: RtcDef.DescriptionLike | null): boolean =>
  Boolean(description) && typeof description?.sdp === 'string' && description.sdp.length > 0

/** Strip an impl description object (possibly a live `RTCSessionDescription`) to plain JSON. */
export const descriptionOf = (description: RtcDef.DescriptionLike): RtcDef.DescriptionLike => ({
  type: description.type,
  ...(description.sdp === undefined ? {} : { sdp: description.sdp }),
})

/** Strip an impl candidate object (possibly a live `RTCIceCandidate`) to plain JSON. */
export const candidateOf = (
  candidate: RtcDef.CandidateLike | null,
): RtcDef.CandidateLike | null => {
  if (!candidate) {
    return null
  }
  if (typeof candidate.toJSON === 'function') {
    return candidate.toJSON() as RtcDef.CandidateLike
  }
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    ...(candidate.usernameFragment === undefined
      ? {}
      : { usernameFragment: candidate.usernameFragment }),
  }
}
