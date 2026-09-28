import type { Operation } from 'std:effect'
import { isFutureFlow, until } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'

/** `value[HELD]`: a promise the value settles once it is fully consumed (byte streams). */
export const HELD: unique symbol = Symbol('client:held')

/** The hold operation of a stream reply: a FutureFlow holds on `done`, bytes on {@link HELD}. */
export const holdOf = (value: unknown): Operation<void> | null => {
  if (isFutureFlow(value)) {
    return value.done
  }

  const held = (value as AnyType)?.[HELD] as Promise<void> | undefined

  return held ? until(held) : null
}

/** Whether `value` is already a held byte stream (a second hold would only add a layer). */
export const isHeld = (value: unknown): boolean =>
  typeof (value as AnyType)?.[HELD]?.then === 'function'

/**
 * A byte reply that reports consumption: the returned stream reads through the source, and
 * `HELD` settles when it closes, errors or is cancelled — the awaited call task waits on it.
 * `hooks` hear the first read and how it settled (once each): a traced call ends its span there.
 */
export const heldReadable = (
  source: ReadableStream<Uint8Array>,
  hooks: Helpers.HeldHooks = {},
): ReadableStream<Uint8Array> => {
  let started = false
  let release: () => void = () => {}
  let settled = false

  const held = new Promise<void>(resolve => {
    release = resolve
  })

  const settle = (outcome: Helpers.HeldOutcome) => {
    if (settled) {
      return
    }

    settled = true
    release()
    hooks.settle?.(outcome)
  }

  const reader = source.getReader()

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true
        hooks.start?.()
      }

      let failed = false

      const step = await reader.read().catch((error: unknown) => {
        failed = true
        controller.error(error)
        settle({ error })

        return { done: true as const, value: undefined }
      })

      if (failed) {
        return
      }

      if (step.done) {
        if (controller.desiredSize !== null) {
          controller.close()
        }

        settle({})

        return
      }

      controller.enqueue(step.value)
    },

    cancel: async reason => {
      settle({ cancelled: true })
      await reader.cancel(reason).catch(() => {})
    },
  })

  ;(wrapped as AnyType)[HELD] = held

  return wrapped
}
