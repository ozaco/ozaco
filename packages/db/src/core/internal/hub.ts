// oxlint-disable import/exports-last
import type { Context, Flow, Operation, Subscription } from 'std:effect'
import { createContext, createSignal, operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { BusEvent, ChangeBus, ChangeEvent, ChangeOp, Doc, LiveChange } from '../types'

/** A committed local write before the hub assigns its version/source. */
export interface LocalWrite {
  readonly table: string
  readonly id: string
  readonly op: ChangeOp
  readonly doc: Doc | null
}

/**
 * The per-install change hub — the single fan-out point reactivity is built on. Sources feed it
 * from three sides: local writes (`publish`), the adapter's native live feed (`feedLive`) and a
 * cross-node bus (`feedBus`); watchers consume it via `changes()`. Per-table versions are monotonic
 * across all sources. Inside a transaction, `publish` buffers into the scope's isolation buffer and
 * the events reach watchers only on commit (`flush`, one batched bus publish).
 */
export interface Hub {
  /** Broadcast one committed local write (or buffer it inside a transaction). */
  publish(write: LocalWrite): Operation<void>
  /** Run `body` with a fresh transaction buffer capturing every `publish`. */
  isolate<T>(events: LocalWrite[], body: () => Operation<T>): Operation<T>
  /** Emit (or hand to an enclosing buffer) writes captured by `isolate` after a commit. */
  flush(events: readonly LocalWrite[]): Operation<void>
  /** Feed one change from the adapter's native live feed. */
  feedLive(change: LiveChange): void
  /** Feed one foreign change from the cross-node bus. */
  feedBus(event: BusEvent): void
  /** Fall back to write-through emission (the live feed died) and heal every watcher of the given
   * tables with a synthetic table-level touch. */
  restoreLocal(tables: readonly string[]): void
  /** The change feed, optionally filtered to one table. Subscription binds to the consuming scope. */
  changes(table?: string): Flow<ChangeEvent, never>
  version(table: string): number
  hasBus(): boolean
  /** Attach the bus used by `publish` for cross-node fan-out. Returns false if one is attached. */
  setBus(bus: ChangeBus): boolean
  busOf(): ChangeBus | undefined
}

/** The transaction isolation buffer — set for the duration of a `transaction` body. */
const TxBuffer: Context<LocalWrite[]> = createContext<LocalWrite[]>('db:tx-buffer')

export interface HubOptions {
  /** false when the adapter has a native live feed (the feed then owns the change stream and local
   * writes are NOT synthesized into events, preventing double emission). */
  readonly emitLocal: boolean
}

export const createHub = (options: HubOptions): Hub => {
  const signal = createSignal<ChangeEvent, never>()
  const versions = new Map<string, number>()
  let emitLocal = options.emitLocal
  let bus: ChangeBus | undefined

  const bump = (table: string): number => {
    const next = (versions.get(table) ?? 0) + 1
    versions.set(table, next)
    return next
  }

  /** Emit one local write (when write-through is on) and return its bus form, or null. */
  const emitNow = (write: LocalWrite): BusEvent | null => {
    // with a native live feed the backend reports this same write — synthesizing an event (or even
    // bumping the version) here would double-count it
    if (!emitLocal) {
      return null
    }
    const version = bump(write.table)
    signal.send({ ...write, version, source: 'local' })
    return bus
      ? { table: write.table, id: write.id, op: write.op, version, origin: bus.origin }
      : null
  }

  const publish = operation(function* (write: LocalWrite) {
    const buffer = yield* TxBuffer.get()
    if (buffer) {
      buffer.push(write)
      return
    }
    const event = emitNow(write)
    if (event && bus) {
      yield* bus.publish([event])
    }
  })

  const flush = operation(function* (events: readonly LocalWrite[]) {
    const outer = yield* TxBuffer.get()
    if (outer) {
      outer.push(...events)
      return
    }
    const batch: BusEvent[] = []
    for (const write of events) {
      const event = emitNow(write)
      if (event) {
        batch.push(event)
      }
    }
    if (batch.length > 0 && bus) {
      yield* bus.publish(batch)
    }
  })

  const changes = (table?: string): Flow<ChangeEvent, never> =>
    ({
      *[Symbol.iterator]() {
        const subscription = yield* signal
        return {
          next: operation(function* () {
            for (;;) {
              const step = yield* subscription.next()
              if (!step.done && (!table || step.value.table === table)) {
                return step
              }
            }
          }),
        }
      },
    }) as Flow<ChangeEvent, never>

  return {
    publish,
    isolate: <T>(events: LocalWrite[], body: () => Operation<T>): Operation<T> =>
      TxBuffer.with(events, body) as Operation<T>,
    flush,
    feedLive: change => {
      signal.send({
        table: change.table,
        id: change.id,
        op: change.op,
        doc: change.doc,
        version: bump(change.table),
        cursor: change.cursor,
        source: 'live',
      })
    },
    feedBus: event => {
      if (event.version > (versions.get(event.table) ?? 0)) {
        versions.set(event.table, event.version)
      }
      signal.send({
        table: event.table,
        id: event.id,
        op: event.op,
        // the bus is an invalidation channel, never a data carrier — re-read from the database
        doc: null,
        version: event.version,
        cursor: event.cursor,
        source: 'bus',
      })
    },
    restoreLocal: tables => {
      if (emitLocal) {
        return
      }
      emitLocal = true
      for (const table of tables) {
        signal.send({
          table,
          id: '',
          op: 'touch',
          doc: null,
          version: bump(table),
          source: 'local',
        })
      }
    },
    changes,
    version: table => versions.get(table) ?? 0,
    hasBus: () => bus !== undefined,
    setBus: next => {
      if (bus) {
        return false
      }
      bus = next
      return true
    },
    busOf: () => bus,
  }
}

/** Drain an adapter's native live feed into the hub. Subscribe in the PARENT and `fork` this with
 * the ready subscription — forking the subscribe itself races the first send (pre-subscription
 * values are dropped). If the feed CLOSES (reconnect budget exhausted), the hub falls back to
 * write-through emission and heals the given tables' watchers, so reactivity degrades instead of
 * dying. */
export const pumpLive = operation(function* (
  hub: Hub,
  subscription: Subscription<LiveChange, void>,
  tables: readonly string[],
) {
  for (;;) {
    const step = yield* subscription.next()
    if (step.done) {
      hub.restoreLocal(tables)
      return
    }
    hub.feedLive(step.value)
  }
})

/** Drain a {@link ChangeBus} subscription into the hub, dropping this node's own echoes. Same
 * contract as {@link pumpLive}: subscribe in the parent, `fork` the drain. */
export const bridgeBus = operation(function* (
  hub: Hub,
  origin: string,
  subscription: Subscription<BusEvent, AnyType>,
) {
  for (;;) {
    const step = (yield* subscription.next()) as IteratorResult<BusEvent, AnyType>
    if (step.done) {
      break
    }
    if (step.value.origin === origin) {
      continue
    }
    hub.feedBus(step.value)
  }
})
