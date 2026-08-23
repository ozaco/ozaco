import type { TransportDef } from 'transport:core'

import { deliver, mulberry32 } from './internal'
import type { Memory } from './types'

/** A fresh link: `install(MemoryTransport, { link })` in every scope that should share it. With
 * `chaos`, the link is an unreliable network in a box — deterministic per seed. */
export const createLink = (options?: Memory.LinkOptions): Memory.Link => ({
  chaos: options?.chaos
    ? {
        seed: options.chaos.seed,
        rules: {
          dropRate: options.chaos.dropRate ?? 0.1,
          duplicateRate: options.chaos.duplicateRate ?? 0.1,
          maxDelayMs: options.chaos.maxDelayMs ?? 50,
        },
        random: mulberry32(options.chaos.seed),
        counters: { delivered: 0, dropped: 0, duplicated: 0 },
      }
    : null,
  subscribers: new Set(),
  cursors: new Map(),
  durables: new Map(),
  states: new Set(),
})

/** Flip every install on a link to `status` — the in-process stand-in for a broker outage:
 * while `reconnecting`, publishes are buffered and land once the link is `connected` again
 * (what the NATS and Redis clients do with their own reconnects). */
export const setStatus = (link: Memory.Link, status: TransportDef.Status): void => {
  for (const state of link.states) {
    state.status = status

    for (const watcher of state.watchers) {
      watcher.add(status)
    }

    if (status === 'connected') {
      for (const raw of state.outbox.splice(0)) {
        deliver(link, raw)
      }
    }
  }
}
