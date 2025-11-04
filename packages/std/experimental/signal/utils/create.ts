import { $fn, $safe, type Err, err, isErr, type ResultAsync } from 'std:result'
import { isPromise, unsafeIdGenerator } from 'std:shared'

import { SIGNAL } from '../const'
import { SIGNAL_ERRORS } from '../errors'
import type { Signal, SignalListener, SignalListenerFn, SignalSubscription } from '../types'

export const createSignal = <Payload = unknown>(name: string) => {
  const identifier = Symbol(name)
  const listeners = new Map<string, SignalListenerFn<Payload>>()
  const idGenerator = unsafeIdGenerator(`${name}#signal@`)

  const emit = $safe(function* (payload: Payload, throwOnError = true) {
    const promises: ResultAsync<void, string>[] = []

    for (const listener of listeners.values()) {
      const result = listener(payload)

      if (isPromise(result)) {
        promises.push(result)
      } else if (isErr(result)) {
        result._n = SIGNAL_ERRORS.ERR_SIGNAL_EMIT

        yield* result as Err<SIGNAL_ERRORS.ERR_SIGNAL_EMIT>
      }
    }

    // Wait for all async listeners to complete
    if (promises.length > 0) {
      Promise.all(promises).then(results => {
        const errors = results.filter(isErr)

        if (throwOnError && errors.length > 0) {
          // intentional unsafe throw to stop the execution
          throw errors
        }
      })
    }
  })

  const emitAsync = $safe(async function* (payload: Payload) {
    for (const listener of listeners.values()) {
      const result = await listener(payload)

      if (isErr(result)) {
        result._n = SIGNAL_ERRORS.ERR_SIGNAL_EMIT_ASYNC

        yield* result as Err<SIGNAL_ERRORS.ERR_SIGNAL_EMIT_ASYNC>
      }
    }
  })

  const subscribeFn = $safe(function* (listener: SignalListener<Payload>, cause?: string) {
    if (typeof listener !== 'function') {
      yield* err(SIGNAL_ERRORS.ERR_SIGNAL_SUBSCRIBE, 'Listener must be a function')
    }

    const tag = cause ?? idGenerator.next().value

    listeners.set(tag, $fn(listener, name, tag))

    const unsubscribeFn = $safe(function* () {
      const deleted = listeners.delete(tag)

      if (!deleted) {
        return yield* err(SIGNAL_ERRORS.ERR_SIGNAL_UNSUBSCRIBE, `Subscription with tag "${tag}" not found`, [
          name,
          tag,
        ])
      }
    })

    const subscription: SignalSubscription = {
      tag,
      unsubscribe: unsubscribeFn,
    }

    return subscription
  })

  const signal: Signal<Payload> = {
    _t: SIGNAL,
    _i: identifier,

    emit,
    emitAsync,
    subscribe: subscribeFn,

    clear: () => listeners.clear(),
    size: () => listeners.size,
  }

  return signal
}
