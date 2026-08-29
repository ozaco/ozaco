/**
 * Rtc: a 1:1 WebRTC SIGNALING relay — `/rtc/:room` pairs two sockets and forwards every frame
 * between them verbatim. The relay OWNS the session lifecycle, because a client cannot guess it
 * on its own (both sides only ever see their half):
 *
 * - `{ t: 'rtc:waiting' }` — you are alone in the room; do NOT negotiate yet.
 * - `{ t: 'rtc:role', polite, epoch }` — a pairing formed; sent to BOTH members. Start a fresh
 *   peer with this `polite` role and stamp every frame you send with `epoch`. The two members
 *   ALWAYS get opposite roles: a polite/polite (or impolite/impolite) pair deadlocks on offer
 *   glare, which is exactly what plain join order produces when one side rejoins.
 * - `{ t: 'rtc:peer-left', epoch }` — your partner is gone; end the session and wait for the
 *   next `rtc:role`.
 * - `{ t: 'rtc:restart', epoch }` (client → relay) — "this session is dead, re-pair us". Honored
 *   once per epoch, so both sides asking at the same moment still produces ONE new pairing.
 *
 * Clients drop frames stamped with an older epoch, so the hang-up `rtc:bye` of a finished
 * session can never kill the fresh one that replaced it. Everything that is not a relay frame is
 * forwarded untouched — offers, answers, trickled candidates, redials.
 *
 * CLUSTER: a socket is driven by the edge node that ACCEPTED it, so the two peers of one call
 * routinely sit on different nodes. Every node keeps the same room view and they coordinate over
 * the carrier's event plane (`rtc.relay`) — at-most-once fan-out, which is the right plane for
 * signaling: a replayed offer is poison, so this must never ride a durable stream (JetStream
 * carries the dispatches and the reports, not this). Nothing is negotiated between nodes because
 * every decision is DERIVED: the roles come from the two member ids (the smaller one offers) and
 * the epoch is `room.epoch + 1`, so two nodes that see the same pair announce byte-identical
 * pairings and the duplicate is ignored. Both sides announce on purpose — a broadcast that gets
 * dropped on one node is covered by the other.
 *
 * TELEMETRY: a browser peer also sends `{ t: 'rtc:report', … }` every few seconds (and once more
 * when its session ends) carrying `peer.metrics` plus the `peer.events` it collected since the
 * last one. The relay hands those to the `rtc.report` ACTION, so a call that happens entirely
 * between two browsers still lands in the server's observe pipeline — one request row per report,
 * one span per timeline entry, one `rtc.metrics` event row — and therefore in the console at
 * `/_ozaco` and in whatever OTLP / OpenObserve exporter is installed.
 */
import type { EdgeDef } from 'server:core'
import { action, Server, service, stream } from 'server:core'
import type { Flow, Operation } from 'std:effect'
import { attempt, flowOf, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

/** This process — a node ignores the echo of its own broadcasts (`events()` includes them). */
const NODE =
  globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)

/** The carrier event every edge node listens on (see `startRtcRelay`). */
const RELAY = 'rtc.relay'

interface Member {
  readonly id: string
  /** the role of the CURRENT pairing (undefined until one forms). */
  polite?: boolean
  /** present only on the node that holds the socket — that node does the sending. */
  readonly socket?: EdgeDef.Socket
}

interface Room {
  /** member id → member, at most two, LOCAL and remote alike. */
  members: Map<string, Member>
  /** Bumped on every pairing — the session id both members run and stamp their frames with. */
  epoch: number
}

/** One pairing, derived from the pair alone so every node computes the same thing. */
interface Pairing {
  epoch: number
  /** member id → polite. */
  roles: Record<string, boolean>
}

type RelayEvent =
  | { t: 'join'; node: string; room: string; member: string }
  | { t: 'leave'; node: string; room: string; member: string }
  | { t: 'pair'; node: string; room: string; pairing: Pairing }
  | { t: 'frame'; node: string; room: string; from: string; frame: unknown }

