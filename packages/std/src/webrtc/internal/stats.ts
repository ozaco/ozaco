import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { fail, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { RtcDef } from '../types/rtc'

// `getStats()` normalization: every implementation reports the same W3C entry types but with
// different extras, so this reduces the report to the numbers a call actually cares about —
// which candidate pair carries the media, what each RTP stream is doing, and the exact
// per-channel wire volume (the peer's own counters are approximations).

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const ms = (seconds: unknown): number | undefined => {
  const value = num(seconds)
  return value === undefined ? undefined : Math.round(value * 1000 * 100) / 100
}

/** Keep an optional number out of the object entirely when the impl did not report it. */
const put = (key: string, value: number | string | undefined) =>
  value === undefined ? {} : { [key]: value }

const mediaOf = (entry: AnyType, framesKey: 'framesDecoded' | 'framesSent'): RtcDef.MediaStats => ({
  kind: String(entry.kind ?? entry.mediaType ?? 'unknown'),
  ...put('bytes', num(entry.bytesReceived) ?? num(entry.bytesSent)),
  ...put('packets', num(entry.packetsReceived) ?? num(entry.packetsSent)),
  ...put('packetsLost', num(entry.packetsLost)),
  ...put('jitterMs', ms(entry.jitter)),
  ...put('frames', num(entry[framesKey])),
  ...put('fps', num(entry.framesPerSecond)),
  ...put('width', num(entry.frameWidth)),
  ...put('height', num(entry.frameHeight)),
})

/**
 * Read the implementation's statistics report and normalize it. Raises `rtc/unsupported` when
 * the impl has no `getStats` at all, `rtc/stats` when the call itself fails.
 */
export function* readStats(pc: RtcDef.PeerLike): Operation<RtcDef.Stats> {
  if (typeof pc.getStats !== 'function') {
    return yield* fail(
      'rtc/unsupported',
      'this implementation reports no statistics (getStats is absent)',
    )
  }

  const read = yield* attempt(() => until(pc.getStats!()))
  if (!isSuccess(read)) {
    return yield* fail('rtc/stats', 'getStats failed')
  }

  const byId = new Map<string, AnyType>()
  const pairs: AnyType[] = []
  const inbound: RtcDef.MediaStats[] = []
  const outbound: RtcDef.MediaStats[] = []
  const channels: RtcDef.ChannelStats[] = []
  let transport: AnyType | undefined

  // oxlint-disable-next-line unicorn/no-array-for-each -- an RTCStatsReport is Map-like
  read.value.forEach((entry: AnyType, id?: AnyType) => {
    if (!entry || typeof entry !== 'object') {
      return
    }
    byId.set(String(entry.id ?? id ?? byId.size), entry)
    switch (entry.type) {
      case 'candidate-pair': {
        pairs.push(entry)
        break
      }
      case 'inbound-rtp': {
        inbound.push(mediaOf(entry, 'framesDecoded'))
        break
      }
      case 'outbound-rtp': {
        outbound.push(mediaOf(entry, 'framesSent'))
        break
      }
      case 'data-channel': {
        channels.push({
          label: String(entry.label ?? ''),
          ...put('state', typeof entry.state === 'string' ? entry.state : undefined),
          ...put('messagesSent', num(entry.messagesSent)),
          ...put('messagesReceived', num(entry.messagesReceived)),
          ...put('bytesSent', num(entry.bytesSent)),
          ...put('bytesReceived', num(entry.bytesReceived)),
        })
        break
      }
      case 'transport': {
        transport = entry
        break
      }
      default: {
        break
      }
    }
  })

  // the pair the impl marked as selected, else the nominated succeeded one, else the busiest
  const selected =
    pairs.find(entry => entry.selected === true) ??
    (transport?.selectedCandidatePairId
      ? byId.get(String(transport.selectedCandidatePairId))
      : undefined) ??
    pairs.find(entry => entry.nominated === true && entry.state === 'succeeded') ??
    pairs.toSorted((a, b) => (num(b.bytesSent) ?? 0) - (num(a.bytesSent) ?? 0))[0]

  const pair: RtcDef.PairStats | undefined = selected
    ? {
        ...put('local', byId.get(String(selected.localCandidateId))?.candidateType),
        ...put('remote', byId.get(String(selected.remoteCandidateId))?.candidateType),
        ...put('rttMs', ms(selected.currentRoundTripTime)),
        ...put('outgoingBitrate', num(selected.availableOutgoingBitrate)),
        ...put('bytesSent', num(selected.bytesSent)),
        ...put('bytesReceived', num(selected.bytesReceived)),
      }
    : undefined

  return {
    at: Date.now(),
    state: pc.connectionState,
    ...put('bytesSent', num(transport?.bytesSent) ?? num(pair?.bytesSent)),
    ...put('bytesReceived', num(transport?.bytesReceived) ?? num(pair?.bytesReceived)),
    ...(pair === undefined ? {} : { pair }),
    inbound,
    outbound,
    channels,
  }
}

/** The flat numbers a `stats` timeline entry carries (and a metrics sink can chart directly). */
export const flatten = (stats: RtcDef.Stats): Record<string, number | string> => {
  const video = stats.inbound.find(entry => entry.kind === 'video')
  return {
    state: stats.state,
    ...put('rttMs', stats.pair?.rttMs),
    ...put(
      'route',
      stats.pair ? `${stats.pair.local ?? '?'}/${stats.pair.remote ?? '?'}` : undefined,
    ),
    ...put('bytesSent', stats.bytesSent),
    ...put('bytesReceived', stats.bytesReceived),
    ...put('framesDecoded', video?.frames),
    ...put('fps', video?.fps),
    ...put('packetsLost', video?.packetsLost),
    ...put('jitterMs', video?.jitterMs),
  }
}
