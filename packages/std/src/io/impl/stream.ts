import type { Stream } from 'std:effect'
import { action, createSignal, each, operation, resource } from 'std:effect'
import type { ReadableLike, WritableLike } from 'std:io'
import { IO_TAGS } from 'std:io'
import { appendCauses, asFailure } from 'std:result'

import { createReadStream, createWriteStream } from 'node:fs'

const waitForFinish = (writable: WritableLike): ReturnType<typeof action<void>> =>
  action((resolve, reject) => {
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(appendCauses(asFailure(error), IO_TAGS.stream))
    }
    const cleanup = () => {
      writable.off('finish', onFinish)
      writable.off('error', onError)
    }
    writable.on('finish', onFinish)
    writable.on('error', onError)
    return cleanup
  }, IO_TAGS.stream)

const waitForDrain = (writable: WritableLike): ReturnType<typeof action<void>> =>
  action((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(appendCauses(asFailure(error), IO_TAGS.stream))
    }
    const cleanup = () => {
      writable.off('drain', onDrain)
      writable.off('error', onError)
    }
    writable.on('drain', onDrain)
    writable.on('error', onError)
    return cleanup
  }, IO_TAGS.stream)

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
      target.destroy?.()
    }
  })

export const readFileStream = (path: string): Stream<Uint8Array, void> =>
  fromReadable(createReadStream(path))

export const writeFileStream = operation(function* (
  path: string,
  source: Stream<Uint8Array, unknown>,
) {
  const writable = createWriteStream(path) as unknown as WritableLike

  try {
    for (const chunk of yield* each(source)) {
      const ok = writable.write(chunk)
      if (!ok) {
        yield* waitForDrain(writable)
      }
      yield* each.next()
    }
    writable.end()
    yield* waitForFinish(writable)
  } catch (error) {
    writable.destroy?.(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}, IO_TAGS.writeStream)
