import { open as fsOpenAsync } from 'node:fs/promises'

import { type Api, FSError } from 'std:io'
import { guard, throwable } from 'std:result'
import { toFsFlag } from './internal/utils'

export const bunFileToNode = guard(async function* (file: Api.File) {
  if (file.meta.bun && !file.meta.node) {
    file.meta.node = yield* await throwable(() => fsOpenAsync(file.handle.assembled, toFsFlag(file.flag)), FSError)
  }

  return file
})
