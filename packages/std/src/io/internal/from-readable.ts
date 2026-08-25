import type { Flow } from 'std:effect'
import { createSignal, fork, resource, until } from 'std:effect'
import type { NodeReadableLike, ReadableLike, FlowClose } from 'std:io'
import { asFailure } from 'std:result'
import { isBoolean } from 'std:shared'

const isNodeReadable = (target: ReadableLike): target is NodeReadableLike =>
  typeof (target as NodeReadableLike).on === 'function'

/**
 * Adapt either a Node `Readable` (event-based) or a web `ReadableStreamDefaultReader`-like
 * (`read()`/`cancel()`/`releaseLock()`) into a `Flow<Uint8Array>`. Free of any `node:*` import so
 * it bundles for the browser (used by `WebIO`); the Node-specific file streams live in
 * `./flow.ts`. The close value is `true` on a clean end and the failure when the source errored
 * mid-stream — consumers must check it, or truncation is indistinguishable from completion.
 */
export const fromReadable = (
  target: ReadableLike,
  options: {
    destroy?: boolean
  } = {},
): Flow<Uint8Array, FlowClose> =>
  resource(function* (provide) {
    if (!isBoolean(options.destroy)) {
      options.destroy = true
    }

    const signal = createSignal<Uint8Array, FlowClose>()
    const subscription = yield* signal

    if (isNodeReadable(target)) {
      let settled = false

      const onData = (chunk: Buffer | Uint8Array) => {
        signal.send(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
      }

      const settle = (close: FlowClose) => {
        if (!settled) {
          settled = true
          signal.close(close)
        }
      }

      const onEnd = () => settle(true)
      const onClose = () => settle(true)
      const onError = (error: unknown) => settle(asFailure(error))

      target.on('data', onData)
      target.on('end', onEnd)
      target.on('close', onClose)
      target.on('error', onError)

      try {
        yield* provide(subscription)
      } finally {
        target.off('data', onData)
        target.off('end', onEnd)
        target.off('close', onClose)
        target.off('error', onError)

        if (options.destroy) {
          target.destroy?.()
        }
      }
      return
    }

    yield* fork(function* () {
      let close: FlowClose = true
      try {
        while (true) {
          const { done, value } = yield* until(target.read())
          if (done) {
            break
          }
          if (value) {
            signal.send(value instanceof Uint8Array ? value : new Uint8Array(value))
          }
        }
      } catch (error) {
        close = asFailure(error)
        throw error
      } finally {
        signal.close(close)

        if (options.destroy) {
          target.releaseLock()
        }
      }
    })

    try {
      yield* provide(subscription)
    } finally {
      if (options.destroy) {
        yield* until(target.cancel().catch(() => {}))
      }
    }
  })
