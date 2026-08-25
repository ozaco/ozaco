// oxlint-disable import/exports-last
import { attempt, createContext, createQueue, ensure, fork, until, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Consumer, ConsumerConfig, JsMsg } from '@nats-io/jetstream'
import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream'
import type { Msg, MsgHdrs } from '@nats-io/nats-core'
import {
  nanos,
  headers as natsHeaders,
  NoRespondersError,
  RequestError,
  TimeoutError,
} from '@nats-io/nats-core'
import type { TransportDef } from 'transport:core'
import { HEADERS, prefixed, TransportErrors, unprefixed } from 'transport:core'

import type { Nats } from './types'

export const StateRef = createContext<Nats.State>('transport:impl/nats')

/** The msgID dedupe window (capped so memory streams stay small on long max ages). */
const DEDUPE_CAP_MS = 120_000
/** Messages a consume loop may hold client-side. */
const PREFETCH = 64
/** Transient (request/reply) traffic lives OUTSIDE the stream, under this root. */
const RPC_ROOT = '_rpc'

/** Stream names admit no dots, spaces or wildcards: `shop.eu` → `SHOP_EU`. */
export const streamNameOf = (prefix: string): string =>
  prefix.toUpperCase().replaceAll(/[^A-Z0-9_-]/gu, '_')

/** Consumer names have the same rules (`billing.main` → `billing_main`). */
const consumerNameOf = (name: string): string => name.replaceAll(/[.*>\s/\\]/gu, '_')

const rpcSubject = (prefix: string, topic: string): string => `${RPC_ROOT}.${prefix}.${topic}`

const toNatsHeaders = (headers: TransportDef.Headers): MsgHdrs => {
  const out = natsHeaders()
  for (const [key, value] of Object.entries(headers)) {
    out.set(key, value)
  }
  return out
}

const headersOf = (source: MsgHdrs | undefined): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (source) {
    for (const key of source.keys()) {
      headers[key] = source.last(key)
    }
  }
  return headers
}

/** Lift a core (transient) message to the driver's raw shape; the reply subject rides the
 * `oz-reply` header so core's package plane answers it through a transient publish. */
const toRaw = (prefix: string, msg: Msg): TransportDef.Raw => {
  const headers = headersOf(msg.headers)
  if (msg.reply) {
    headers[HEADERS.reply] = msg.reply
  }
  return {
    topic: unprefixed(`${RPC_ROOT}.${prefix}`, msg.subject) ?? msg.subject,
    data: msg.data,
    headers,
  }
}

/** Lift a JetStream message; durable deliveries carry ack/nak, everything else is acked on
 * arrival (at-most-once, like plain pub/sub). */
const toJsRaw = (prefix: string, msg: JsMsg, durable: boolean): TransportDef.Raw => {
  const base = {
    topic: unprefixed(prefix, msg.subject) ?? msg.subject,
    data: msg.data,
    headers: headersOf(msg.headers),
    seq: String(msg.seq),
  }
  if (!durable) {
    msg.ack()
    return base
  }
  return {
    ...base,
    *ack() {
      msg.ack()
    },
    *nak() {
      msg.nak()
    },
  }
}

/** Classify a thrown client error into a transport failure. */
export const raise = function* (error: unknown) {
  const cause = error instanceof RequestError ? (error.cause ?? error) : error

  if (
    cause instanceof NoRespondersError ||
    (error instanceof RequestError && error.isNoResponders())
  ) {
    return yield* fail(
      TransportErrors.NoResponders,
      `no responders on "${(cause as AnyType).subject ?? ''}"`,
    )
  }

  if (cause instanceof TimeoutError) {
    return yield* fail(TransportErrors.Timeout, 'nats request timed out')
  }

  return yield* fail(TransportErrors.Connection, String((error as AnyType)?.message ?? error))
}

/** Create-or-update the application's stream: `add` wins on first boot and on identical config;
 * drift falls to `update`. */
