import { isFailure, isResult } from 'std:result'

import type { Helpers } from '../types/helpers'

interface NormalizedPayload {
  msg: string
  data: Record<string, unknown> | undefined
  error: string
}

export const normalizePayload = (args: readonly Helpers.LogPayload[]): NormalizedPayload => {
  let data: Record<string, unknown> | undefined
  let error = ''
  const messages: string[] = []

  for (const arg of args) {
    if (arg === undefined || arg === null) {
      continue
    }
    if (typeof arg === 'string') {
      messages.push(arg)
      continue
    }
    if (isResult(arg)) {
      if (isFailure(arg)) {
        const causes = arg.causes.length > 0 ? `: ${arg.causes.join(' > ')}` : ''
        const message = arg.message ? `: ${arg.message}` : ''
        error = `${String(arg.error)}${message}${causes}`
      }
      continue
    }
    if (typeof arg === 'object') {
      const record = arg as Record<string, unknown>
      data = data ? Object.assign(data, record) : record
    }
  }

  return { msg: messages.join(' '), data, error }
}
