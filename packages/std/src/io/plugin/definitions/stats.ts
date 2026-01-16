import { createDefinition } from 'std:plugin'
import { fail, guard, throwable } from 'std:result'

import { FSError, IOErrors, Runtime } from '../../const'

import { context } from '../base'

import { importFs } from '../internal/imports'

export const stats = createDefinition(({ use }) => {
  const ctx = use(context)

  return guard(async function* (path: string) {
    switch (ctx.runtime) {
      case Runtime.bun:
      case Runtime.node: {
        const fs = yield* await importFs()

        return throwable(() => fs.stat(path), FSError)
      }
    }

    return fail(IOErrors.unsupported, `stats operation is not supported on runtime: ${ctx.runtime}`)
  }, IOErrors.stats)
}).key('stats')
