import type { FileHandle as FSFileHandle } from 'node:fs/promises'
import { type Api, FSError, FSFlags, type Impl, type IOErrors, isHandle } from 'std:io'
import { guard, throwable } from 'std:result'
import { write as writeDefinition } from '../../plugin'

import { open as openDefinition } from '../node/open'

export const write = writeDefinition.extend(({ use }): Impl.Write<FSError | IOErrors.unsupported> => {
  const openApi = use(openDefinition)

  return guard(async function* (rawFile, arrayBuffer, options) {
    let file: Api.File
    if (typeof rawFile === 'string' || isHandle(rawFile)) {
      file = yield* await openApi(rawFile, FSFlags.write)
    } else {
      file = rawFile
    }
    const view = new Uint8Array(arrayBuffer)
    const fileHandle = file.raw as FSFileHandle
    const offset = options?.offset ?? 0
    const length = options?.length ?? view.byteLength - offset
    const position = options?.position ?? offset

    const { bytesWritten } = yield* await throwable(
      () =>
        fileHandle.write(view, {
          offset,
          length,
          position,
        }),
      FSError,
    )
    return bytesWritten
  })
})
