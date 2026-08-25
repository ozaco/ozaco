// oxlint-disable import/exports-last
import {
  attempt,
  createContext,
  createQueue,
  ensure,
  fork,
  sleep,
  until,
  useContext,
} from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { TransportDef } from 'transport:core'
import { isPattern, matchTopic, prefixed, TransportErrors, unprefixed } from 'transport:core'

import type { Redis } from './types'

export const StateRef = createContext<Redis.State>('transport:impl/redis')

const encoder = new TextEncoder()
const decoder = new TextDecoder()
/** How long one `XREADGROUP` blocks (bounds how fast a reader notices a halt / a claim round). */
const READ_BLOCK_MS = 500
/** Durable readers run `XAUTOCLAIM` every this many read rounds. */
const CLAIM_EVERY = 4
const STREAM = 'oz:stream:'
const GROUPS = 'oz:groups:'

// --- payload framing: Redis pub/sub has no headers, so they ride in front of the body --------
// [u32 BE header length][headers: `key=value` lines, URL-encoded][body]

const frame = (data: Uint8Array, headers: TransportDef.Headers): Uint8Array => {
  const text = Object.entries(headers)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('\n')
  const head = encoder.encode(text)
  const out = new Uint8Array(4 + head.length + data.length)

  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  out.set(data, 4 + head.length)

  return out
}

const unframe = (
  payload: Uint8Array,
): { data: Uint8Array; headers: Record<string, string> } | null => {
  if (payload.length < 4) {
    return null
  }

  const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0)
  if (4 + length > payload.length) {
    return null
  }

  const headers: Record<string, string> = {}
  const text = decoder.decode(payload.subarray(4, 4 + length))

  for (const line of text ? text.split('\n') : []) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      headers[decodeURIComponent(line.slice(0, eq))] = decodeURIComponent(line.slice(eq + 1))
    }
  }

  return { data: payload.subarray(4 + length), headers }
}

/** Our topic patterns → Redis glob patterns (`>` has no glob equivalent: widen and post-filter). */
const globOf = (pattern: string): string => pattern.replaceAll('>', '*')

const toBytes = (value: AnyType): Uint8Array =>
  value instanceof Uint8Array ? value : encoder.encode(String(value))

export const raise = function* (error: unknown) {
  return yield* fail(TransportErrors.Connection, String((error as AnyType)?.message ?? error))
}

/** Consumer groups — competing (`group`) and durable (`durable`) — ride a Redis Stream per
 * literal subject: `XGROUP CREATE … MKSTREAM` once, then an `XREADGROUP … >` loop per member.
 * A competing member acks on arrival (at-most-once); a durable member acks when the consumer
 * says so, `nak` hands the entry straight back, and `XAUTOCLAIM` steals what a dead member left
 * pending longer than `ackWaitMs`. */
