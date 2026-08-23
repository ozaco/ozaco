import { fork, withResolvers } from 'std:effect'
import { createEvent } from 'std:event'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { TransportErrors } from '../errors'
import { chunkedDriver } from '../internal/chunk'
import { encodeValue, toMessage } from '../internal/codec'
import { flowLane, pipeLane, readableLane, writableLane } from '../internal/lane'
import { requestPackage, servePackage } from '../internal/package'
import type { Helpers } from '../types/helpers'
import type { TransportDef } from '../types/transport'

import { namespaced } from './topic'

/** The contract members every backend shares verbatim (only the driver differs). */
/**
 * Assemble the five planes + lifecycle over a driver. Impls spread this into `build({...})`:
 * `Transport.implement({...}).build({ ...transportDefaults(), ...transportActions(driver) })`.
 * `driver` functions read the impl's own scope-bound state, so one factory call per impl module
 * serves every install of it.
 */
export const transportActions = (
  backend: TransportDef.Driver,
): Omit<TransportDef.Actions, 'describe'> => {
  const driver = chunkedDriver(backend)
  const runtime: Helpers.Runtime = { driver }

  /** Fail early when a subscribe option needs a capability the backend lacks; resolve the
   * consumer names under the subscription prefix. */
  const check = function* (options: TransportDef.SubscribeOptions) {
    if (options.group !== undefined && !driver.capabilities.groups) {
      return yield* fail(TransportErrors.Unsupported, 'this transport has no consumer groups')
    }
    if (options.durable !== undefined && !driver.capabilities.durable) {
      return yield* fail(TransportErrors.Unsupported, 'this transport has no durable subscriptions')
    }
    if (options.transient && options.durable !== undefined) {
      return yield* fail(TransportErrors.Unsupported, 'a transient subscription cannot be durable')
    }

    return {
      group: options.group === undefined ? undefined : namespaced(options.prefix, options.group),
      durable:
        options.durable === undefined ? undefined : namespaced(options.prefix, options.durable),
      transient: options.transient,
    } satisfies TransportDef.RawSubscribeOptions
  }

  const subscribe = <T>(
    topic: string,
    options?: TransportDef.SubscribeOptions,
  ): ReturnType<TransportDef.Actions['subscribe']> => ({
    *[Symbol.iterator]() {
      const raw = yield* driver.subscribe(topic, yield* check(options ?? {}))

      return {
        *next() {
          const step = yield* raw.next()

          if (step.done) {
            return { done: true as const, value: undefined }
          }

          return { done: false as const, value: yield* toMessage<T>(step.value) }
        },
      }
    },
  })

  return {
    *publish(topic, value, options) {
      const encoded = yield* encodeValue(value, options?.headers)

      yield* driver.publish({
        topic,
        data: encoded.data,
        headers: encoded.headers,
        transient: options?.transient,
      })
    },

    subscribe,

    *events(topic, options) {
      const emitter = createEvent<TransportDef.Events<AnyType>>()
      // subscribed inside the pump task: `stop()` halts it AND drops the subscription
      const ready = withResolvers<void>('events ready')

      const task = yield* fork(function* () {
        const subscription = yield* subscribe(topic, options)
        ready.resolve(undefined)

        for (;;) {
          const step = yield* subscription.next()
          if (step.done) {
            return
          }
          emitter.emit('message', step.value)
        }
      })

      yield* ready.operation
      return {
        emitter,
        *stop() {
          yield* task.halt()
        },
      }
    },

    *emit(topic, value) {
      const encoded = yield* encodeValue(value)
      yield* driver.publish({ topic, data: encoded.data, headers: encoded.headers })
    },
    flow: (topic, options) => flowLane(runtime, topic, options),
    *pipe(topic, source, options) {
      return yield* pipeLane(runtime, { topic, source, options })
    },
    *readable(topic, options) {
      return yield* readableLane(runtime, topic, options)
    },
    *writable(topic, options) {
      return yield* writableLane(runtime, topic, options)
    },
    *request(topic, args, options) {
      return yield* requestPackage(runtime, { topic, args, options })
    },
    *serve(topic, handler, options) {
      const { group } = yield* check({ group: options?.group, prefix: options?.prefix })
      return yield* servePackage(runtime, { topic, handler, group })
    },

    status: () => driver.status(),
    *drain() {
      yield* driver.drain()
    },
  } as Omit<TransportDef.Actions, 'describe'>
}