/** The room view of THIS node: every member of every room it takes part in. */
const rooms = new Map<string, Room>()

const roomOf = (name: string): Room => {
  const room = rooms.get(name) ?? { members: new Map<string, Member>(), epoch: 0 }
  rooms.set(name, room)
  return room
}

const forget = (name: string, room: Room) => {
  if (room.members.size === 0) {
    rooms.delete(name)
  }
}

/** Is the other member somewhere else? (Then a frame has to cross the carrier.) */
const hasRemote = (room: Room, except: string): boolean =>
  [...room.members.values()].some(member => member.id !== except && !member.socket)

/** Derived, never negotiated: the smaller member id offers (impolite), the other yields. */
const pairingOf = (room: Room): Pairing => {
  const [first, second] = [...room.members.keys()].toSorted()
  return { epoch: room.epoch + 1, roles: { [first!]: false, [second!]: true } }
}

const broadcast = (event: RelayEvent) => Server.actions.emit(RELAY, event)

/** Adopt a pairing and hand every LOCAL member its role. Already at (or past) that epoch means
 * this is the other node's identical announcement — ignore it. */
function* applyPairing(name: string, room: Room, pairing: Pairing): Operation<boolean> {
  if (pairing.epoch <= room.epoch) {
    return false
  }
  room.epoch = pairing.epoch
  for (const member of room.members.values()) {
    member.polite = pairing.roles[member.id] ?? false
    if (member.socket) {
      yield* member.socket.send({
        t: 'rtc:role',
        room: name,
        polite: member.polite,
        epoch: room.epoch,
      })
    }
  }
  return true
}

/** Open a new session for the pair: apply it here, then tell the other nodes. */
function* announce(name: string, room: Room): Operation<void> {
  const pairing = pairingOf(room)
  if (!(yield* applyPairing(name, room, pairing))) {
    return
  }
  yield* broadcast({ t: 'pair', node: NODE, room: name, pairing })
  // the lifecycle is observable even for a peer that dies before it can report — once per
  // pairing, from the node holding the member that drives the offer
  const [first] = [...room.members.keys()].toSorted()
  if (room.members.get(first!)?.socket) {
    yield* Server.actions.emit('rtc.pair', { room: name, epoch: pairing.epoch, members: 2 })
  }
}

/** Hand a frame to every LOCAL member of the room except its sender. */
function* deliver(room: Room, from: string, frame: unknown): Operation<void> {
  for (const member of room.members.values()) {
    if (member.id !== from && member.socket) {
      yield* member.socket.send(frame)
    }
  }
}

/** Whoever is left ends their session and waits for the next pairing. */
function* announceDeparture(name: string, room: Room): Operation<void> {
  for (const member of room.members.values()) {
    if (member.socket) {
      yield* member.socket.send({ t: 'rtc:peer-left', room: name, epoch: room.epoch })
    }
  }
}

function* applyEvent(event: RelayEvent): Operation<void> {
  if (event.t === 'frame') {
    const room = rooms.get(event.room)
    if (room) {
      yield* deliver(room, event.from, event.frame)
    }
    return
  }

  const room = roomOf(event.room)
  if (event.t === 'join') {
    if (!room.members.has(event.member)) {
      room.members.set(event.member, { id: event.member })
    }
    if (room.members.size === 2) {
      yield* announce(event.room, room)
    }
    return
  }
  if (event.t === 'leave') {
    if (room.members.delete(event.member)) {
      yield* announceDeparture(event.room, room)
    }
    forget(event.room, room)
    return
  }
  yield* applyPairing(event.room, room, event.pairing)
}

