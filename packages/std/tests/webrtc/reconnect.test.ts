import { fork, run, sleep, spawn } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import type { FakePeer } from './fake'
import { createFakeRtc, createSignalPair, sever } from './fake'

describe('session reconnect (redial)', () => {
  it('a dead connection redials — local handles continue, the remote re-emits fresh ones', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const budget = { retries: 4, delayMs: 10 }
      const peerA = yield* Rtc.actions.connect(signalA, { reconnect: budget })
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true, reconnect: budget })

      const chatA = yield* peerA.channel('chat')
      const channelsB = yield* peerB.channels
      const firstEmit = yield* channelsB.next()
      if (firstEmit.done) {
        return 'channels closed early'
      }
      const chatB1 = firstEmit.value

      // collect A's messages on the ORIGINAL subscription — it must survive the redial
      const received: unknown[] = []
      yield* fork(function* () {
        const messages = yield* chatA.messages
        while (true) {
          const item = yield* messages.next()
          if (item.done) {
            return
          }
          received.push(item.value)
        }
      })

      sever(fake.hub)
      yield* sleep(25) // let the outage process: locals suspend, old remotes end

      // a send during the redial gap parks and flushes once the new generation opens
      const parked = yield* spawn(() => chatA.send('sent during the outage'))

      // B's old remote handle closed cleanly; a FRESH handle re-emits after the redial
      const oldClose = yield* chatB1.closed
      const secondEmit = yield* channelsB.next()
      if (secondEmit.done) {
        return 'channels closed after redial'
      }
      const chatB2 = secondEmit.value
      yield* parked

      const messagesB2 = yield* chatB2.messages
      const parkedArrived = yield* messagesB2.next()

      yield* chatB2.send('welcome back')
      yield* sleep(20)

      return {
        stateA: peerA.connectionState,
        stateB: peerB.connectionState,
        reconnectsA: peerA.reconnects,
        chatA: chatA.readyState,
        oldClose,
        parkedArrived: parkedArrived.done ? 'closed' : parkedArrived.value,
        received,
      }
    })

    const value = unwrap(outcome)
    expect(value).toEqual({
      stateA: 'connected',
      stateB: 'connected',
      reconnectsA: 1,
      chatA: 'open',
      oldClose: true,
      parkedArrived: 'sent during the outage',
      received: ['welcome back'],
    })
  })

  it('an unrecoverable outage exhausts the budget into rtc/reconnect-exhausted', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA, {
        reconnect: { retries: 2, delayMs: 5 },
      })
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      const chatA = yield* peerA.channel('chat')
      const messagesA = yield* chatA.messages

      fake.hub.dead = true // redialed generations can never relink
      sever(fake.hub, [fake.hub.peers[0] as FakePeer])

      const info = yield* peerA.closed
      const end = yield* messagesA.next()

      return {
        reason: info.reason,
        flowClose: end.done && isFailure(end.value) ? String(end.value.error) : 'unexpected',
      }
    })

    expect(unwrap(outcome)).toEqual({
      reason: 'reconnect-exhausted',
      flowClose: 'rtc/reconnect-exhausted',
    })
  })

  it('a remote bye is a deliberate hang-up — never redialed', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const budget = { retries: 5, delayMs: 5 }
      const peerA = yield* Rtc.actions.connect(signalA, { reconnect: budget })
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true, reconnect: budget })

      const chatA = yield* peerA.channel('chat')
      yield* peerB.close()

      const info = yield* peerA.closed
      const messagesA = yield* chatA.messages
      const end = yield* messagesA.next()

      return {
        reason: info.reason,
        reconnects: peerA.reconnects,
        end: end.done ? end.value : 'still open',
      }
    })

    expect(unwrap(outcome)).toEqual({ reason: 'bye', reconnects: 0, end: true })
  })
})
