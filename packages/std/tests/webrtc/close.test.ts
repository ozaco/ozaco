import { run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { RtcDef } from 'std:webrtc'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { createFakeRtc, createSignalPair } from './fake'

describe('close semantics', () => {
  it('client close() settles this peer as "client" and the remote as "bye"', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      const chatA = yield* peerA.channel('chat')
      const channelsB = yield* peerB.channels
      const emitted = yield* channelsB.next()
      const chatB = emitted.done ? undefined : emitted.value

      yield* peerA.close()

      const infoA = yield* peerA.closed
      const infoB = yield* peerB.closed // resolved by the rtc:bye frame

      // both channels' flows ended cleanly
      const messagesA = yield* chatA.messages
      const messagesB = yield* (chatB as RtcDef.Channel).messages
      const endA = yield* messagesA.next()
      const endB = yield* messagesB.next()

      return {
        reasonA: infoA.reason,
        reasonB: infoB.reason,
        endA: endA.done ? endA.value : 'still open',
        endB: endB.done ? endB.value : 'still open',
      }
    })

    expect(unwrap(outcome)).toEqual({ reasonA: 'client', reasonB: 'bye', endA: true, endB: true })
  })

  it('scope teardown closes the peer like a clean client close', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      let escaped: RtcDef.Peer | undefined
      yield* scoped(function* () {
        const peerA = yield* Rtc.actions.connect(signalA)
        yield* peerA.channel('chat')
        escaped = peerA
      })

      const infoA = yield* (escaped as RtcDef.Peer).closed
      const infoB = yield* peerB.closed

      return { reasonA: infoA.reason, reasonB: infoB.reason }
    })

    expect(unwrap(outcome)).toEqual({ reasonA: 'scope closed', reasonB: 'bye' })
  })

  it('closing one channel ends its flow but leaves the peer connected', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      const chatA = yield* peerA.channel('chat')
      const sideA = yield* peerA.channel('side')

      yield* chatA.close()
      const closedValue = yield* chatA.closed
      const messagesA = yield* chatA.messages
      const end = yield* messagesA.next()

      return {
        closedValue,
        flowEnded: end.done,
        chatState: chatA.readyState,
        sideState: sideA.readyState,
        peerState: peerA.connectionState,
      }
    })

    expect(unwrap(outcome)).toEqual({
      closedValue: true,
      flowEnded: true,
      chatState: 'closed',
      sideState: 'open',
      peerState: 'connected',
    })
  })
})