function* subscribeGroup(
  state: Redis.State,
  member: { readonly subject: string; readonly group: string; readonly durable: boolean },
  queue: ReturnType<typeof createQueue<TransportDef.Raw, void>>,
) {
  const { subject, group, durable } = member
  const key = STREAM + subject
  const consumer = `${group}.${(yield* IO.actions.uuid()).slice(0, 8)}`

  yield* attempt(until(state.client.xGroupCreate(key, group, '$', { MKSTREAM: true })))
  yield* attempt(until(state.client.sAdd(GROUPS + subject, group)))

  const enqueue = (id: string, payload: { data: Uint8Array; headers: Record<string, string> }) => {
    const base = {
      topic: unprefixed(state.prefix, subject) ?? subject,
      data: payload.data,
      headers: payload.headers,
      seq: id,
    }

    if (!durable) {
      queue.add(base)
      return
    }

    queue.add({
      ...base,
      *ack() {
        yield* attempt(until(state.client.xAck(key, group, id)))
      },
      *nak() {
        // straight back to this member: still pending server-side, so a crash before the
        // retry is acked leaves it claimable by anyone
        enqueue(id, payload)
      },
    })
  }

  const deliver = function* (entries: readonly AnyType[]) {
    for (const entry of entries) {
      const payload = unframe(toBytes(entry.message.p))

      if (payload) {
        enqueue(String(entry.id), payload)
      }

      if (!durable || !payload) {
        yield* attempt(until(state.client.xAck(key, group, entry.id)))
      }
    }
  }

  const reader = state.client.duplicate()
  yield* attempt(until(reader.connect()))

  const task = yield* fork(function* () {
    let sinceClaim = 0

    for (;;) {
      if (durable && sinceClaim <= 0) {
        // what another member took and never acked (it died) becomes ours after ackWaitMs
        const claimed = yield* attempt(
          until(
            state.client.xAutoClaim(key, group, consumer, state.ackWaitMs, '0-0', {
              COUNT: 16,
            }) as Promise<AnyType>,
          ),
        )

        if (!isFailure(claimed)) {
          yield* deliver(claimed.value?.messages?.filter(Boolean) ?? [])
        }

        sinceClaim = CLAIM_EVERY
      }

      sinceClaim -= 1

      const read = yield* attempt(
        until(
          reader.xReadGroup(
            group,
            consumer,
            { key, id: '>' },
            { COUNT: 16, BLOCK: READ_BLOCK_MS },
          ) as Promise<AnyType>,
        ),
      )

      if (isFailure(read)) {
        yield* sleep(100)
        continue
      }

      for (const stream of read.value ?? []) {
        yield* deliver(stream.messages ?? [])
      }
    }
  })

  yield* ensure(function* () {
    yield* task.halt()
    yield* attempt(until(reader.disconnect()))
    queue.close(undefined)
  })
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
    if (state.drained || state.status === 'closed') {
      return yield* fail(TransportErrors.Closed, 'redis connection drained')
    }
    const subject = prefixed(state.prefix, topic)
    const payload = Buffer.from(frame(data, headers))

    // one round trip: the pub/sub fan-out AND whether any group/durable is registered on the
    // subject — no cache, so a durable created on another node a moment ago is never missed
    const published = yield* attempt(
      until(
        state.client
          .multi()
          .publish(subject, payload)
          .sCard(GROUPS + subject)
          .exec() as Promise<[number, number]>,
      ),
    )
    if (isFailure(published)) {
      return yield* raise(published.error)
    }

    const [listeners, groups] = published.value
    let receivers = Number(listeners)

    if (Number(groups) > 0) {
      const added = yield* attempt(
        until(
          state.client.xAdd(
            STREAM + subject,
            '*',
            { p: payload },
            { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: state.streamMaxLen } },
          ),
        ),
      )

      if (!isFailure(added)) {
        receivers += 1
      }
    }

    return receivers
  },

  *subscribe(topic, options) {
    const state = yield* useContext(StateRef)
    const queue = createQueue<TransportDef.Raw, void>()
    const subject = prefixed(state.prefix, topic)
    const name = options.durable ?? options.group

    if (name !== undefined) {
      if (isPattern(topic)) {
        return yield* fail(
          TransportErrors.Unsupported,
          `redis groups and durables need a literal topic, not "${topic}"`,
        )
      }

      yield* subscribeGroup(
        state,
        { subject, group: prefixed(state.prefix, name), durable: options.durable !== undefined },
        queue,
      )

      return queue
    }

    const listener = (message: AnyType, channel: AnyType) => {
      const heard = String(channel)
      const relative = unprefixed(state.prefix, heard)

      if (relative === null || !matchTopic(topic, relative)) {
        return
      }

      const payload = unframe(toBytes(message))

      if (payload) {
        queue.add({ topic: relative, data: payload.data, headers: payload.headers })
      }
    }

    const pattern = isPattern(topic)
    const opened = yield* attempt(
      until(
        pattern
          ? state.subscriber.pSubscribe(globOf(subject), listener, true)
          : state.subscriber.subscribe(subject, listener, true),
      ),
    )

    if (isFailure(opened)) {
      return yield* raise(opened.error)
    }

    yield* ensure(function* () {
      yield* attempt(
        until(
          pattern
            ? state.subscriber.pUnsubscribe(globOf(subject), listener, true)
            : state.subscriber.unsubscribe(subject, listener, true),
        ),
      )
      queue.close(undefined)
    })

    return queue
  },

  status: () => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      const queue = createQueue<TransportDef.Status, void>()
      queue.add(state.status)

      const onReady = () => queue.add('connected')
      const onReconnecting = () => queue.add('reconnecting')
      const onEnd = () => {
        queue.add('closed')
        queue.close(undefined)
      }

      state.client.on('ready', onReady)
      state.client.on('reconnecting', onReconnecting)
      state.client.on('end', onEnd)

      yield* ensure(() => {
        state.client.off('ready', onReady)
        state.client.off('reconnecting', onReconnecting)
        state.client.off('end', onEnd)
        queue.close(undefined)
      })
      return queue
    },
  }),

  *drain() {
    const state = yield* useContext(StateRef)
    if (state.drained) {
      return
    }

    state.drained = true
    state.status = 'closed'

    yield* attempt(until(state.subscriber.quit()))
    yield* attempt(until(state.client.quit()))
  },
}
