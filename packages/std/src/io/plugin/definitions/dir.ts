import { createDefinition } from 'std:plugin'
import { guard, isFailure, throwable } from 'std:result'

import { FSError, IOErrors } from '../../const'

import { importFs } from '../internal/imports'

import { stats as statsDef } from './stats'

export const dir = createDefinition(({ use }) => {
  const exists = guard(async function* (path: string) {
    const stats = yield* await use(statsDef)(path)

    return stats.isDirectory()
  }, IOErrors.dirExists)

  const create = guard(async function* (
    path: string,
    options?: {
      recursive?: boolean
    },
  ) {
    const existsResult = await exists(path)

    if (isFailure(existsResult) || !existsResult.value) {
      const fs = yield* await importFs()

      yield* await throwable(
        () =>
          fs.mkdir(path, {
            recursive: options?.recursive ?? false,
          }),
        FSError,
      )
    }

    return true as const
  }, IOErrors.dirCreate)

  return {
    exists,
    create,
  }
}).key('dir')