/** `peer.metrics` as it travels — the always-on session counters of ONE browser peer. */
const Metrics = z.object({
  id: z.string(),
  startedAt: z.number(),
  connectedMs: z.number().optional(),
  state: z.string(),
  generations: z.number(),
  negotiations: z.number(),
  offersSent: z.number(),
  offersReceived: z.number(),
  answersSent: z.number(),
  answersReceived: z.number(),
  glare: z.number(),
  candidatesSent: z.number(),
  candidatesReceived: z.number(),
  restarts: z.number(),
  reconnects: z.number(),
  channelsOpened: z.number(),
  channelsAccepted: z.number(),
  messagesSent: z.number(),
  messagesReceived: z.number(),
  bytesSent: z.number(),
  bytesReceived: z.number(),
  tracksSent: z.number(),
  tracksReceived: z.number(),
  failures: z.number(),
})

/** One `peer.events` entry — the client's trace of what happened, with client timings. */
const Moment = z.object({
  at: z.number(),
  generation: z.number(),
  kind: z.string(),
  detail: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  data: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
})

const Report = z.object({
  room: z.string(),
  epoch: z.number().int().nonnegative(),
  role: z.enum(['polite', 'impolite']),
  /** the last report of a session (the peer closed) — `false` on the periodic ones. */
  final: z.boolean().default(false),
  metrics: Metrics,
  /** what happened since the previous report (bounded — the client ships deltas). */
  timeline: z.array(Moment).max(128).default([]),
})

type ReportInput = z.infer<typeof Report>

/** Flat, exporter-friendly attributes for a report's span / event row. */
const attrsOf = (input: ReportInput) => {
  const sample = input.timeline.findLast(moment => moment.kind === 'stats')?.data ?? {}
  const { metrics } = input
  return {
    'rtc.room': input.room,
    'rtc.epoch': input.epoch,
    'rtc.peer': metrics.id,
    'rtc.role': input.role,
    'rtc.state': metrics.state,
    'rtc.generations': metrics.generations,
    'rtc.negotiations': metrics.negotiations,
    'rtc.glare': metrics.glare,
    'rtc.restarts': metrics.restarts,
    'rtc.reconnects': metrics.reconnects,
    'rtc.failures': metrics.failures,
    'rtc.messages_sent': metrics.messagesSent,
    'rtc.messages_received': metrics.messagesReceived,
    'rtc.channels': metrics.channelsOpened + metrics.channelsAccepted,
    'rtc.tracks': metrics.tracksSent + metrics.tracksReceived,
    ...(metrics.connectedMs === undefined ? {} : { 'rtc.connected_ms': metrics.connectedMs }),
    ...Object.fromEntries(Object.entries(sample).map(([key, value]) => [`rtc.${key}`, value])),
  }
}

const PAGE = `<!doctype html>
<html lang='en'>
<head>
<meta charset='utf-8' />
<meta name='viewport' content='width=device-width, initial-scale=1' />
<link rel='icon' href='data:,' />
<title>ozaco call</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 14px/1.5 ui-monospace, monospace; background: #0b0e14; color: #d6dae3; padding: 16px;
         display: grid; gap: 12px; min-height: 100vh; grid-template-rows: auto auto auto 1fr; }
  header { display: flex; gap: 12px; align-items: baseline; }
  header h1 { font-size: 16px; }
  header code { color: #7aa2f7; }
  #status { color: #9aa0ae; }
  .videos { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  video { width: 100%; aspect-ratio: 4 / 3; background: #10141f; border: 1px solid #1f2535;
          border-radius: 8px; object-fit: cover; }
  .chat { display: grid; grid-template-rows: 1fr auto; gap: 8px; min-height: 140px; }
  #log { list-style: none; padding: 8px; overflow-y: auto; background: #10141f;
         border: 1px solid #1f2535; border-radius: 8px; }
  #log li[data-from='you'] { color: #9ece6a; }
  #metrics { color: #565f89; font-size: 12px; white-space: pre-wrap; }
  #form { display: flex; gap: 8px; }
  #box { flex: 1; background: #10141f; border: 1px solid #1f2535; border-radius: 8px;
         color: inherit; padding: 8px 10px; outline: none; }
  small { color: #565f89; }
</style>
</head>
<body>
<header>
  <h1>ozaco call</h1>
  <code id='room'></code>
  <span id='status'>loading…</span>
</header>
<div class='videos'>
  <video id='local' autoplay playsinline muted></video>
  <video id='remote' autoplay playsinline></video>
</div>
<pre id='metrics'>metrics: —</pre>
<div class='chat'>
  <ul id='log'></ul>
  <form id='form'>
    <input id='box' placeholder='say something (data channel)' autocomplete='off' />
    <button>send</button>
  </form>
</div>
<small>open this exact URL (same #room) in a second tab — the relay pairs you and re-pairs you after a refresh or a hang-up</small>
<script type='module'>/*__SCRIPT__*/</script>
</body>
</html>`

