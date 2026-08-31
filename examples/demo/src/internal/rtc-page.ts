/// <reference lib="dom" />
/**
 * The BROWSER side of the demo video call — bundled by the `rtc.page` action and served at
 * `GET /rtc`. It drives `std:ws` + `std:webrtc` exactly the way server code does, and it lets the
 * RELAY own the session lifecycle: join `/rtc/:room`, sit in `rtc:waiting` until the relay pairs
 * this tab with another one, then run ONE peer session per `rtc:role` epoch. A partner that
 * leaves, refreshes, or dies (remote `rtc:bye`, exhausted redials) ends that session; the next
 * `rtc:role` starts a clean one — no half-dead peer is ever carried into a new pairing. Open the
 * same URL (same `#room`) in a second tab for the other end of the call.
 *
 * It also REPORTS itself: `peer.metrics` + the `peer.events` collected since the last report go
 * back over the signaling socket every few seconds (and once more when a session ends), where
 * the `rtc.report` action turns them into observe rows, spans and an `rtc.metrics` event — so a
 * browser-to-browser call is visible in the server console at `/_observe` and in any
 * OpenObserve exporter that is installed.
 */
import type { Queue } from 'std:effect'
import { attempt, createQueue, fork, race, run, sleep, until } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { RtcDef } from 'std:webrtc'
import { Rtc } from 'std:webrtc'
import { Ws } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'

import type { Control, Session } from '../types/internal'

const pick = (selector: string) => document.querySelector(selector) as AnyType

const status = (text: string) => {
  pick('#status').textContent = text
}

const say = (from: 'you' | 'them', text: string) => {
  const line = document.createElement('li')
  line.dataset['from'] = from
  line.textContent = `${from === 'you' ? '▸' : '◂'} ${text}`
  pick('#log').append(line)
  pick('#log').scrollTop = 1e9
}

// DOM events are synchronous — they drop outgoing lines here and an effect pump sends them
const outgoing = createQueue<string, void>()

/** How often a live session reports its metrics (and samples `getStats`). */
const REPORT_MS = 5000

/** The one-line summary under the videos: the numbers that tell you how the call is doing. */
const showMetrics = (metrics: RtcDef.Metrics, sample?: RtcDef.Event['data']) => {
  const parts = [
    metrics.state,
    `conn ${metrics.connectedMs ?? '—'}ms`,
    `gen ${metrics.generations}`,
    `neg ${metrics.negotiations}`,
    `glare ${metrics.glare}`,
    `ice ${metrics.restarts}`,
    `redial ${metrics.reconnects}`,
    `msg ${metrics.messagesSent}/${metrics.messagesReceived}`,
    `fail ${metrics.failures}`,
    ...(sample?.['rttMs'] === undefined ? [] : [`rtt ${String(sample['rttMs'])}ms`]),
    ...(sample?.['route'] === undefined ? [] : [`via ${String(sample['route'])}`]),
    ...(sample?.['framesDecoded'] === undefined
      ? []
      : [`frames ${String(sample['framesDecoded'])}`]),
  ]
  pick('#metrics').textContent = `metrics: ${parts.join(' · ')}`
}

const tag = (frame: AnyType) =>
  frame?.t === 'rtc:description'
    ? String(frame.description?.type)
    : frame?.t === 'rtc:candidate'
      ? `cand${frame.candidate ? '' : ':null'}`
      : String(frame?.t ?? typeof frame)

