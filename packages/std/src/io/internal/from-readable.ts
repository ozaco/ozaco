import type { Stream } from 'std:effect'
import { createSignal, resource, spawn, until } from 'std:effect'
import type { NodeReadableLike, ReadableLike, StreamClose } from 'std:io'
import { asFailure } from 'std:result'

const isNodeReadable = (target: ReadableLike): target is NodeReadableLike =>
  typeof (target as NodeReadableLike).on === 'function'

/**
 * Adapt either a Node `Readable` (event-based) or a web `ReadableStreamDefaultReader`-like
 * (`read()`/`cancel()`/`releaseLock()`) into a `Stream<Uint8Array>`. Free of any `node:*` import so
 * it bundles for the browser (used by `WebIO`); the Node-specific file streams live in
 * `./stream.ts`. The close value is `true` on a clean end and the failure when the source errored
 * mid-stream — consumers must check it, or truncation is indistinguishable from completion.
 */
export const fromReadable = (target: ReadableLike): Stream<Uint8Array, StreamClose> =>
  resource(function* (provide) {
    const signal = createSignal<Uint8Array, StreamClose>()
    const subscription = yield* signal

    if (isNodeReadable(target)) {
      let settled = false

      const onData = (chunk: Buffer | Uint8Array) => {
        signal.send(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
      }

      const settle = (close: StreamClose) => {
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
        target.destroy?.()
      }
      return
    }

    yield* spawn(function* () {
      let close: StreamClose = true
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
        target.releaseLock()
      }
    })

    try {
      yield* provide(subscription)
    } finally {
      yield* until(target.cancel().catch(() => {}))
    }
  })