/** The page bundle, built once per process from `src/rtc-page.ts` (browser target, std dist). */
let pageCache: Uint8Array | undefined

function* buildPage() {
  if (!pageCache) {
    const entry = new URL('../rtc-page.ts', import.meta.url).pathname
    const built = yield* until(
      // minify.syntax's constant folding makes the bundler resolve a dead `child_process`
      // require somewhere in the std graph — whitespace+identifiers alone build clean (~70KB)
      Bun.build({
        entrypoints: [entry],
        target: 'browser',
        format: 'esm',
        minify: { whitespace: true, identifiers: true, syntax: false },
      }),
    )
    const artifact = built.outputs[0]
    if (!built.success || !artifact) {
      return yield* fail('rtc.build', built.logs.map(String).join('\n') || 'empty build output')
    }
    const script = (yield* until(artifact.text())).replaceAll('</script>', String.raw`<\/script>`)
    pageCache = new TextEncoder().encode(PAGE.replace('/*__SCRIPT__*/', script))
  }
  const body = pageCache
  const flow: Flow<Uint8Array, void> = flowOf(function* (emit) {
    yield* emit(body)
  })
  return flow
}

export const rtc = service(
  'rtc',
  {
    page: action.stream(
      {
        output: stream.bytes('text/html; charset=utf-8'),
        route: { method: 'GET', path: '/rtc' },
        errors: { 'rtc.build': 500 },
        description: 'The browser call page \u2014 open twice with the same #room for a video call',
      },
      function* () {
        return yield* buildPage()
      },
    ),
    report: action.mutation(
      {
        input: Report,
        output: z.object({ spans: z.number() }),
        route: { method: 'POST', path: '/rtc/report' },
        description:
          'Record a browser peer\u2019s WebRTC metrics + event timeline (the relay forwards them off the signaling socket)',
      },
      function* ({ input, ctx }) {
        const attrs = attrsOf(input)

        // one span per client event: the dispatch span is the parent, so a report reads as the
        // negotiation it describes — with the CLIENT's own duration on each step
        for (const moment of input.timeline) {
          yield* ctx.span(`rtc.${moment.kind}`, function* () {}, {
            'rtc.room': input.room,
            'rtc.peer': input.metrics.id,
            'rtc.generation': moment.generation,
            'rtc.at': moment.at,
            ...(moment.detail === undefined ? {} : { 'rtc.detail': moment.detail }),
            ...(moment.durationMs === undefined ? {} : { 'rtc.duration_ms': moment.durationMs }),
            ...(moment.error === undefined ? {} : { 'rtc.error': moment.error }),
            ...moment.data,
          })
        }

        // the counters themselves, twice on purpose: as SPAN ATTRIBUTES (the OTLP exporter ships
        // spans, so this is what reaches an OTel collector) and as an event on the cluster plane
        // (an `emit` row is name-only — live dashboards read the payload off `Server.events`)
        yield* ctx.span('rtc.metrics', function* () {}, attrs)
        yield* ctx.emit('rtc.metrics', attrs)

        const failed = input.metrics.failures > 0 || input.timeline.some(item => item.error)
        yield* (failed ? ctx.log.warn : ctx.log.info)(
          `rtc ${input.final ? 'session ended' : 'session'} ${input.room}#${input.epoch}`,
          attrs,
        )

        return { spans: input.timeline.length }
      },
    ),
    signal: action.socket(
      {
        path: '/rtc/:room',
        protocol: 'rtc-signal',
        description:
          'join a room (max 2) — the relay drives the session: rtc:waiting, rtc:role { polite, epoch }, rtc:peer-left; rtc:restart re-pairs; every other frame is relayed to the other member',
      },
      // the annotations break the self-reference cycle of `ctx.call(rtc, 'report', …)` below
      function* (socket): Operation<void> {
        const name = socket.params.room ?? 'lobby'
        const room = roomOf(name)
        const id = socket.id
        if (room.members.size >= 2) {
          yield* socket.send({ t: 'rtc:room-full', room: name })
          yield* socket.close(4000, 'room full')
          forget(name, room)
          return
        }
        room.members.set(id, { id, socket })
        yield* broadcast({ t: 'join', node: NODE, room: name, member: id })

        try {
          // alone → sit tight; paired → both sides get their role for the new epoch
          yield* room.members.size < 2
            ? socket.send({ t: 'rtc:waiting', room: name })
            : announce(name, room)

          const messages = yield* socket.messages
          for (;;) {
            const step = yield* messages.next()
            if (step.done) {
              break
            }
            const frame = step.value as { t?: unknown; epoch?: unknown; report?: unknown }
            if (frame?.t === 'rtc:report') {
              // telemetry, not signaling: it never reaches the other member. A bad report must
              // not take the call down with it, so the dispatch is attempted, not awaited-raw.
              // the report body is untrusted socket input — the action's schema validates it
              const report = {
                ...(frame.report as object),
                room: name,
                epoch: typeof frame.epoch === 'number' ? frame.epoch : room.epoch,
              } as AnyType

              yield* attempt((): Operation<unknown> => socket.ctx.call(rtc, 'report', report))
              continue
            }
            if (frame?.t === 'rtc:restart') {
              // one honored restart per epoch: the partner's identical request arrives after the
              // bump and is ignored, so a dead session re-pairs exactly once
              if (frame.epoch === room.epoch && room.members.size > 1) {
                yield* announce(name, room)
              }
              continue
            }
            yield* deliver(room, id, step.value)
            if (hasRemote(room, id)) {
              yield* broadcast({ t: 'frame', node: NODE, room: name, from: id, frame: step.value })
            }
          }
        } finally {
          // sync-only: this also runs when the handler is HALTED (server stop)
          room.members.delete(id)
          forget(name, room)
        }

        // the socket closed on its own — tell the other nodes and whoever is left here (yielding
        // is safe on this path: it unwinds normally, it is not a halt)
        yield* broadcast({ t: 'leave', node: NODE, room: name, member: id })
        yield* announceDeparture(name, room)
        yield* attempt(() =>
          socket.ctx.emit('rtc.leave', { room: name, epoch: room.epoch, left: room.members.size }),
        )
      },
    ),
  },
  { version: '1.0.0', description: 'WebRTC signaling relay' },
)

/**
 * The cross-node half of the relay: consume `rtc.relay` from every node and fold it into this
 * node's room view. Forked once per EDGE node (`createDemo`) — a node that accepts no sockets
 * has no rooms to keep. Own broadcasts come back through this flow and are skipped.
 */
export function* startRtcRelay(): Operation<void> {
  const events = yield* Server.actions.events(RELAY)
  for (;;) {
    const step = yield* events.next()
    if (step.done) {
      return
    }
    const event = step.value.payload as RelayEvent | undefined
    if (!event || event.node === NODE) {
      continue
    }
    yield* applyEvent(event)
  }
}