export function* ensureStream(state: Pick<Nats.State, 'jsm'>, spec: Nats.StreamSpec) {
  const added = yield* attempt(until(state.jsm.streams.add(spec)))

  if (!isFailure(added)) {
    return
  }

  const updated = yield* attempt(until(state.jsm.streams.update(spec.name, spec as AnyType)))

  if (isFailure(updated)) {
    return yield* fail(
      TransportErrors.Configuration,
      `stream "${spec.name}" could not be provisioned: ${String((updated.error as AnyType)?.message ?? updated.error)}`,
    )
  }
}

/** The stream spec for an application prefix. */
export const streamSpecOf = (options: {
  readonly prefix: string
  readonly storage: 'file' | 'memory'
  readonly maxAgeMs: number
  readonly maxBytes?: number | undefined
  readonly maxMsgs?: number | undefined
  readonly replicas: number
}): Nats.StreamSpec => ({
  name: streamNameOf(options.prefix),
  subjects: [`${options.prefix}.>`],
  retention: RetentionPolicy.Limits,
  storage: options.storage === 'memory' ? StorageType.Memory : StorageType.File,
  num_replicas: Math.max(1, options.replicas),
  max_age: nanos(options.maxAgeMs),
  duplicate_window: nanos(Math.min(options.maxAgeMs, DEDUPE_CAP_MS)),
  ...(options.maxBytes === undefined ? {} : { max_bytes: options.maxBytes }),
  ...(options.maxMsgs === undefined ? {} : { max_msgs: options.maxMsgs }),
})

/** A named consumer (durable, or a group's shared ephemeral one): add, or update on drift. */
function* ensureConsumer(state: Nats.State, config: Partial<ConsumerConfig>) {
  const added = yield* attempt(until(state.jsm.consumers.add(state.stream, config)))

  if (!isFailure(added)) {
    return
  }

  const name = config.durable_name ?? config.name!
  const updated = yield* attempt(until(state.jsm.consumers.update(state.stream, name, config)))

  if (isFailure(updated)) {
    return yield* fail(
      TransportErrors.Configuration,
      `consumer "${name}" could not be ensured: ${String((updated.error as AnyType)?.message ?? updated.error)}`,
    )
  }
}

/** Pump a JetStream consumer into a scope-bound raw queue. */
function* consumeInto(state: Nats.State, consumer: Consumer, durable: boolean) {
  const queue = createQueue<TransportDef.Raw, void>()
  const started = yield* attempt(until(consumer.consume({ max_messages: PREFETCH })))

  if (isFailure(started)) {
    return yield* raise(started.error)
  }

  const messages = started.value
  const iterator = messages[Symbol.asyncIterator]()

  yield* fork(function* () {
    for (;;) {
      const step = yield* attempt(until(iterator.next() as Promise<IteratorResult<JsMsg>>))
      if (isFailure(step) || step.value.done) {
        queue.close(undefined)
        return
      }
      queue.add(toJsRaw(state.prefix, step.value.value, durable))
    }
  })

  yield* ensure(() => {
    messages.stop()
    queue.close(undefined)
  })

  return queue
}

/** Transient traffic: a plain core subscription under `_rpc.<prefix>` (queue group optional). */
function* subscribeTransient(state: Nats.State, topic: string, group: string | undefined) {
  const queue = createQueue<TransportDef.Raw, void>()
  const sub = state.nc.subscribe(rpcSubject(state.prefix, topic), {
    ...(group === undefined ? {} : { queue: group }),
    callback: (error, msg) => {
      if (error) {
        queue.close(undefined)
        return
      }

      queue.add(toRaw(state.prefix, msg))
    },
  })

  yield* ensure(function* () {
    sub.unsubscribe()
    queue.close(undefined)
    // …and the UNSUB likewise: once `stop()` resolves the server must already answer
    // `no-responders` for this subject, not route one more request into the void
    if (!state.nc.isClosed()) {
      yield* attempt(until(state.nc.flush()))
    }
  })

  // the SUB is only an intent until the server has seen it: flush so a request from another
  // connection right after `serve` resolves cannot slip past us
  yield* attempt(until(state.nc.flush()))
  return queue
}

