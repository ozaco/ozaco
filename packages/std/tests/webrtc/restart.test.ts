import { run, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import type { FakePeer } from './fake'
import { createFakeRtc, createSignalPair, sever } from './fake'

describe('ICE restart supervision', () => {
  it('a failed connection recovers through a supervised restart', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const budget = { retries: 4, delayMs: 10 }
      const peerA = yield* Rtc.actions.connect(signalA, { iceRestart: budget })
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true, iceRestart: budget })

      const chatA = yield* peerA.channel('chat')

      sever(fake.hub)
      // give the supervisors room: outage → restart offer → relink
      yield* sleep(100)

      return {
        stateA: peerA.connectionState,
        stateB: peerB.connectionState,
        restartsA: peerA.restarts,
        chat: chatA.readyState, // the channel survived the outage
      }
    })

    const value = unwrap(outcome)
    expect(value.stateA).toBe('connected')
    expect(value.stateB).toBe('connected')
    expect(value.restartsA).toBeGreaterThanOrEqual(1)
    expect(value.chat).toBe('open')
  })

  it('an unrecoverable outage exhausts the budget into rtc/ice-exhausted', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA, {
        iceRestart: { retries: 2, delayMs: 5 },
      })
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      const chatA = yield* peerA.channel('chat')
      const messagesA = yield* chatA.messages

      fake.hub.dead = true // restart offers can never relink
      sever(fake.hub, [fake.hub.peers[0] as FakePeer]) // one-sided: only A observes the outage

      const info = yield* peerA.closed
      const end = yield* messagesA.next()

      return {
        reason: info.reason,
        flowClose: end.done && isFailure(end.value) ? String(end.value.error) : 'unexpected',
      }
    })

    expect(unwrap(outcome)).toEqual({ reason: 'ice-exhausted', flowClose: 'rtc/ice-exhausted' })
  })

  it('without an iceRestart budget a failed connection settles with rtc/connection', async () => {
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
      const messagesA = yield* chatA.messages

      fake.hub.dead = true
      sever(fake.hub, [fake.hub.peers[0] as FakePeer])

      const info = yield* peerA.closed
      const end = yield* messagesA.next()

      return {
        reason: info.reason,
        flowClose: end.done && isFailure(end.value) ? String(end.value.error) : 'unexpected',
      }
    })

    expect(unwrap(outcome)).toEqual({ reason: 'failed', flowClose: 'rtc/connection' })
  })

  it('the states flow streams the connection-state transitions', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA, {
        iceRestart: { retries: 4, delayMs: 10 },
      })
      const peerB = yield* Rtc.actions.connect(signalB, {
        polite: true,
        iceRestart: { retries: 4, delayMs: 10 },
      })
      void peerB

      const states = yield* peerA.states
      yield* peerA.channel('chat')
      const first = yield* states.next()

      sever(fake.hub)
      const second = yield* states.next()
      const third = yield* states.next()

      return [first, second, third].map(item => (item.done ? 'closed' : item.value))
    })

    expect(unwrap(outcome)).toEqual(['connected', 'failed', 'connected'])
  })
})
