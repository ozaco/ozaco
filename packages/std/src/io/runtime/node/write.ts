import type { FileHandle as FSFileHandle } from 'node:fs/promises'

import { FSError, type Impl, IOErrors, Runtime } from 'std:io'
import { guard, throwable } from 'std:result'

import { writeDefinition } from '../../plugin'

export const writeImplementation = writeDefinition.extend((): Impl.Write<FSError | IOErrors.unsupported> => {
  return guard(
    async function* (file, arrayBuffer, options) {
      const view = new Uint8Array(arrayBuffer)
      const fileHandle = file.meta.node as FSFileHandle

      const offset = options?.offset ?? 0
      const length = options?.length ?? view.byteLength - offset
      const position = options?.position ?? null

      const { bytesWritten } = yield* await throwable(() => fileHandle.write(view, offset, length, position), FSError)

      return bytesWritten
    },
    IOErrors.write,
    Runtime.node,
  )
})
