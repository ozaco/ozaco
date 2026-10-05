import { createContext, createQueue, ensure, useContext } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import type { TransportDef } from 'transport:core'
import { prefixed, TransportErrors, unprefixed } from 'transport:core'

import type { Zmq } from '../types/zmq'

import { CMD } from './const'
import { empty, parseHeaders } from './wire'
import { str, text } from './zmtp'

export const StateRef = createContext<Zmq.State>('transport:impl/zmq')

/** Flip an install's status and tell its watchers (`watchStatus` logs the transitions). */
export const setStatus = (state: Zmq.State, status: TransportDef.Status): void => {
  if (state.status === status) {
    return
  }

  state.status = status

  for (const watcher of state.watchers) {
    watcher.add(status)
  }
}

/** The zmq driver: every plane is a hub command over the install's peer — subjects go up
 * namespaced by the application prefix (`<prefix>.<topic>`; group and durable names too, so
 * two applications on one hub never share a consumer), deliveries come back relative. */
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

    if (state.drained) {
      return yield* fail(TransportErrors.Closed, 'zmq connection drained')
    }

    const [count] = yield* state.peer.call([
      text(CMD.pub),
      text(prefixed(state.prefix, topic)),
      text(JSON.stringify(headers)),
      data,
    ])

    return count === undefined || count.length === 0 ? null : Number(str(count))
  },

  *subscribe(topic, options) {
    const state = yield* useContext(StateRef)

    if (state.drained) {
      return yield* fail(TransportErrors.Closed, 'zmq connection drained')
    }

    const sid = yield* IO.actions.uuid()
    const queue = createQueue<Uint8Array[], void>()
    const named = (name: string | undefined) =>
      name === undefined ? '' : prefixed(state.prefix, name)
    const announce = [
      text(CMD.sub),
      text(sid),
      text(prefixed(state.prefix, topic)),
      text(named(options.group)),
      text(named(options.durable)),
    ]

    state.peer.subscriptions.set(sid, { queue, announce })

    yield* ensure(function* () {
      state.peer.subscriptions.delete(sid)
      queue.close(undefined)
      yield* state.peer.cast([text(CMD.unsub), text(sid)])
    })

    yield* state.peer.call(announce)

    const durable = options.durable !== undefined
    const settle = (verb: CMD, seq: string) =>
      function* () {
        yield* state.peer.cast([text(verb), text(sid), text(seq)])
      }

    return {
      *next() {
        const step = yield* queue.next()

        if (step.done) {
          return step
        }

        const [subject, seq, headers, data] = step.value
        const heard = str(subject)
        const id = str(seq)

        return {
          done: false as const,
          value: {
            topic: unprefixed(state.prefix, heard) ?? heard,
            data: data ?? empty(),
            headers: parseHeaders(headers),
            ...(id === '' ? {} : { seq: id }),
            ...(durable && id !== '' ? { ack: settle(CMD.ack, id), nak: settle(CMD.nak, id) } : {}),
          },
        }
      },
    }
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

    if (state.drained) {
      return
    }

    state.drained = true
    yield* state.peer.close()
    setStatus(state, 'closed')
  },
}
