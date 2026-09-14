import { attempt, run, sleep, spawn } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
import type { RtcDef } from 'std:webrtc'
import { Rtc, RtcClient, RtcErrors } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import type { FakePeer } from './fake'
import { createFakeRtc, createSignalPair } from './fake'

/** The tag a failed attempt carries, or a marker when it unexpectedly succeeded. */
const tagOf = (result: unknown) => (isFailure(result) ? String(result.error) : 'succeeded')

describe('failure tags', () => {
  it('a channel that never opens fails RtcErrors.Timeout after openTimeoutMs', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* RtcClient.use({ impl: fake.impl })

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      fake.hub.dead = true // the offer/answer round completes but the peers never link
      const result = yield* attempt(() => peerA.channel('chat', { openTimeoutMs: 20 }))

      return { tag: tagOf(result), state: peerA.connectionState }
    })

    expect(unwrap(outcome)).toEqual({ tag: RtcErrors.Timeout, state: 'new' })
    expect(RtcErrors.Timeout).toBe('std:webrtc.timeout')
  })

  it('the signal flow closing before connected settles the peer with RtcErrors.Signal', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* RtcClient.use({ impl: fake.impl })

      const [signalA, , queues] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)

      queues.toA.close(undefined) // the signaling socket went away mid-negotiation

      const info = yield* peerA.closed
      const channels = yield* peerA.channels
      const end = yield* channels.next()

      return {
        reason: info.reason,
        flowClose: end.done && isFailure(end.value) ? String(end.value.error) : 'unexpected',
      }
    })

    expect(unwrap(outcome)).toEqual({ reason: 'signal', flowClose: RtcErrors.Signal })
  })

  it('a rejected createOffer settles the offerer with RtcErrors.Negotiation', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* RtcClient.use({ impl: fake.impl })

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB
      ;(fake.hub.peers[0] as FakePeer).faults.offer = new Error('createOffer refused')

      // the pending channel dies with its session: its own failure is the channel tag…
      const channel = yield* attempt(() => peerA.channel('chat'))
      // …while the session settles with the negotiation tag
      const info = yield* peerA.closed
      const states = yield* peerA.states
      const end = yield* states.next()

      return {
        channel: tagOf(channel),
        reason: info.reason,
        flowClose: end.done && isFailure(end.value) ? String(end.value.error) : 'unexpected',
        failures: peerA.metrics.failures,
      }
    })

    expect(unwrap(outcome)).toEqual({
      channel: RtcErrors.Channel,
      reason: 'negotiation',
      flowClose: RtcErrors.Negotiation,
      failures: 1,
    })
  })

  it('a rejected createAnswer settles the answerer with RtcErrors.Negotiation', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* RtcClient.use({ impl: fake.impl })

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      ;(fake.hub.peers[1] as FakePeer).faults.answer = new Error('createAnswer refused')

      // A's channel can never open (no answer comes back) — bounded so the test stays short
      const opening = yield* spawn(() =>
        attempt(() => peerA.channel('chat', { openTimeoutMs: 50 })),
      )
      const info = yield* peerB.closed
      const channel = yield* opening

      return { reason: info.reason, channel: tagOf(channel), a: peerA.connectionState }
    })

    expect(unwrap(outcome)).toEqual({
      reason: 'negotiation',
      channel: RtcErrors.Timeout,
      a: 'new',
    })
  })

  it('an implementation whose constructor throws fails connect with RtcErrors.Connect', async () => {
    const Refusing = function () {
      throw new Error('configuration refused')
    } as unknown as RtcDef.ImplLike

    const outcome = await run(function* () {
      yield* RtcClient.use({ impl: Refusing })
      const [signalA] = createSignalPair()
      const result = yield* attempt(() => Rtc.actions.connect(signalA))

      return tagOf(result)
    })

    expect(unwrap(outcome)).toBe(RtcErrors.Connect)
  })

  it('stats() fails RtcErrors.Stats when getStats rejects and when nothing is live', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* RtcClient.use({ impl: fake.impl })

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB
      yield* peerA.channel('chat')

      ;(fake.hub.peers[0] as FakePeer).faults.stats = new Error('report unavailable')
      const rejected = yield* attempt(() => peerA.stats())

      yield* peerA.close() // no live generation anymore
      const dead = yield* attempt(() => peerA.stats())

      return { rejected: tagOf(rejected), dead: tagOf(dead) }
    })

    expect(unwrap(outcome)).toEqual({ rejected: RtcErrors.Stats, dead: RtcErrors.Stats })
  })

  it('channel() fails RtcErrors.Channel when createDataChannel throws', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* RtcClient.use({ impl: fake.impl })

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB
      ;(fake.hub.peers[0] as FakePeer).faults.channel = new Error('too many channels')

      const result = yield* attempt(() => peerA.channel('chat'))

      // the peer itself is unharmed
      return { tag: tagOf(result), ended: peerA.connectionState === 'closed' }
    })

    expect(unwrap(outcome)).toEqual({ tag: RtcErrors.Channel, ended: false })
  })

  it('channel() fails RtcErrors.Channel when the channel closes before it opens', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* RtcClient.use({ impl: fake.impl })

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })
      void peerB

      fake.hub.dead = true // keep the channel in `connecting`
      const opening = yield* spawn(() => attempt(() => peerA.channel('chat', { openTimeoutMs: 0 })))

      // let channel() reach its wait, then kill the native underneath it
      yield* sleep(0)
      const native = (fake.hub.peers[0] as FakePeer).channels[0]
      native?.close()

      const result = yield* opening

      return { tag: tagOf(result), state: peerA.connectionState }
    })

    expect(unwrap(outcome)).toEqual({ tag: RtcErrors.Channel, state: 'new' })
  })
})
