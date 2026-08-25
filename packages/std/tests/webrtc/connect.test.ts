import { attempt, run } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { createFakeRtc, createSignalPair } from './fake'

describe('Rtc.actions.connect', () => {
  it('connects two peers, opens a channel, and exchanges frames both ways', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      // A opens the channel — this drives the initial offer/answer over the signal pair
      const chatA = yield* peerA.channel('chat')

      // B receives it (already OPEN) on the channels flow
      const channelsB = yield* peerB.channels
      const emitted = yield* channelsB.next()
      if (emitted.done) {
        return { error: 'channels flow closed early' }
      }
      const chatB = emitted.value

      // structured value: codec-encoded on send, codec-decoded on receive
      yield* chatA.send({ kind: 'greeting', n: 1 })
      // string and binary pass through untouched
      yield* chatB.send('plain text')

      const messagesB = yield* chatB.messages
      const messagesA = yield* chatA.messages
      const structured = yield* messagesB.next()
      const text = yield* messagesA.next()

      return {
        label: chatB.label,
        stateA: peerA.connectionState,
        stateB: peerB.connectionState,
        structured: structured.done ? 'closed' : structured.value,
        text: text.done ? 'closed' : text.value,
        readyState: chatA.readyState,
      }
    })

    expect(unwrap(outcome)).toEqual({
      label: 'chat',
      stateA: 'connected',
      stateB: 'connected',
      structured: { kind: 'greeting', n: 1 },
      text: 'plain text',
      readyState: 'open',
    })
  })

  it('binary frames pass through untouched', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      const dataA = yield* peerA.channel('bin')
      const channelsB = yield* peerB.channels
      const emitted = yield* channelsB.next()
      if (emitted.done) {
        return 'closed'
      }

      yield* dataA.send(new Uint8Array([1, 2, 3]))
      const messagesB = yield* emitted.value.messages
      const received = yield* messagesB.next()
      return received.done ? 'closed' : [...(received.value as Uint8Array)]
    })

    expect(unwrap(outcome)).toEqual([1, 2, 3])
  })

  it('later channels open in-band without another negotiation round', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      yield* peerA.channel('first')
      const second = yield* peerA.channel('second')
      const third = yield* peerB.channel('from-b') // the answerer can open channels too

      return {
        second: second.readyState,
        third: third.readyState,
        // exactly one offer/answer round happened: one local description per peer
        signalingA: peerA.signalingState,
        signalingB: peerB.signalingState,
      }
    })

    expect(unwrap(outcome)).toEqual({
      second: 'open',
      third: 'open',
      signalingA: 'stable',
      signalingB: 'stable',
    })
  })

  it('remote candidates are buffered until the remote description is applied', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      yield* peerA.channel('chat')
      void peerB

      // the fake REJECTS addIceCandidate before setRemoteDescription — reaching connected with
      // delivered candidates on both sides proves the plugin buffered and flushed correctly
      const [a, b] = fake.hub.peers
      return {
        connected: a?.connectionState === 'connected' && b?.connectionState === 'connected',
        aGotCandidates: (a?.candidates.length ?? 0) > 0,
        bGotCandidates: (b?.candidates.length ?? 0) > 0,
      }
    })

    expect(unwrap(outcome)).toEqual({ connected: true, aGotCandidates: true, bGotCandidates: true })
  })

  it('a missing implementation fails with rtc/unsupported', async () => {
    const outcome = await run(function* () {
      yield* install(Rtc)
      yield* rtcImpl.set(false)
      const [signalA] = createSignalPair()
      const result = yield* attempt(() => Rtc.actions.connect(signalA))

      return isFailure(result) ? String(result.error) : 'connected'
    })

    expect(unwrap(outcome)).toBe('rtc/unsupported')
  })

  it('connect without installing the plugin fails with missing-action', async () => {
    const outcome = await run(function* () {
      const [signalA] = createSignalPair()
      const result = yield* attempt(() => Rtc.actions.connect(signalA))

      return isFailure(result) ? String(result.error) : 'connected'
    })

    expect(unwrap(outcome)).toBe('missing-action')
  })
})
