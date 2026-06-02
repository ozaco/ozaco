import type { Stream } from 'std:effect'
import { createSignal, resource, spawn, until } from 'std:effect'
import type { NodeReadableLike, ReadableLike } from 'std:io'
import { appendCauses, asFailure } from 'std:result'

const isNodeReadable = (target: ReadableLike): target is NodeReadableLike =>
  typeof (target as NodeReadableLike).on === 'function'

/**
 * Adapt either a Node `Readable` (event-based) or a web `ReadableStreamDefaultReader`-like
 * (`read()`/`cancel()`/`releaseLock()`) into a `Stream<Uint8Array>`. Free of any `node:*` import so
 * it bundles for the browser (used by `WebIO`); the Node-specific file streams live in
 * `./stream.ts`.
 */
export const fromReadable = (target: ReadableLike): Stream<Uint8Array, void> =>
  resource(function* (provide) {
    const signal = createSignal<Uint8Array, void>()
    const subscription = yield* signal

    if (isNodeReadable(target)) {
      let ended = false

      const onData = (chunk: Buffer | Uint8Array) => {
        signal.send(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
      }

      const onEnd = () => {
        ended = true
        signal.close()
      }

      const onClose = () => {
        if (!ended) {
          ended = true
          signal.close()
        }
      }

      const onError = (error: Error & { code?: string }) => {
        if (error.code === 'EPIPE') {
          onClose()
        } else {
          throw appendCauses(asFailure(error), 'stream')
        }
      }

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
      } finally {
        signal.close()
        target.releaseLock()
      }
    })

    try {
      yield* provide(subscription)
    } finally {
      yield* until(target.cancel().catch(() => {}))
    }
  })
