import type { FileHandle as FSFileHandle } from 'node:fs/promises'

import type { Impl } from 'std:io'
import { FSError, IOErrors, Runtime, readDefinition } from 'std:io'
import { guard, throwable } from 'std:result'

export const readImplementation = readDefinition.extend(
  (): Impl.Read<FSError | IOErrors.unsupported> => {
    return guard(
      async function* (file, arrayBuffer, options) {
        const view = new Uint8Array(arrayBuffer)

        const fileHandle = file.meta.node as FSFileHandle

        const offset = options?.offset ?? 0
        const length = options?.length ?? view.byteLength - offset
        const position = options?.position ?? offset

        const { bytesRead } = yield* await throwable(
          () =>
            fileHandle.read(view, {
              offset,
              length,
              position,
            }),
          FSError,
        )

        return bytesRead
      },
      IOErrors.read,
      Runtime.bun,
    )
  },
)
