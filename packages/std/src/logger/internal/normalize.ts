import { isFailure, isResult } from 'std:result'

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
        const causes = arg.causes.length > 0 ? `: ${arg.causes.join(' > ')}` : ''
        const message = arg.message ? `: ${arg.message}` : ''
        error = `${String(arg.error)}${message}${causes}`
        // fully consumed — falling through would spread the failure's internals into `data`
        continue
      }
      arg = arg.value
    }

    if (typeof arg === 'string') {
      messages.push(arg)
      continue
    }
    if (typeof arg === 'object') {
      const record = arg as Record<string, unknown>
      data = data ? { ...data, ...record } : { ...record }
    }
  }

  return { msg: messages.join(' '), data, error }
}
