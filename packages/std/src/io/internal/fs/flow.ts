import type { Flow } from 'std:effect'
import { action, each, guard } from 'std:effect'
import { IO_FLAGS } from 'std:io'
import { appendCauses, asFailure } from 'std:result'
import { hasFlag } from 'std:shared'

import { createReadStream, createWriteStream } from 'node:fs'

import { IOCauses } from '../../errors'
import type { IODef } from '../../types/io'
import { fromReadable } from '../stream/from-readable'

const waitForFinish = (writable: IODef.WritableLike): ReturnType<typeof action<void>> =>
  action((resolve, reject) => {
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(appendCauses(asFailure(error), IOCauses.Stream))
    }
    const cleanup = () => {
      writable.off('finish', onFinish)
      writable.off('error', onError)
    }
    writable.on('finish', onFinish)
    writable.on('error', onError)
    return cleanup
  }, IOCauses.Stream)

const waitForDrain = (writable: IODef.WritableLike): ReturnType<typeof action<void>> =>
  action((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(appendCauses(asFailure(error), IOCauses.Stream))
    }
    const cleanup = () => {
      writable.off('drain', onDrain)
      writable.off('error', onError)
    }
    writable.on('drain', onDrain)
    writable.on('error', onError)
    return cleanup
  }, IOCauses.Stream)

export const readFileFlow = (path: string): Flow<Uint8Array, IODef.FlowClose> =>
  fromReadable(createReadStream(path))

export const writeFileFlow = guard(function* (
  path: string,
  source: Flow<Uint8Array, unknown>,
  flags?: number,
) {
  const f = flags ?? IO_FLAGS.none
  const fsFlags = hasFlag(f, IO_FLAGS.append)
    ? hasFlag(f, IO_FLAGS.exclusive)
      ? 'ax'
      : 'a'
    : hasFlag(f, IO_FLAGS.exclusive)
      ? 'wx'
      : 'w'
  const writable = createWriteStream(path, { flags: fsFlags }) as unknown as IODef.WritableLike

  // A persistent 'error' listener: createWriteStream opens asynchronously and can emit 'error' (EACCES
  // on open, ENOSPC mid-write) during the `each(source)` / `each.next()` await windows where the
  // transient waitForDrain/waitForFinish listeners are not attached. Without this, that 'error' is an
  // unhandled event and Node crashes the process. Capture the first one and surface it as a failure.
  let streamError: unknown
  writable.on('error', (error: unknown) => {
    streamError ??= error
  })

  try {
    // `each` honors the IODef.FlowClose contract: a source closing with a Failure raises it here, so a
    // truncated upstream can never be sealed into the file as success
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

    yield* appendCauses(asFailure(error), IOCauses.WriteStream)
  }
}, IOCauses.WriteStream)
