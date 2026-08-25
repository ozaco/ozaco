import { attempt, fork, run, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { RtcDef } from 'std:webrtc'
import { Rtc, rtcImpl } from 'std:webrtc'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { createFakeRtc, createSignalPair, sever } from './fake'

/** The kinds a timeline recorded, in order, deduplicated for readable assertions. */
const kindsOf = (timeline: readonly RtcDef.Event[]) => [...new Set(timeline.map(item => item.kind))]

const detailsOf = (timeline: readonly RtcDef.Event[], kind: RtcDef.EventKind) =>
  timeline.filter(item => item.kind === kind).map(item => item.detail)

describe('peer observability', () => {
  it('counts both halves of a session and records what happened', async () => {
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

      yield* chatA.send('one')
      yield* chatA.send('two')
      const messagesB = yield* chatB!.messages
      yield* messagesB.next()
      yield* messagesB.next()

      return { a: peerA.metrics, b: peerB.metrics, timeline: peerA.timeline, id: peerA.id }
    })

    const { a, b, timeline, id } = unwrap(outcome)

    // the offerer's half
    expect(a.generations).toBe(1)
    expect(a.state).toBe('connected')
    expect(a.offersSent).toBe(1)
    expect(a.answersReceived).toBe(1)
    expect(a.negotiations).toBe(1)
    expect(a.candidatesSent).toBeGreaterThan(0)
    expect(a.candidatesReceived).toBeGreaterThan(0)
    expect(a.channelsOpened).toBe(1)
    expect(a.messagesSent).toBe(2)
    expect(a.bytesSent).toBe(6) // 'one' + 'two'
    expect(a.failures).toBe(0)
    expect(a.connectedMs).toBeGreaterThanOrEqual(0)
    expect(id).toBe(a.id)
    expect(a.id.startsWith('rtc_')).toBe(true)

    // the answerer's half is the mirror image
    expect(b.offersReceived).toBe(1)
    expect(b.answersSent).toBe(1)
    expect(b.channelsAccepted).toBe(1)
    expect(b.messagesReceived).toBe(2)
    expect(b.bytesReceived).toBe(6)

    // …and the timeline says how it got there
    expect(kindsOf(timeline)).toEqual(
      expect.arrayContaining(['dial', 'offer', 'answer', 'candidate', 'state', 'channel']),
    )
    expect(detailsOf(timeline, 'channel')).toEqual(['out:chat'])
    expect(detailsOf(timeline, 'state')).toContain('connected')
    const answer = timeline.find(item => item.kind === 'answer')
    expect(answer?.detail).toBe('in')
  })

  it('streams the same entries live on peer.events and bounds the timeline', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      // keep only the last 3 entries — the flow still sees every one of them
      const peerA = yield* Rtc.actions.connect(signalA, { observe: { timeline: 3 } })
      yield* Rtc.actions.connect(signalB, { polite: true })

      const seen: RtcDef.Event[] = []
      yield* fork(function* () {
        const events = yield* peerA.events
        for (;;) {
          const step = yield* events.next()
          if (step.done) {
            return
          }
          seen.push(step.value)
        }
      })

      yield* peerA.channel('chat')
      yield* sleep(10)

      return { seen: kindsOf(seen), kept: peerA.timeline.length, last: peerA.timeline.at(-1)?.kind }
    })

    const { seen, kept, last } = unwrap(outcome)
    expect(seen).toEqual(expect.arrayContaining(['offer', 'answer', 'state', 'channel']))
    expect(kept).toBe(3)
    expect(last).toBe('channel')
  })

  it('normalizes the implementation stats report', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      yield* Rtc.actions.connect(signalB, { polite: true })

      const chat = yield* peerA.channel('chat')
      yield* chat.send('hello')

      return yield* peerA.stats()
    })

    const stats = unwrap(outcome)
    expect(stats.state).toBe('connected')
    expect(stats.pair).toEqual({
      local: 'host',
      remote: 'srflx',
      rttMs: 12,
      outgoingBitrate: 300_000,
      bytesSent: 5,
      bytesReceived: 1024,
    })
    expect(stats.inbound).toEqual([
      {
        kind: 'video',
        bytes: 2048,
        packets: 20,
        packetsLost: 1,
        jitterMs: 4,
        frames: 42,
        fps: 24,
        width: 640,
        height: 480,
      },
    ])
    expect(stats.outbound[0]).toEqual({ kind: 'video', bytes: 4096, packets: 30, frames: 60 })
    // the EXACT wire volume, next to the peer's own approximation
    expect(stats.channels).toEqual([
      {
        label: 'chat',
        state: 'open',
        messagesSent: 1,
        bytesSent: 5,
        messagesReceived: 0,
        bytesReceived: 0,
      },
    ])
  })

  it('fails rtc/unsupported when the implementation reports no stats', async () => {
    const fake = createFakeRtc({ stats: false })

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      yield* Rtc.actions.connect(signalB, { polite: true })
      yield* peerA.channel('chat')

      const result = yield* attempt(() => peerA.stats())
      // a Result RETURNED from a run body collapses into the run's own outcome — fold it here
      return { tag: isFailure(result) ? String(result.error) : 'ok' }
    })

    expect(unwrap(outcome)).toEqual({ tag: 'rtc/unsupported' })
  })

  it('samples stats into the timeline when observe.sampleMs is set', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA, { observe: { sampleMs: 15 } })
      yield* Rtc.actions.connect(signalB, { polite: true })
      yield* peerA.channel('chat')
      yield* sleep(50)

      return peerA.timeline.filter(item => item.kind === 'stats')
    })

    const samples = unwrap(outcome)
    expect(samples.length).toBeGreaterThan(0)
    expect(samples[0]?.data).toEqual(
      expect.objectContaining({ state: 'connected', rttMs: 12, route: 'host/srflx' }),
    )
  })

  it('keeps counting across a redial and records the supervisors', async () => {
    const fake = createFakeRtc()

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)
      yield* rtcImpl.set(fake.Ctor)

      const [signalA, signalB] = createSignalPair()
      const budget = { retries: 4, delayMs: 10 } // both sides redial on the same clock
      const peerA = yield* Rtc.actions.connect(signalA, { reconnect: budget })
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true, reconnect: budget })
      yield* peerA.channel('chat')
      void peerB

      sever(fake.hub)
      yield* sleep(120)

      return { metrics: peerA.metrics, timeline: peerA.timeline }
    })

    const { metrics, timeline } = unwrap(outcome)
    // one dial per ATTEMPT (the fake relinks only once both sides have redialed), one recovery
    expect(metrics.generations).toBeGreaterThanOrEqual(2)
    expect(metrics.reconnects).toBe(1)
    expect(metrics.failures).toBeGreaterThan(0)
    expect(detailsOf(timeline, 'redial')).toEqual(
      expect.arrayContaining(['attempt 1', 'recovered']),
    )
    expect(timeline.filter(item => item.kind === 'dial').length).toBe(metrics.generations)
    expect(timeline.filter(item => item.generation > 1).length).toBeGreaterThan(0)
  })
})
