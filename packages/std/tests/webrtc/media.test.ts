import { attempt, run, scoped, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { RtcDef } from 'std:webrtc'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import type { FakePeer, FakeSender } from './fake'
import { createFakeRtc, createSignalPair, sever } from './fake'

const mic = (id: string): RtcDef.TrackLike => ({ id, kind: 'audio' })

describe('typed media surface', () => {
  it('addTrack drives negotiation on its own — the remote tracks flow announces it', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      // a media-only session: NO data channel anywhere — the track kick must negotiate
      const sender = yield* peerA.addTrack(mic('mic-1'), { id: 'stream-1' })

      const tracksB = yield* peerB.tracks
      const announced = yield* tracksB.next()

      return {
        stateA: peerA.connectionState,
        stateB: peerB.connectionState,
        senderLive: sender.native !== undefined,
        senderTrack: sender.track?.id,
        announced: announced.done
          ? 'closed'
          : {
              track: announced.value.track.id,
              kind: announced.value.track.kind,
              streams: announced.value.streams.map(stream => stream.id),
            },
      }
    })

    expect(unwrap(outcome)).toEqual({
      stateA: 'connected',
      stateB: 'connected',
      senderLive: true,
      senderTrack: 'mic-1',
      announced: { track: 'mic-1', kind: 'audio', streams: ['stream-1'] },
    })
  })

  it('replace swaps the outgoing track in place; null mutes', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      const sender = yield* peerA.addTrack(mic('mic-1'))
      yield* sender.replace(mic('mic-2'))
      const swapped = (sender.native as FakeSender).track?.id

      yield* sender.replace(null)
      const muted = (sender.native as FakeSender).track

      return { swapped, muted, handleTrack: sender.track }
    })

    expect(unwrap(outcome)).toEqual({ swapped: 'mic-2', muted: null, handleTrack: null })
  })

  it('remove stops the sender for good; scope teardown removes too', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      const explicit = yield* peerA.addTrack(mic('mic-1'))
      yield* explicit.remove()
      const afterRemove = yield* attempt(() => explicit.replace(mic('mic-2')))

      // a sender opened in a nested scope is removed when that scope closes
      yield* scoped(function* () {
        yield* peerA.addTrack(mic('mic-3'))
      })

      const native = fake.hub.peers[0] as FakePeer
      return {
        removeFlags: native.senders.map(sender => sender.removed),
        replaceAfterRemove: isFailure(afterRemove) ? String(afterRemove.error) : 'worked',
      }
    })

    expect(unwrap(outcome)).toEqual({
      removeFlags: [true, true],
      replaceAfterRemove: 'rtc/track',
    })
  })

  it('an implementation without a media surface fails rtc/unsupported', async () => {
    const fake = createFakeRtc({ media: false })

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      const result = yield* attempt(() => peerA.addTrack(mic('mic-1')))
      return isFailure(result) ? String(result.error) : 'added'
    })

    expect(unwrap(outcome)).toBe('rtc/unsupported')
  })

  it('a session redial re-adds live tracks — the remote re-announces them', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const budget = { retries: 4, delayMs: 10 }
      const peerA = yield* Rtc.actions.connect(signalA, { reconnect: budget })
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true, reconnect: budget })

      const sender = yield* peerA.addTrack(mic('mic-1'), { id: 'stream-1' })
      const tracksB = yield* peerB.tracks
      const first = yield* tracksB.next()

      sever(fake.hub)

      const second = yield* tracksB.next() // the redialed generation re-announces
      yield* sleep(30) // let the reconnect supervisor's grace window confirm the recovery

      return {
        first: first.done ? 'closed' : first.value.track.id,
        second: second.done ? 'closed' : second.value.track.id,
        reconnects: peerA.reconnects,
        senderLive: sender.native !== undefined,
        state: peerA.connectionState,
      }
    })

    expect(unwrap(outcome)).toEqual({
      first: 'mic-1',
      second: 'mic-1',
      reconnects: 1,
      senderLive: true,
      state: 'connected',
    })
  })
})
