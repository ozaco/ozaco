import type { Stream } from 'std:effect'
import { createSignal, resource } from 'std:effect'
import type { ReadableLike } from 'std:io'
import { IO_TAGS } from 'std:io'
import { appendCauses, asFailure } from 'std:result'

export const fromReadable = (target: ReadableLike): Stream<Uint8Array, void> =>
  resource(function* (provide) {
    const signal = createSignal<Uint8Array, void>()

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
        throw appendCauses(asFailure(error), IO_TAGS.stream)
      }
    }

    target.on('data', onData)
    target.on('end', onEnd)
    target.on('close', onClose)
    target.on('error', onError)

    try {
      yield* provide(yield* signal)
    } finally {
      target.off('data', onData)
      target.off('end', onEnd)
      target.off('close', onClose)
      target.off('error', onError)
    }
  })
