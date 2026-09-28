// oxlint-disable import/exports-last
import type { Flow, Operation, Subscription } from 'std:effect'
import { fork } from 'std:effect'
import { createEvent, useBufferedEvent } from 'std:event'
import type { AnyType } from 'std:shared'

import { VERSION_ZERO } from '../const'
import type { Bus } from '../types/bus'
import type { Change } from '../types/change'
import type { Helpers } from '../types/helpers'
import { dbLog, untraced } from '../utils/telemetry'

import { BUS_ANNOUNCED, BUS_EXPECTED_SEQ, BUS_ORIGIN, BUS_REJECTED, BUS_SEQ } from './const'
import { BusMeta, TxBuffer } from './context'

/** Dedupe state per peer origin: last envelope seq + when it was seen (aged out by `PEER_TTL`). */
const PEER_TTL_MS = 60 * 60 * 1000
const PEER_MAX = 10_000

/** When THIS PROCESS announced each peer (origin → epoch ms) — one record on `globalThis` for
 * every hub in the process: the nodes of an in-process cluster and a second client over the same
 * bus each meet a new peer, but it is announced once. */
const announced = (): Map<string, number> => ((globalThis as AnyType)[BUS_ANNOUNCED] ??= new Map())

/** Take the right to announce `origin`: `false` while an announcement of it is younger than
 * `PEER_TTL_MS` (a peer silent for longer is news again, as it is to a hub's own peer table). */
const claimPeer = (origin: string, now: number): boolean => {
  const peers = announced()
  const at = peers.get(origin)

  if (at !== undefined && now - at <= PEER_TTL_MS) {
    return false
  }

  peers.delete(origin)

  if (peers.size >= PEER_MAX) {
    // the oldest announcement gives way (insertion order is announcement order)
    const [oldest] = peers.keys()

    peers.delete(oldest!)
  }

  peers.set(origin, now)

  return true
}

