import type { Flow } from 'std:effect'
import { action, each, operation } from 'std:effect'
import type { FlowClose, WritableLike } from 'std:io'
import { IO_FLAGS } from 'std:io'
import { appendCauses, asFailure } from 'std:result'
import { hasFlag } from 'std:shared'

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

export const readFileFlow = (path: string): Flow<Uint8Array, FlowClose> =>
  fromReadable(createReadStream(path))

export const writeFileFlow = operation(function* (
  path: string,
  source: Flow<Uint8Array, unknown>,
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

  // A persistent 'error' listener: createWriteStream opens asynchronously and can emit 'error' (EACCES
  // on open, ENOSPC mid-write) during the `each(source)` / `each.next()` await windows where the
  // transient waitForDrain/waitForFinish listeners are not attached. Without this, that 'error' is an
  // unhandled event and Node crashes the process. Capture the first one and surface it as a failure.
  let streamError: unknown
  writable.on('error', (error: unknown) => {
    streamError ??= error
  })

  try {
    for (const chunk of yield* each(source)) {
      if (streamError !== undefined) {
        yield* asFailure(streamError)
      }
      const ok = writable.write(chunk)
      if (!ok) {
        yield* waitForDrain(writable)
      }
      yield* each.next()
    }
    if (streamError !== undefined) {
      yield* asFailure(streamError)
    }
    writable.end()
    yield* waitForFinish(writable)
  } catch (error) {
    writable.destroy?.(error instanceof Error ? error : new Error(String(error)))

    yield* appendCauses(asFailure(error), 'write-stream')
  }
}, 'write-stream')
