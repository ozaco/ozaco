/**
 * A platform call that rejects is rewrapped over the effect runtime's fold of the rejection — two
 * levels (`rtc.<tag>` → `std:result.unknown`, the platform error kept as its `raw`).
 */
import { attempt, run } from 'std:effect'
import type { Result } from 'std:result'
import { ResultErrors, formatFailure, isFailure, unwrap } from 'std:result'
import type { RtcDef } from 'std:webrtc'
import { Rtc, RtcErrors } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import type { FakePeer, FakeSender } from './fake'
import { createFakeRtc, createSignalPair } from './fake'

const mic = (id: string): RtcDef.TrackLike => ({ id, kind: 'audio' })

/** The failure's shape: its tag, and each nested failure's tag, raw value and depth. */
const shapeOf = (failure: Result.Failure<unknown>) => ({
  error: failure.error,
  nested: failure.causes.filter(isFailure).map(cause => ({
    error: cause.error,
    raw: cause.raw,
    nested: cause.causes.filter(isFailure).length,
  })),
})

describe('rtc rewraps of a rejected platform call', () => {
  it('replaceTrack: rtc.track over the fold of the platform error — two levels', async () => {
    const fake = createFakeRtc()
    const refused = new DOMException('track kind mismatch', 'InvalidModificationError')

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* fake.mock.use()

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      void peerB

      const sender = yield* peerA.addTrack(mic('mic-1'))
      ;(sender.native as FakeSender).replaceTrack = () => Promise.reject(refused)

      const result = yield* attempt(() => sender.replace(mic('mic-2')))

      return isFailure(result) ? { result } : { result: undefined }
    })

    const { result } = unwrap(outcome)

    if (!result) {
      throw new Error('replace succeeded')
    }

    expect(shapeOf(result)).toEqual({
      error: RtcErrors.Track,
      nested: [{ error: ResultErrors.Unknown, raw: refused, nested: 0 }],
    })
    expect(
      formatFailure(result, { chain: true })
        .split('\n')
        .filter(line => !line.startsWith(' ')),
    ).toEqual([
      'std:webrtc.track: replaceTrack failed',
      'Caused by: std:result.unknown: InvalidModificationError: track kind mismatch (13)',
    ])
  })

  it('getStats: rtc.stats over the fold of the platform error — two levels', async () => {
    const fake = createFakeRtc()
    const unavailable = new Error('report unavailable')

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* fake.mock.use()

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      void peerB
      yield* peerA.channel('chat')

      ;(fake.hub.peers[0] as FakePeer).faults.stats = unavailable

      const result = yield* attempt(() => peerA.stats())

      return isFailure(result) ? { result } : { result: undefined }
    })

    const { result } = unwrap(outcome)

    if (!result) {
      throw new Error('stats succeeded')
    }

    expect(shapeOf(result)).toEqual({
      error: RtcErrors.Stats,
      nested: [{ error: ResultErrors.Unknown, raw: unavailable, nested: 0 }],
    })
  })
})
