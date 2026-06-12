import { operation } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'

import { AppErrors, BROKER_REGEX, TRANSPORT_REGEX } from '../const'

const isBoundary = (tag: string): boolean =>
  tag.match(TRANSPORT_REGEX) !== null || tag.match(BROKER_REGEX) !== null

const isInternalNoise = (tag: string): boolean =>
  tag.startsWith('logger@') || (tag.startsWith('server/') && !tag.startsWith('server/plugin-'))

const shortenCauses = (causes: string[]): string[] => {
  const out: string[] = []

  for (let i = 0; i < causes.length; i += 2) {
    const op = causes[i]!
    const tag = causes[i + 1]

    if (tag !== undefined && isInternalNoise(tag) && !isBoundary(tag)) {
      continue
    }

    out.push(op)
    if (tag !== undefined) {
      out.push(tag)
    }
  }

  return out
}

export type CleanupTypes = 'gateway'

export const cleanupErrors = operation(function* (
  type: CleanupTypes,
  failure: Result.Failure<unknown>,
) {
  if (type === 'gateway') {
    const shortened = shortenCauses(failure.causes)
    failure.causes.length = 0
    failure.causes.push(...shortened)
    return failure
  }

  return yield* fail('unexpected', `cleanup type: ${type}`)
}, AppErrors.Cleanup)
