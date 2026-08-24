import type { Operation } from 'std:effect'
import { isFutureFlow, until } from 'std:effect'
import type { AnyType } from 'std:shared'

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

/**
 * A byte reply that reports consumption: the returned stream reads through the source, and
 * `HELD` settles when it closes, errors or is cancelled — the awaited call task waits on it.
 */
export const heldReadable = (source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  let settle: () => void = () => {}

  const held = new Promise<void>(resolve => {
    settle = resolve
  })

  const reader = source.getReader()

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const step = await reader.read().catch((error: unknown) => {
        controller.error(error)
        settle()
        return { done: true as const, value: undefined }
      })

      if (step.done) {
        if (controller.desiredSize !== null) {
          controller.close()
        }

        settle()
        return
      }

      controller.enqueue(step.value)
    },

    cancel: async reason => {
      settle()
      await reader.cancel(reason).catch(() => {})
    },
  })

  ;(wrapped as AnyType)[HELD] = held
  return wrapped
}