export const driver: TransportDef.Driver = {
  capabilities: {
    durable: true,
    groups: true,
    requestReply: true,
    receipts: false,
    maxPayloadBytes: null,
  },

  *publish({ topic, data, headers, transient, reply }) {
    const state = yield* useContext(StateRef)
    if (state.drained || state.nc.isClosed()) {
      return yield* fail(TransportErrors.Closed, 'nats connection drained')
    }

    const max = state.nc.info?.max_payload
    if (typeof max === 'number' && data.length > max) {
      return yield* fail(
        TransportErrors.PayloadTooLarge,
        `payload of ${data.length} bytes exceeds ${max}`,
      )
    }

    if (transient) {
      // core NATS, never stored: a reply goes to the absolute subject the server handed the
      // requester; anything else transient (cancels, emulated inboxes) lives under `_rpc`
      try {
        state.nc.publish(reply ? topic : rpcSubject(state.prefix, topic), data, {
          headers: toNatsHeaders(headers),
        })
      } catch (error) {
        return yield* raise(error)
      }
      return null
    }

    const published = yield* attempt(
      until(
        state.js.publish(prefixed(state.prefix, topic), data, {
          headers: toNatsHeaders(headers),
        }),
      ),
    )

    if (isFailure(published)) {
      return yield* raise(published.error)
    }

    return null
  },

  *subscribe(topic, options) {
    const state = yield* useContext(StateRef)
    if (options.transient) {
      return yield* subscribeTransient(state, topic, options.group)
    }

    const subject = prefixed(state.prefix, topic)
    const name = options.durable ?? options.group

    if (name === undefined) {
      // plain: an ordered ephemeral consumer from "now" — pub/sub semantics over the stream
      const consumer = yield* attempt(
        until(
          state.js.consumers.get(state.stream, {
            filter_subjects: subject,
            deliver_policy: DeliverPolicy.New,
            inactive_threshold: nanos(state.inactiveThresholdMs),
          }),
        ),
      )

      if (isFailure(consumer)) {
        return yield* raise(consumer.error)
      }

      return yield* consumeInto(state, consumer.value, false)
    }

    const durable = options.durable !== undefined
    const consumerName = consumerNameOf(name)

    yield* ensureConsumer(state, {
      ...(durable
        ? { durable_name: consumerName, max_deliver: state.maxDeliver }
        : { name: consumerName, inactive_threshold: nanos(state.inactiveThresholdMs) }),
      filter_subject: subject,
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(state.ackWaitMs),
      deliver_policy: DeliverPolicy.New,
      replay_policy: ReplayPolicy.Instant,
    })

    const consumer = yield* attempt(until(state.js.consumers.get(state.stream, consumerName)))
    if (isFailure(consumer)) {
      return yield* raise(consumer.error)
    }

    return yield* consumeInto(state, consumer.value, durable)
  },

  *request({ topic, data, headers, timeoutMs }) {
    const state = yield* useContext(StateRef)
    if (state.drained || state.nc.isClosed()) {
      return yield* fail(TransportErrors.Closed, 'nats connection drained')
    }

    const outcome = yield* attempt(
      until(
        state.nc.request(rpcSubject(state.prefix, topic), data, {
          timeout: timeoutMs,
          headers: toNatsHeaders(headers),
        }),
      ),
    )

    if (isFailure(outcome)) {
      return yield* raise(outcome.error)
    }

    return toRaw(state.prefix, outcome.value)
  },

  *payloadLimit() {
    const state = yield* useContext(StateRef)
    return state.nc.info?.max_payload ?? null
  },

  status: () => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      const queue = createQueue<TransportDef.Status, void>()

      queue.add(state.nc.isClosed() ? 'closed' : 'connected')
      const iterator = state.nc.status()[Symbol.asyncIterator]()

      yield* fork(function* () {
        for (;;) {
          const step = yield* attempt(until(iterator.next()))

          if (isFailure(step) || step.value.done) {
            queue.close(undefined)
            return
          }

          switch (step.value.value.type) {
            case 'disconnect':
            case 'reconnecting': {
              queue.add('reconnecting')
              break
            }
            case 'reconnect': {
              queue.add('connected')
              break
            }
            case 'close': {
              queue.add('closed')
              queue.close(undefined)
              return
            }
            default: {
              break
            }
          }
        }
      })

      yield* ensure(() => {
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
    yield* attempt(until(state.nc.drain()))
  },
}
