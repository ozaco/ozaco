import type { Operation, Queue } from 'std:effect'
import { createContext, createQueue, ensure, fork, sleep, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { TransportDef } from 'transport:core'
import { matchTopic, prefixed, TransportErrors, unprefixed } from 'transport:core'

import type { Memory } from './types'

/** Hand one held message to the next member of a durable (round-robin), or park it. */
const offer = (durable: Memory.Durable, held: Memory.Held): void => {
  const members = [...durable.members]

  if (members.length === 0) {
    durable.pending.push(held)
    return
  }

  durable.inflight.set(held.seq, held)
  members[durable.cursor % members.length]!.add(held)
  durable.cursor += 1
}

/** The queues one raw message must reach: every matching plain subscriber, one member per
 * matching group (round-robin). Durables are handled apart (they remember). */
const targetsOf = (link: Memory.Link, raw: TransportDef.Raw): Queue<TransportDef.Raw, void>[] => {
  const matching = [...link.subscribers].filter(sub => matchTopic(sub.pattern, raw.topic))
  const groups = new Map<string, Memory.Subscriber[]>()
  const targets: Queue<TransportDef.Raw, void>[] = []

  for (const sub of matching) {
    if (sub.group === undefined) {
      targets.push(sub.queue)
      continue
    }

    const members = groups.get(sub.group) ?? []
    members.push(sub)
    groups.set(sub.group, members)
  }

  for (const [group, members] of groups) {
    const cursor = link.cursors.get(group) ?? 0
    targets.push(members[cursor % members.length]!.queue)
    link.cursors.set(group, cursor + 1)
  }

  return targets
}

/** Remember one raw message in every durable whose pattern matches. */
const retain = (link: Memory.Link, raw: TransportDef.Raw): number => {
  let kept = 0

  for (const durable of link.durables.values()) {
    if (matchTopic(durable.pattern, raw.topic)) {
      durable.seq += 1
      offer(durable, { seq: durable.seq, raw })
      kept += 1
    }
  }

  return kept
}

/** Deliver through the link's chaos: each target rolls drop / duplicate / delay from the seeded
 * generator; delayed copies ride forked tasks of the PUBLISHER's scope (a node that goes away
 * takes its unsent traffic with it, as on a real network). */
function* misdeliver(link: Memory.Link, chaos: Memory.Chaos, raw: TransportDef.Raw) {
  const { rules, random, counters } = chaos
  const targets = targetsOf(link, raw)

  for (const queue of targets) {
    if (random() < rules.dropRate) {
      counters.dropped += 1
      continue
    }

    const copies = random() < rules.duplicateRate ? 2 : 1
    counters.duplicated += copies - 1

    for (let copy = 0; copy < copies; copy += 1) {
      const delay = Math.floor(random() * rules.maxDelayMs)

      yield* fork(function* () {
        yield* sleep(delay)
        counters.delivered += 1
        queue.add(raw)
      })
    }
  }

  return targets.length + retain(link, raw)
}

/** Join (or create) a durable consumer as one pulling member; binds to the calling scope —
 * whatever the member took and did not ack goes back to the others when it leaves. */
function* subscribeDurable(
  state: Memory.State,
  pattern: string,
  name: string,
): Operation<TransportDef.RawSubscription> {
  const { link, prefix } = state
  const durable: Memory.Durable = link.durables.get(name) ?? {
    pattern,
    seq: 0,
    pending: [],
    inflight: new Map(),
    members: new Set(),
    cursor: 0,
  }

  link.durables.set(name, durable)
  const inbox = createQueue<Memory.Held, void>()
  const taken = new Set<number>()
  durable.members.add(inbox)

  yield* ensure(() => {
    durable.members.delete(inbox)
    inbox.close(undefined)
    // unacked work of a departing member returns to the front of the line, then everything
    // parked is offered to whoever is still pulling
    for (const seq of [...taken].toSorted((left, right) => right - left)) {
      const held = durable.inflight.get(seq)
      if (held) {
        durable.inflight.delete(seq)
        durable.pending.unshift(held)
      }
    }

    for (const held of durable.pending.splice(0)) {
      offer(durable, held)
    }
  })

  // what accumulated while nobody was pulling is handed out now
  for (const held of durable.pending.splice(0)) {
    offer(durable, held)
  }

  return {
    *next() {
      const step = yield* inbox.next()
      if (step.done) {
        return step
      }

      const held = step.value
      taken.add(held.seq)
      const settle = (): void => {
        taken.delete(held.seq)
        durable.inflight.delete(held.seq)
      }

      return {
        done: false as const,
        value: {
          ...held.raw,
          topic: unprefixed(prefix, held.raw.topic) ?? held.raw.topic,
          seq: String(held.seq),
          *ack() {
            settle()
          },
          *nak() {
            settle()
            offer(durable, held)
          },
        },
      }
    },
  }
}

/** The driver sees prefixed subjects; delivered topics come back application-relative. */
const relative = (prefix: string, raw: TransportDef.Raw): TransportDef.Raw => ({
  ...raw,
  topic: unprefixed(prefix, raw.topic) ?? raw.topic,
})

export const StateRef = createContext<Memory.State>('transport:impl/memory')

/** mulberry32 — a tiny seeded generator, good enough to make chaos reproducible. */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Deliver one raw message exactly, right now. Returns how many receivers took it. */
export const deliver = (link: Memory.Link, raw: TransportDef.Raw): number => {
  const targets = targetsOf(link, raw)

  for (const queue of targets) {
    queue.add(raw)
  }

  return targets.length + retain(link, raw)
}

export const driver: TransportDef.Driver = {
  capabilities: {
    durable: true,
    groups: true,
    requestReply: false,
    receipts: true,
    maxPayloadBytes: null,
  },

  *publish({ topic, data, headers }) {
    const state = yield* useContext(StateRef)

    if (state.status === 'closed') {
      return yield* fail(TransportErrors.Closed, 'memory transport drained')
    }

    if (state.maxPayloadBytes !== null && data.length > state.maxPayloadBytes) {
      return yield* fail(
        TransportErrors.PayloadTooLarge,
        `payload of ${data.length} bytes exceeds ${state.maxPayloadBytes}`,
      )
    }

    // copy the bytes: the in-process link must behave like a wire (no shared buffers)
    const raw = {
      topic: prefixed(state.prefix, topic),
      data: new Uint8Array(data),
      headers: { ...headers },
    }

    if (state.status === 'reconnecting') {
      state.outbox.push(raw)
      return null
    }

    const { chaos } = state.link

    return chaos ? yield* misdeliver(state.link, chaos, raw) : deliver(state.link, raw)
  },

  *subscribe(topic, options) {
    const state = yield* useContext(StateRef)
    const pattern = prefixed(state.prefix, topic)

    if (options.durable !== undefined) {
      return yield* subscribeDurable(state, pattern, prefixed(state.prefix, options.durable))
    }

    const queue = createQueue<TransportDef.Raw, void>()
    const subscriber: Memory.Subscriber = { pattern, group: options.group, queue }
    state.link.subscribers.add(subscriber)

    yield* ensure(() => {
      state.link.subscribers.delete(subscriber)
      queue.close(undefined)
    })

    return {
      *next() {
        const step = yield* queue.next()
        return step.done
          ? step
          : { done: false as const, value: relative(state.prefix, step.value) }
      },
    }
  },

  *payloadLimit() {
    return (yield* useContext(StateRef)).maxPayloadBytes
  },

  status: () => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      const queue = createQueue<TransportDef.Status, void>()

      queue.add(state.status)
      state.watchers.add(queue)

      yield* ensure(() => {
        state.watchers.delete(queue)
        queue.close(undefined)
      })

      return queue
    },
  }),

  *drain() {
    const state = yield* useContext(StateRef)
    state.status = 'closed'

    for (const watcher of state.watchers) {
      watcher.add('closed')
    }
  },
}
