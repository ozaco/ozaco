import { run } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { createFakeRtc, createSignalPair } from './fake'

describe('perfect negotiation', () => {
  it('offer glare resolves through the polite/impolite roles', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA) // impolite
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      // both sides queue an offer at the same time → glare: the impolite peer ignores the
      // colliding offer, the polite peer rolls back and answers
      yield* peerA.restartIce()
      yield* peerB.restartIce()

      // the surviving exchange must still produce a working link — channels open on both sides
      const chatA = yield* peerA.channel('chat')
      const channelsB = yield* peerB.channels
      const emitted = yield* channelsB.next()

      return {
        chatA: chatA.readyState,
        chatB: emitted.done ? 'closed' : emitted.value.readyState,
        stateA: peerA.connectionState,
        stateB: peerB.connectionState,
        signalingA: peerA.signalingState,
        signalingB: peerB.signalingState,
      }
    })

    expect(unwrap(outcome)).toEqual({
      chatA: 'open',
      chatB: 'open',
      stateA: 'connected',
      stateB: 'connected',
      signalingA: 'stable',
      signalingB: 'stable',
    })
  })

  it('non-rtc frames on a shared signal are ignored', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB, queues] = createSignalPair()
      // noise the peer must skip: a keepalive string, an app frame, junk
      queues.toA.add('ping')
      queues.toA.add({ t: 'app:event', payload: 1 })
      queues.toA.add(42)

      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      const chat = yield* peerA.channel('chat')
      return { chat: chat.readyState, state: peerA.connectionState }
    })

    expect(unwrap(outcome)).toEqual({ chat: 'open', state: 'connected' })
  })
})
