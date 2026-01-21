import type { FileHandle as FSFileHandle } from 'node:fs/promises'

import type { Api, Impl } from 'std:io'
import { FSError, IOErrors, isHandle, Runtime, read as readDefinition } from 'std:io'
import { guard, throwable } from 'std:result'

import { open as openDefinition } from '../node/open'

export const read = readDefinition.extend(({ use }): Impl.Read<FSError | IOErrors.unsupported> => {
  const openApi = use(openDefinition)

  return guard(
    async function* (rawFile, arrayBuffer, options) {
      let file: Api.File

      if (typeof rawFile === 'string' || isHandle(rawFile)) {
        file = yield* await openApi(rawFile)
      } else {
        file = rawFile
      }

      const view = new Uint8Array(arrayBuffer)

      const fileHandle = file.raw as FSFileHandle

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
})
