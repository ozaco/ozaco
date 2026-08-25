import { fork, run, sleep, spawn } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import type { FakeChannel } from './fake'
import { createFakeRtc, createSignalPair } from './fake'

describe('channel backpressure', () => {
  it('send parks above the high-water mark and resumes on bufferedamountlow', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      const chatA = yield* peerA.channel('chat', { highWaterMark: 1000, lowWaterMark: 100 })
      const channelsB = yield* peerB.channels
      const emitted = yield* channelsB.next()
      if (emitted.done) {
        return 'closed'
      }
      const chatB = emitted.value

      const received: unknown[] = []
      yield* fork(function* () {
        const messages = yield* chatB.messages
        while (true) {
          const item = yield* messages.next()
          if (item.done) {
            return
          }
          received.push(item.value)
        }
      })

      const native = chatA.native as FakeChannel
      native.bufferedAmount = 5000 // simulate a congested SCTP buffer

      const sendTask = yield* spawn(() => chatA.send('parked frame'))
      yield* sleep(20)
      const deliveredWhileParked = received.length

      native.drain() // buffer emptied → bufferedamountlow fires → the parked send resumes
      yield* sendTask
      yield* sleep(20)

      return {
        deliveredWhileParked,
        threshold: native.bufferedAmountLowThreshold,
        received,
      }
    })

    expect(unwrap(outcome)).toEqual({
      deliveredWhileParked: 0,
      threshold: 100,
      received: ['parked frame'],
    })
  })
})
