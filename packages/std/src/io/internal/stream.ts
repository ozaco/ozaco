import type { Stream } from 'std:effect'
import { action, each, operation } from 'std:effect'
import type { WritableLike } from 'std:io'
import { hasFlag, IO_FLAGS } from 'std:io'
import { appendCauses, asFailure } from 'std:result'

import { createReadStream, createWriteStream } from 'node:fs'

import { fromReadable } from './from-readable'

const waitForFinish = (writable: WritableLike): ReturnType<typeof action<void>> =>
  action((resolve, reject) => {
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(appendCauses(asFailure(error), 'stream'))
    }
    const cleanup = () => {
      writable.off('finish', onFinish)
      writable.off('error', onError)
    }
    writable.on('finish', onFinish)
    writable.on('error', onError)
    return cleanup
  }, 'stream')

const waitForDrain = (writable: WritableLike): ReturnType<typeof action<void>> =>
  action((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(appendCauses(asFailure(error), 'stream'))
    }
    const cleanup = () => {
      writable.off('drain', onDrain)
      writable.off('error', onError)
    }
    writable.on('drain', onDrain)
    writable.on('error', onError)
    return cleanup
  }, 'stream')

export const readFileStream = (path: string): Stream<Uint8Array, void> =>
  fromReadable(createReadStream(path))

export const writeFileStream = operation(function* (
  path: string,
  source: Stream<Uint8Array, unknown>,
  flags?: number,
) {
  const f = flags ?? IO_FLAGS.NONE
  const fsFlags = hasFlag(f, IO_FLAGS.APPEND)
    ? hasFlag(f, IO_FLAGS.EXCLUSIVE)
      ? 'ax'
      : 'a'
    : hasFlag(f, IO_FLAGS.EXCLUSIVE)
      ? 'wx'
      : 'w'
  const writable = createWriteStream(path, { flags: fsFlags }) as unknown as WritableLike

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

    yield* appendCauses(asFailure(error), 'write-stream')
  }
}, 'write-stream')

export { fromReadable }
