import type { Result } from '../types/result'

import { levelOf, walk } from './chain'

const INDENT = '    '

/**
 * The Java-style rendering of a failure's chain — one level per failure, depth first: a failure
 * and its string causes (`    at <cause>`), then each failure it wraps as a `Caused by:` level.
 * Every level and every cause, nothing cut; a failure met again (a cycle, one shared twice) is
 * rendered once.
 */
export const renderChain = (failure: Result.Failure<unknown>): string => {
  const lines: string[] = []

  for (const [index, nested] of walk(failure).entries()) {
    const { type, message, causes } = levelOf(nested)
    const head = message ? `${type}: ${message}` : type

    lines.push(index === 0 ? head : `Caused by: ${head}`)

    for (const cause of causes) {
      lines.push(`${INDENT}at ${cause}`)
    }
  }

  return lines.join('\n')
}
