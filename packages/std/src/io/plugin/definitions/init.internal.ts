import { createDefinition } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import { isBoolean } from 'std:shared'

import { IOErrors } from '../../const'
import type { Options } from '../../type'

import { context } from '../base'

import { detectRuntime } from '../internal/detect'

export const init = createDefinition(({ use }) => {
  const ctx = use(context)

  return (options?: Options) => {
    ctx.runtime = options?.runtime ?? ctx.runtime

    const detectedRuntime = detectRuntime()

    if (isBoolean(ctx.runtime)) {
      ctx.runtime = detectedRuntime
    } else if (ctx.runtime !== detectedRuntime) {
      unwrap(fail(IOErrors.unexpectedRuntime, `Expected: ${ctx.runtime} got: ${detectedRuntime}`))
    }
  }
})

export const getOptions = createDefinition(({ use }) => {
  const ctx = use(context)

  return () => ctx
}).key('getOptions')