const outcome = run(function* () {
  yield* install(JsonCodec)
  yield* install(Ws)
  yield* install(Rtc)

  const room = location.hash.slice(1) || 'demo'
  pick('#room').textContent = `#${room}`
  status('joining the room…')

  // a failing session can be read straight off __debug (the signal is instrumented below)
  const debug = {
    epoch: 0,
    sessions: 0,
    inboundChannels: 0,
    inboundMessages: 0,
    sent: 0,
    sendErrors: 0,
    sigIn: [] as unknown[],
    sigOut: [] as unknown[],
  }
  ;(globalThis as AnyType).__debug = debug

  const base = location.origin.replace(/^http/u, 'ws')
  const socket = yield* Ws.actions.connect(`${base}/rtc/${room}`, { reconnect: {} })

  // camera + microphone ONCE: every session re-adds these same tracks (a denied permission
  // degrades to a data-only call)
  const media = yield* until(
    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => undefined),
  )
  if (media) {
    pick('#local').srcObject = media
  } else {
    status('no camera/mic permission — data-only call')
  }

  /** ONE pairing: a fresh peer over the shared socket, torn down when the session ends. */
  const call = function* (polite: boolean, epoch: number, inbound: Queue<unknown, void>) {
    // the signal is per-epoch: outgoing frames are STAMPED and the control loop only feeds back
    // frames carrying the same stamp, so a previous session's `rtc:bye` cannot kill this one
    const signal: RtcDef.SignalLike = {
      send: (data: unknown) => {
        debug.sigOut.push(tag(data))
        return socket.send({ ...(data as object), epoch })
      },
      messages: {
        *[Symbol.iterator]() {
          return inbound
        },
      } as AnyType,
    }

    const peer = yield* Rtc.actions.connect(signal, {
      polite,
      iceRestart: {},
      // a call survives a longer blip than the library default before the relay re-pairs us
      reconnect: { retries: 6, delayMs: 500, backoff: 1.5, maxDelayMs: 4000 },
      // sample getStats on the report cadence: every tick lands in the timeline (and therefore
      // in the next report) as a `stats` entry
      observe: { sampleMs: REPORT_MS, timeline: 256 },
    })
    ;(globalThis as AnyType).__peer = peer // debug escape hatch (headless verification pokes it)
    status(`negotiating as the ${polite ? 'polite' : 'impolite'} peer…`)

    // the peer's own trace: buffered here and shipped to the server on every report (the flow is
    // lossy by design, so a reader must hold what it wants to keep)
    const pending: RtcDef.Event[] = []
    let sample: RtcDef.Event['data']
    yield* fork(function* () {
      const events = yield* peer.events
      for (;;) {
        const step = yield* events.next()
        if (step.done) {
          return
        }
        pending.push(step.value)
        if (pending.length > 256) {
          pending.shift() // a report will never carry more than the action accepts
        }
        if (step.value.kind === 'stats') {
          sample = step.value.data
          showMetrics(peer.metrics, sample)
        }
      }
    })

    const report = function* (final: boolean) {
      const timeline = pending.splice(0, 128)
      yield* attempt(() =>
        socket.send({
          t: 'rtc:report',
          epoch,
          report: { role: polite ? 'polite' : 'impolite', final, metrics: peer.metrics, timeline },
        }),
      )
      showMetrics(peer.metrics, sample)
    }

    yield* fork(function* () {
      for (;;) {
        yield* sleep(REPORT_MS)
        yield* report(false)
      }
    })

    // connection-state transitions → the status line
    let connected = false
    yield* fork(function* () {
      const states = yield* peer.states
      for (;;) {
        const step = yield* states.next()
        if (step.done) {
          return
        }
        connected ||= step.value === 'connected'
        status(String(step.value))
      }
    })

    // whatever the remote announces → the remote <video>. A FRESH stream per session: the
    // previous pairing's tracks are dead the moment its peer settles.
    let sawRemoteTrack = () => {}
    const remoteTrackArrived = new Promise<void>(resolve => {
      sawRemoteTrack = resolve
    })
    yield* fork(function* () {
      const remote = new MediaStream()
      const video = pick('#remote')
      const tracks = yield* peer.tracks
      for (;;) {
        const step = yield* tracks.next()
        if (step.done) {
          return
        }
        remote.addTrack(step.value.track as AnyType)
        sawRemoteTrack()
        // force a FRESH load on every arrival: re-assigning the same stream object is a no-op,
        // and a load that settled as audio-only would otherwise never pick the video track up
        video.srcObject = null
        video.srcObject = remote
        void video.play?.()?.catch?.(() => undefined)
      }
    })

    // chat over data channels — plain text frames. Each side SENDS on its own channel and reads
    // everything the remote announces (inbound never arrives on our own channel).
    let sawInboundChannel = () => {}
    const inboundChannelArrived = new Promise<void>(resolve => {
      sawInboundChannel = resolve
    })
    yield* fork(function* () {
      const channels = yield* peer.channels
      for (;;) {
        const step = yield* channels.next()
        if (step.done) {
          return
        }
        const remoteChannel = step.value
        debug.inboundChannels += 1
        sawInboundChannel()
        yield* fork(function* () {
          const messages = yield* remoteChannel.messages
          for (;;) {
            const item = yield* messages.next()
            if (item.done) {
              return
            }
            debug.inboundMessages += 1
            say('them', String(item.value))
          }
        })
      }
    })

    // NO simultaneous offers, ever: the impolite side's first channel drives the ONLY initial
    // offer; the polite side opens its channel after the impolite one arrives (in-band by then —
    // no renegotiation). Symmetric first offers make browsers roll one back, and a rolled-back
    // Chromium session stops trickling ICE candidates for good.
    if (polite) {
      yield* race([until(inboundChannelArrived), sleep(8000)])
    }
    const chat = yield* peer.channel('chat', { openTimeoutMs: 15_000 })
    yield* fork(function* () {
      for (;;) {
        const step = yield* outgoing.next()
        if (step.done) {
          return
        }
        const sent = yield* attempt(() => chat.send(step.value))
        if (isFailure(sent)) {
          debug.sendErrors += 1
        } else {
          debug.sent += 1
        }
      }
    })

    // camera + microphone → the peer
    if (media) {
      if (polite) {
        // stagger the two media renegotiations: the polite side waits for the impolite side's
        // tracks (or a short grace) before adding its own, so the offers never glare — a rolled
        // back offer can orphan its senders in some browsers
        yield* race([until(remoteTrackArrived), sleep(2500)])
      }
      for (const track of media.getTracks()) {
        yield* peer.addTrack(track as AnyType, media as AnyType)
      }
    }

    const info = yield* peer.closed // bye, a dead signal, or exhausted redials end the session
    yield* report(true) // the last word on this session, timeline and all
    return { connected, reason: String(info.reason) }
  }

  let current: Session | undefined
  /** consecutive sessions that never reached `connected` — stops a hopeless re-pair loop */
  let failures = 0

  /** End the running session (its peer teardown says `rtc:bye` on the way out). */
  const stop = function* () {
    const session = current
    if (!session) {
      return
    }
    current = undefined
    pick('#remote').srcObject = null
    yield* session.task.halt()
  }

  /** Start the session the relay just announced; when it dies, ask the relay to re-pair us. */
  const start = function* (polite: boolean, epoch: number) {
    yield* stop()
    debug.epoch = epoch
    debug.sessions += 1
    const inbound = createQueue<unknown, void>()
    const task = yield* fork(function* () {
      const result = yield* attempt(() => call(polite, epoch, inbound))
      if (isFailure(result)) {
        ;(globalThis as AnyType).__failure = result
        status(`session failed: ${String((result as AnyType).error ?? 'failed')}`)
      }
      failures = !isFailure(result) && result.value.connected ? 0 : failures + 1
      if (failures > 6) {
        status('gave up re-pairing — reload the page')
        return
      }
      // the partner may still be sitting in the room: the relay bumps the epoch once and hands
      // BOTH sides a fresh role, which restarts this loop with a clean peer on either end
      yield* sleep(Math.min(300 * failures, 3000))
      yield* attempt(() => socket.send({ t: 'rtc:restart', epoch }))
    })
    current = { epoch, inbound, task }
  }

  // Control loop: the relay drives the session, everything else is signaling for the current
  // pairing. Frames stamped with an older epoch belong to a session that is already gone.
  const frames = yield* socket.messages
  for (;;) {
    const step = yield* frames.next()
    if (step.done) {
      yield* stop()
      status('signaling closed — reload the page')
      return
    }
    const frame = (step.value ?? {}) as Control
    if (frame.t === 'rtc:room-full') {
      yield* stop()
      status('room is full — change the #room in the URL and reload')
      return
    }
    if (frame.t === 'rtc:role') {
      yield* start(frame.polite === true, Number(frame.epoch ?? 0))
      continue
    }
    if (frame.t === 'rtc:waiting') {
      yield* stop()
      status('waiting for someone to join this room…')
      continue
    }
    if (frame.t === 'rtc:peer-left') {
      yield* stop()
      status('the other side left — waiting for them to come back…')
      continue
    }
    if (current && frame.epoch === current.epoch) {
      debug.sigIn.push(tag(frame))
      current.inbound.add(frame)
    }
  }
})

pick('#form').addEventListener('submit', (event: AnyType) => {
  event.preventDefault()
  const box = pick('#box')
  const text = String(box.value ?? '').trim()
  if (!text) {
    return
  }
  box.value = ''
  say('you', text)
  outgoing.add(text)
})

// the page lives until the room says otherwise (full, or the signaling socket gave up)
const result = await outcome
if (isFailure(result)) {
  ;(globalThis as AnyType).__failure = result
  status(`error: ${String((result as AnyType).error ?? 'failed')}`)
}
