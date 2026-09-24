import { formatFailure, isFailure, isResult } from 'std:result'
import { isObject } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { LoggerDef } from '../types/logger'

export const normalizePayload = (args: readonly LoggerDef.Payload[]): Helpers.NormalizedPayload => {
  let data: Record<string, unknown> | undefined
  let error = ''
  const messages: string[] = []

  for (const rawArg of args) {
    let arg: unknown = rawArg

    if (arg === undefined || arg === null) {
      continue
    }

    if (isResult(arg)) {
      if (isFailure(arg)) {
        error = formatFailure(arg)
        // fully consumed — falling through would spread the failure's internals into `data`
        continue
      }
      arg = arg.value
    }

    if (typeof arg === 'string') {
      messages.push(arg)
      continue
    }
    if (Array.isArray(arg)) {
      // an array is a VALUE, not fields: it joins the message as JSON text rather than spreading
      // its indexes into `data` (plain data only — no codec needed for this)
      messages.push(JSON.stringify(arg))
      continue
    }
    if (isObject(arg)) {
      data = data ? { ...data, ...arg } : { ...arg }
    }
  }

  return { msg: messages.join(' '), data, error }
}
