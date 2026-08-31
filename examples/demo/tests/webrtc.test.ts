import { createQueue, fork, run, scoped, sleep, until } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { RtcDef } from 'std:webrtc'
import { Rtc } from 'std:webrtc'
import type { WsDef } from 'std:ws'
import { Ws } from 'std:ws'

import { afterAll, describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'
import { createLink } from 'transport:impl/memory'

import type { DemoOptions } from '../src'
import { createDemo } from '../src'

// Real WebRTC through the demo's `/rtc/:room` signaling relay: two peers join the room over
// plain websockets, take the role the relay assigns, and negotiate an actual loopback
// connection via the auto-imported node-datachannel polyfill. Skips when the native module is
// unavailable; variable specifiers keep tsc away from its DOM-conflicting type declarations.
const polyfillSpecifier = 'node-datachannel/polyfill'
const polyfill = await import(polyfillSpecifier).catch(() => undefined)

interface RelayFrame {
  t?: string
  polite?: boolean
  epoch?: number
}

/** Pull frames until the relay PAIRS this socket and hands it a role (a lone joiner waits). */
const roleOf = function* (socket: WsDef.Connection) {
  const messages = yield* socket.messages
  for (;;) {
    const step = yield* messages.next()
    if (step.done) {
      return { t: 'closed' } as RelayFrame
    }
    const frame = (step.value ?? {}) as RelayFrame
    if (frame.t === 'rtc:role') {
      return frame
    }
  }
}

afterAll(async () => {
  if (polyfill) {
    // libdatachannel keeps worker threads alive — without this the test process never exits
    const nativeSpecifier = 'node-datachannel'
    const native = (await import(nativeSpecifier)) as { cleanup?: () => void }
    native.cleanup?.()
  }
})

describe.skipIf(!polyfill)('webrtc over the demo signaling relay', () => {
  it('two peers meet in /rtc/:room and talk over a real data channel', async () => {
    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)
        yield* install(Rtc)

        const app = yield* createDemo({ instance: 'rtc' })
        const info = yield* app.start()
        const base = (info.url as string).replace('http', 'ws')

        // roles are handed out when the PAIRING forms — nobody negotiates into an empty room
        const socketA = yield* Ws.actions.connect(`${base}/rtc/e2e`)
        const socketB = yield* Ws.actions.connect(`${base}/rtc/e2e`)
        const roleA = yield* roleOf(socketA)
        const roleB = yield* roleOf(socketB)
        // roles are DERIVED from the member ids (so every node computes the same ones) — which
        // side ends up polite is not fixed, that they are OPPOSITE is
        expect(roleA.polite).toBe(!roleB.polite)
        expect(roleA.epoch).toBe(roleB.epoch)

        const peerA = yield* Rtc.actions.connect(socketA, { polite: roleA.polite === true })
        const peerB = yield* Rtc.actions.connect(socketB, { polite: roleB.polite === true })

        const callA = yield* peerA.channel('call', { openTimeoutMs: 15_000 })
        const channelsB = yield* peerB.channels
        const emitted = yield* channelsB.next()
        expect(emitted.done).toBe(false)
        const callB = (emitted as { value: RtcDef.Channel }).value

        yield* callA.send({ hello: 'from a' })
        yield* callB.send('hi back')

        const messagesB = yield* callB.messages
        const messagesA = yield* callA.messages
        const structured = yield* messagesB.next()
        const text = yield* messagesA.next()
        expect(structured.done ? 'closed' : structured.value).toEqual({ hello: 'from a' })
        expect(text.done ? 'closed' : text.value).toBe('hi back')

        yield* peerA.close()
        yield* peerB.close()
        yield* app.stop()
      }),
    )
  }, 30_000)

  it('the relay drives the session: waiting, opposite roles, peer-left, re-pair', async () => {
    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const app = yield* createDemo({ instance: 'rtc-relay' })
        const info = yield* app.start()
        const base = (info.url as string).replace('http', 'ws')

        const caller = yield* Ws.actions.connect(`${base}/rtc/relay`)
        const callerFrames = yield* caller.messages
        const waiting = yield* callerFrames.next()
        expect(waiting.done ? undefined : waiting.value).toEqual({
          t: 'rtc:waiting',
          room: 'relay',
        })

        // the pairing tells BOTH sides, with OPPOSITE roles
        const callee = yield* Ws.actions.connect(`${base}/rtc/relay`)
        const calleeFrames = yield* callee.messages
        const calleeRole = (yield* calleeFrames.next()).value as RelayFrame
        const callerRole = (yield* callerFrames.next()).value as RelayFrame
        expect(callerRole.t).toBe('rtc:role')
        expect(callerRole.epoch).toBe(1)
        expect(calleeRole.epoch).toBe(1)
        expect(callerRole.polite).toBe(!calleeRole.polite)

        // the partner leaves: the survivor is told to end its session
        yield* callee.close()
        const left = yield* callerFrames.next()
        expect(left.done ? undefined : left.value).toEqual({
          t: 'rtc:peer-left',
          room: 'relay',
          epoch: 1,
        })

        // …and the next tab re-pairs at a FRESH epoch with opposite roles. Plain join order
        // would hand the newcomer the same role as the peer that stayed, and a polite/polite
        // pair deadlocks on offer glare (no remote video).
        const rejoin = yield* Ws.actions.connect(`${base}/rtc/relay`)
        const rejoinFrames = yield* rejoin.messages
        const rejoinRole = (yield* rejoinFrames.next()).value as RelayFrame
        const survivorRole = (yield* callerFrames.next()).value as RelayFrame
        expect(survivorRole.epoch).toBe(2)
        expect(rejoinRole.epoch).toBe(2)
        expect(survivorRole.polite).toBe(!rejoinRole.polite)

        // a dead session asks for a re-pair — honored ONCE per epoch, so both sides asking still
        // produces a single new pairing
        yield* caller.send({ t: 'rtc:restart', epoch: 2 })
        yield* sleep(30)
        yield* rejoin.send({ t: 'rtc:restart', epoch: 2 })
        const repaired = (yield* callerFrames.next()).value as RelayFrame
        const repairedPartner = (yield* rejoinFrames.next()).value as RelayFrame
        expect(repaired.epoch).toBe(3)
        expect(repairedPartner.epoch).toBe(3)
        expect(repaired.polite).toBe(!repairedPartner.polite)

        // everything else is relayed verbatim (the stale second restart produced no frame)
        yield* caller.send({
          t: 'rtc:description',
          description: { type: 'offer', sdp: 'x' },
          epoch: 3,
        })
        const relayed = yield* rejoinFrames.next()
        expect(relayed.done ? undefined : relayed.value).toEqual({
          t: 'rtc:description',
          description: { type: 'offer', sdp: 'x' },
          epoch: 3,
        })

        yield* app.stop()
      }),
    )
  }, 30_000)

  it('pairs two peers that landed on DIFFERENT edge nodes', async () => {
    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        // two nodes, one carrier: a socket is driven by the edge that accepted it, so this is
        // what a real cluster does the moment the two tabs hit different nodes
        const link = createLink()
        const first = yield* createDemo({ instance: 'edge-a', link })
        const second = yield* createDemo({ instance: 'edge-b', link })
        const urlA = ((yield* first.start()).url as string).replace('http', 'ws')
        const urlB = ((yield* second.start()).url as string).replace('http', 'ws')

        const a = yield* Ws.actions.connect(`${urlA}/rtc/split`)
        const framesA = yield* a.messages
        const waiting = (yield* framesA.next()).value as RelayFrame
        expect(waiting.t).toBe('rtc:waiting')

        const b = yield* Ws.actions.connect(`${urlB}/rtc/split`)
        const framesB = yield* b.messages
        const roleB = (yield* framesB.next()).value as RelayFrame
        const roleA = (yield* framesA.next()).value as RelayFrame
        expect(roleA.t).toBe('rtc:role')
        expect(roleB.t).toBe('rtc:role')
        expect(roleA.epoch).toBe(roleB.epoch)
        expect(roleA.polite).toBe(!roleB.polite)

        // signaling crosses the carrier verbatim
        yield* a.send({ t: 'rtc:description', description: { type: 'offer', sdp: 'x' }, epoch: 1 })
        const relayed = yield* framesB.next()
        expect(relayed.done ? undefined : relayed.value).toEqual({
          t: 'rtc:description',
          description: { type: 'offer', sdp: 'x' },
          epoch: 1,
        })

        // …and so does a departure: the survivor on the OTHER node ends its session
        yield* b.close()
        const left = (yield* framesA.next()).value as RelayFrame
        expect(left.t).toBe('rtc:peer-left')

        yield* first.stop()
        yield* second.stop()
      }),
    )
  }, 30_000)

  it('cluster: a caller waiting alone still connects when the callee joins late', async () => {
    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)
        yield* install(Rtc)

        const link = createLink()
        const ready = createQueue<void, void>()
        const node = (options: DemoOptions) =>
          fork(() =>
            scoped(function* () {
              const app = yield* createDemo({ ...options, link })
              yield* app.start()
              ready.add(undefined)
              yield* sleep(60_000)
            }),
          )
        yield* node({
          role: 'service',
          hosted: ['account', 'todos', 'media'],
          instance: 'api-1',
          port: 0,
        })
        yield* node({
          role: 'service',
          hosted: ['feed', 'reports', 'live', 'rtc', 'cluster'],
          instance: 'api-2',
          port: 0,
        })
        yield* ready.next()
        yield* ready.next()
        const gateway = yield* createDemo({ role: 'gateway', instance: 'gw', link })
        const info = yield* gateway.start()
        const base = (info.url as string).replace('http', 'ws')

        // the callee arrives 400ms late — the caller sits in `rtc:waiting` until the relay pairs
        // them, then the pairing negotiates over the cluster carrier
        const received = createQueue<string, void>()
        yield* fork(function* () {
          yield* sleep(400)
          const socketB = yield* Ws.actions.connect(`${base}/rtc/cluster-e2e`)
          const roleB = yield* roleOf(socketB)
          const peerB = yield* Rtc.actions.connect(socketB, { polite: roleB.polite === true })
          const channels = yield* peerB.channels
          const emitted = yield* channels.next()
          received.add(emitted.done ? 'closed' : emitted.value.label)
          yield* sleep(60_000) // keep the callee alive for the exchange
        })

        const socketA = yield* Ws.actions.connect(`${base}/rtc/cluster-e2e`)
        const roleA = yield* roleOf(socketA)
        const peerA = yield* Rtc.actions.connect(socketA, { polite: roleA.polite === true })
        const call = yield* peerA.channel('call', { openTimeoutMs: 15_000 })
        expect(call.readyState).toBe('open')
        const label = yield* received.next()
        expect(label.done ? 'closed' : label.value).toBe('call')

        yield* peerA.close()
        yield* gateway.stop()
      }),
    )
  }, 30_000)

  it('a peer report becomes observe rows, spans and events — and ships to OpenObserve', async () => {
    // one stand-in OpenObserve for BOTH ingestion paths of the one exporter: the bulk
    // streams (`/api/<org>/<stream>/_json`) and its embedded OTLP leg (`/api/<org>/v1/traces`)
    const captured: { stream: string; rows: AnyType[] }[] = []
    const otlpSpans: AnyType[] = []
    const collector = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith('/v1/traces')) {
          const body = (await request.json()) as AnyType
          for (const resource of body.resourceSpans ?? []) {
            for (const scope of resource.scopeSpans ?? []) {
              otlpSpans.push(...(scope.spans ?? []))
            }
          }
          return Response.json({})
        }
        const match = /\/api\/(?<org>[^/]+)\/(?<stream>[^/]+)\/_json$/u.exec(path)
        if (!match?.groups) {
          return new Response(null, { status: 204 }) // v1/logs, v1/metrics — accepted, unread
        }
        captured.push({
          stream: match.groups['stream']!,
          rows: (await request.json()) as AnyType[],
        })
        return Response.json({ status: 'ok' })
      },
    })

    try {
      unwrap(
        await run(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          const app = yield* createDemo({
            instance: 'rtc-observe',
            openobserve: { url: `http://127.0.0.1:${collector.port}` },
          })
          const info = yield* app.start()
          const base = (info.url as string).replace('http', 'ws')

          const caller = yield* Ws.actions.connect(`${base}/rtc/telemetry`)
          const callee = yield* Ws.actions.connect(`${base}/rtc/telemetry`)
          const role = yield* roleOf(caller)
          expect(role.epoch).toBe(1)
          void callee

          // what the browser page sends: the session counters plus the events since the last one
          const at = Date.now()
          yield* caller.send({
            t: 'rtc:report',
            epoch: 1,
            report: {
              role: 'impolite',
              final: true,
              metrics: {
                id: 'rtc_test0001',
                startedAt: at - 900,
                connectedMs: 420,
                state: 'connected',
                generations: 1,
                negotiations: 1,
                offersSent: 1,
                offersReceived: 0,
                answersSent: 0,
                answersReceived: 1,
                glare: 0,
                candidatesSent: 6,
                candidatesReceived: 5,
                restarts: 0,
                reconnects: 1,
                channelsOpened: 1,
                channelsAccepted: 1,
                messagesSent: 3,
                messagesReceived: 2,
                bytesSent: 120,
                bytesReceived: 80,
                tracksSent: 2,
                tracksReceived: 2,
                failures: 0,
              },
              timeline: [
                { at, generation: 1, kind: 'offer', detail: 'out:channel', durationMs: 12 },
                { at: at + 5, generation: 1, kind: 'state', detail: 'connected' },
                {
                  at: at + 10,
                  generation: 1,
                  kind: 'stats',
                  data: { state: 'connected', rttMs: 12, route: 'host/srflx', framesDecoded: 42 },
                },
              ],
            },
          })
          yield* sleep(200) // let the dispatch land in the observe collector

          yield* app.stop() // stop() flushes every exporter sink
        }),
      )
    } finally {
      collector.stop(true)
    }

    const rowsOf = (stream: string) =>
      captured.filter(hit => hit.stream === stream).flatMap(hit => hit.rows)

    // the report ran as a real dispatch: its span tree hangs under the SIGNALING SOCKET's
    // request, so one call leg reads as one tree in the console
    const spans = rowsOf('spans')
    const dispatch = spans.find(row => row.name === 'rtc.report' && row.kind === 'dispatch')
    expect(dispatch?.status).toBe('ok')
    const request = rowsOf('requests').find(row => row.request_id === dispatch.request_id)
    expect(request?.socket).toBe('/rtc/:room')

    // one span per client event, carrying the CLIENT's own timing and numbers
    const offer = spans.find(row => row.name === 'rtc.offer')
    expect(offer?.parent_span_id).toBe(dispatch.span_id)
    expect(offer?.attrs).toEqual(
      expect.objectContaining({
        'rtc.detail': 'out:channel',
        'rtc.duration_ms': 12,
        'rtc.room': 'telemetry',
        'rtc.peer': 'rtc_test0001',
      }),
    )
    const sample = spans.find(row => row.name === 'rtc.stats')
    expect(sample?.attrs).toEqual(
      expect.objectContaining({ rttMs: 12, route: 'host/srflx', framesDecoded: 42 }),
    )

    // the counters: span attributes (what OTLP ships), a name-only event row on the cluster
    // plane, and a log line carrying the same numbers for the console
    const counters = {
      'rtc.room': 'telemetry',
      'rtc.peer': 'rtc_test0001',
      'rtc.role': 'impolite',
      'rtc.reconnects': 1,
      'rtc.connected_ms': 420,
      'rtc.rttMs': 12,
    }
    expect(spans.find(row => row.name === 'rtc.metrics')?.attrs).toEqual(
      expect.objectContaining(counters),
    )
    expect(rowsOf('events').some(row => row.name === 'rtc.metrics')).toBe(true)
    const log = rowsOf('logs').find(row => String(row.msg).startsWith('rtc session ended'))
    expect(log?.data).toEqual(expect.objectContaining(counters))

    // …and the same spans leave over the embedded OTLP leg, attributes intact
    const exported = otlpSpans.find(span => span.name === 'rtc.metrics')
    expect(exported).toBeDefined()
    const attrOf = (span: AnyType, key: string) =>
      span.attributes?.find((attribute: AnyType) => attribute.key === key)?.value
    expect(attrOf(exported, 'rtc.peer')).toEqual({ stringValue: 'rtc_test0001' })
    expect(attrOf(exported, 'rtc.reconnects')).toEqual({ intValue: '1' })
    expect(otlpSpans.some(span => span.name === 'rtc.offer')).toBe(true)

    // the relay's own lifecycle is observable too (a peer can die before it ever reports)
    expect(rowsOf('events').some(row => row.name === 'rtc.pair')).toBe(true)
  }, 30_000)

  it('GET /rtc serves the browser call page with the bundled std client', async () => {
    unwrap(
      await run(function* () {
        const app = yield* createDemo({ instance: 'rtc-page' })
        const info = yield* app.start()

        const response = yield* until(fetch(`${info.url as string}/rtc`))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/html')

        const html = yield* until(response.text())
        expect(html).toContain("<video id='local'")
        expect(html).toContain('rtc:role') // the bundled std client script made it into the page

        yield* app.stop()
      }),
    )
  }, 30_000)
})