/** The string entries of a writer's correlation data — what a {@link Change.Event} carries. */
const eventMetaOf = (meta: unknown): Readonly<Record<string, string>> | undefined => {
  if (typeof meta !== 'object' || meta === null) {
    return undefined
  }

  const entries = Object.entries(meta).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Build the per-install change hub over the node's local bus. Every announced write gets an
 * HLC token (minted here, with this node's origin) and fans out to watchers; foreign envelopes
 * are deduped by `(origin, seq)`, a gap (or a new peer) replays the change log, and every applied
 * token lands in a window-bounded `recent` set so a replay never re-applies what an envelope
 * already delivered. Tokens are what the outside sees; the hub additionally keeps a PRIVATE
 * per-table arrival counter — coalescing cannot be answered by token order, because commits and
 * tokens interleave.
 */
export const createHub = (options: Helpers.HubOptions): Helpers.Hub => {
  const { bus, mintToken, persist, replay, retract, observe, replayWindowMs } = options
  const emitter = createEvent<Change.HubEvents>()
  const latest = new Map<string, string>()
  const arrivals = new Map<string, number>()

  /** last applied token + the newest `ts` applied, per table (the replay floor). It starts at
   * "now" for every table: what is already in the logs is history, not news. */
  const startedAt = Date.now()

  const applied = new Map<string, { token: string; at: number }>(
    options.tables.map(table => [table, { token: VERSION_ZERO, at: startedAt }]),
  )

  /** tokens still inside their table's replay horizon: token → table + applied-at. A token stays
   * here for exactly as long as a replay of its table could hand it back (the floor is the
   * table's newest applied-at minus the window), so an envelope and a replay never apply the same
   * change twice. */
  const recent = new Map<string, { table: string; at: number }>()
  const peers = new Map<string, { seq: number; at: number }>()

  const counters = {
    received: 0,
    deduped: 0,
    gaps: 0,
    replayed: 0,
    windowHits: 0,
    driftRejected: 0,
  }
  let seq = 0

  const floorOf = (table: string): number => (applied.get(table)?.at ?? 0) - replayWindowMs

  /** A hub without change logs (every table `log: false` — an exporter's store) has nothing to
   * replay: a gap or a new peer means nothing to it, and it says nothing about them. */
  const replayable = options.tables.length > 0

  const prune = (table: string): void => {
    const floor = floorOf(table)

    for (const [token, entry] of recent) {
      if (entry.table === table && entry.at < floor) {
        recent.delete(token)
      }
    }
  }

  // oxlint-disable-next-line max-params
  const apply = (
    write: Change.Write,
    token: string,
    source: Change.Source,
    meta?: Readonly<Record<string, string>>,
  ): void => {
    const now = Date.now()
    const before = applied.get(write.table)

    applied.set(write.table, { token, at: Math.max(before?.at ?? 0, now) })
    latest.set(write.table, token)
    arrivals.set(write.table, (arrivals.get(write.table) ?? 0) + 1)
    recent.set(token, { table: write.table, at: now })
    prune(write.table)
    emitter.emit('change', { ...write, token, source, ...(meta ? { meta } : {}) })
  }

  /** Emit one recorded write (with the writer's correlation data) and return its wire form. */
  const emit = (
    write: Helpers.Tokened,
    meta: Readonly<Record<string, string>> | undefined,
  ): Change.BusEvent => {
    apply(write, write.token, 'local', meta)

    return write
  }

  /** Fan locally committed writes out to the watchers, then queue them for the peers as ONE
   * envelope — both carrying the correlation data the writes ran under (`withBusMeta`). */
  const ship = function* (writes: readonly Helpers.Tokened[], tx: string) {
    const meta = yield* BusMeta.get()
    const eventMeta = eventMetaOf(meta)
    const events = writes.map(write => emit(write, eventMeta))

    seq += 1
    yield* bus.publish({ origin: bus.origin, seq, tx, events, ...(meta ? { meta } : {}) })
  }

  const record = function* (write: Change.Write) {
    const tokened: Helpers.Tokened = { ...write, token: write.token ?? (yield* mintToken()) }

    // inside a transaction the log rows are written as its last step (see `persist`)
    if (!(yield* TxBuffer.get())) {
      yield* persist([tokened], null)
    }

    return tokened
  }

  const announce = function* (write: Helpers.Tokened) {
    const buffer = yield* TxBuffer.get()

    if (buffer) {
      buffer.push(write)

      return
    }

    yield* ship([write], write.token)
  }

  const publish = function* (write: Change.Write) {
    yield* announce(yield* record(write))
  }

  const flush = function* (writes: readonly Change.Write[], tx: string) {
    const outer = yield* TxBuffer.get()

    if (outer) {
      outer.push(...writes)

      return
    }

    if (writes.length === 0) {
      return
    }

    yield* ship(writes as readonly Helpers.Tokened[], tx)
  }

  /** Apply the change-log rows of a table newer than its replay floor (minus the window). */
  const replayTable = function* (table: string) {
    const floor = applied.get(table)
    const rows = yield* replay(table, floorOf(table))

    for (const row of rows) {
      if (recent.has(row.token)) {
        continue
      }

      if (floor && row.token < floor.token) {
        counters.windowHits += 1
      }

      counters.replayed += 1
      apply({ table, id: row.id, op: row.op, fields: row.fields ?? undefined }, row.token, 'replay')
    }
  }

  const sync = function* (tables?: readonly string[]) {
    for (const table of tables ?? options.tables) {
      yield* replayTable(table)
    }
  }

  const feedBus = function* (envelope: Bus.Envelope) {
    counters.received += 1

    const now = Date.now()
    const peer = peers.get(envelope.origin)

    if (peer && envelope.seq <= peer.seq) {
      counters.deduped += 1

      return
    }

    if (!peer && peers.size >= PEER_MAX) {
      // forget the stalest peer before admitting a new one
      let stalest: [string, number] | null = null

      for (const [origin, entry] of peers) {
        if (!stalest || entry.at < stalest[1]) {
          stalest = [origin, entry.at]
        }
      }

      if (stalest) {
        peers.delete(stalest[0])
      }
    }

    for (const [origin, entry] of peers) {
      if (now - entry.at > PEER_TTL_MS) {
        peers.delete(origin)
      }
    }

    peers.set(envelope.origin, { seq: envelope.seq, at: now })

    // a lost envelope (or a peer we have never heard) → the logs are the truth: replay EVERY
    // table first — what was lost may concern any of them, not only the ones this envelope names
    if (!peer || envelope.seq > peer.seq + 1) {
      counters.gaps += 1

      // a hub without change logs has nothing to replay — and nothing to say about it. A new
      // peer is INFO once per PROCESS: claimed only by a hub that writes the line (a Logger
      // here, work not suppressed)
      if (replayable) {
        yield* peer
          ? dbLog('warn', 'db bus: envelopes lost — replaying the change logs', {
              [BUS_ORIGIN]: envelope.origin,
              [BUS_EXPECTED_SEQ]: peer.seq + 1,
              [BUS_SEQ]: envelope.seq,
            })
          : dbLog(
              'info',
              'db bus: first envelope from a peer — replaying the change logs',
              { [BUS_ORIGIN]: envelope.origin, [BUS_SEQ]: envelope.seq },
              () => claimPeer(envelope.origin, now),
            )

        yield* sync()
      }
    }

    const meta = eventMetaOf(envelope.meta)
    let drifted = 0

    for (const event of envelope.events) {
      if (recent.has(event.token)) {
        continue
      }

      if (!(yield* observe(event.token))) {
        counters.driftRejected += 1
        drifted += 1
      }

      const { token, ...write } = event

      apply(write, token, 'bus', meta)
    }

    if (drifted > 0) {
      yield* dbLog('warn', "db bus: peer tokens too far ahead — this node's clock kept its own", {
        [BUS_ORIGIN]: envelope.origin,
        [BUS_REJECTED]: drifted,
      })
    }
  }

  // every subscriber gets its own buffered queue (registered on subscribe, released with the
  // consuming scope), so a slow watcher never drops events — it just drains them later
  const changes = (table?: string): Flow<Change.Event, never> => ({
    *[Symbol.iterator]() {
      const subscription = yield* useBufferedEvent(emitter, 'change')

      return {
        *next() {
          for (;;) {
            const step = yield* subscription.next()

            if (step.done) {
              continue
            }

            const [event] = step.value

            if (!table || event.table === table) {
              return { done: false as const, value: event }
            }
          }
        },
      }
    },
  })

  return {
    publish,
    record,
    announce,
    *persist(writes, tx) {
      yield* persist(writes, tx)
    },
    *retract(write) {
      // inside a transaction `record` buffered without persisting — nothing to take back
      if (!(yield* TxBuffer.get())) {
        yield* retract(write)
      }
    },
    isolate: <T>(buffer: Change.Write[], body: () => Operation<T>) => TxBuffer.with(buffer, body),
    flush,
    feedBus,
    sync,
    changes,
    version: table => latest.get(table) ?? VERSION_ZERO,
    arrival: table => arrivals.get(table) ?? 0,
    stats: () => ({ ...counters, peers: Object.fromEntries(peers) }),
  }
}

/** Forward one `std:event` envelope stream into a sink, dropping this node's own echoes. */
const pumpBus = function* (
  feed: Subscription<[envelope: Bus.Envelope], never>,
  origin: string,
  sink: (envelope: Bus.Envelope) => Operation<void>,
) {
  for (;;) {
    const step = yield* feed.next()

    if (step.done) {
      return
    }

    const [envelope] = step.value

    if (envelope.origin !== origin) {
      yield* sink(envelope)
    }
  }
}

/** Start feeding the local bus's incoming envelopes into the hub. Subscribe HERE, then fork the
 * drain — a forked subscribe would race the first send. */
export const attachBus = function* (hub: Change.Hub, bus: Change.Bus) {
  const subscription = yield* useBufferedEvent(bus.events, 'change')

  // the pump (and the replays it triggers) belong to no request: no span over them
  yield* fork(() =>
    untraced(() => pumpBus(subscription, bus.origin, envelope => hub.feedBus(envelope))),
  )
}

/** Forward the bus plugin's incoming envelopes onto the local bus. */
export const attachTransport = function* (bus: Change.Bus, endpoint: Bus.Context) {
  const subscription = yield* useBufferedEvent(endpoint.events, 'change')

  yield* fork(() =>
    untraced(() =>
      pumpBus(subscription, bus.origin, function* (envelope) {
        bus.events.emit('change', envelope)
      }),
    ),
  )
}
