import { TAG_MATCHERS } from '../const'
import type { Helpers } from '../types/helpers'

import { kebabToPascal } from './string'

/**
 * A module's tag bundle: every entry becomes a `PascalCase` key holding its dotted tag
 * (`createTags('std:io', 'not-found').NotFound === 'std:io.not-found'`). An entry given as
 * `[name, matcher]` also says which FOREIGN value (a thrown JS / platform / third-party error) that
 * tag stands for — `asFailure(value, bundle)` folds a matching value into it:
 *
 *   createTags('std:io',
 *     'unsupported',
 *     ['not-found', { code: 'ENOENT' }],
 *     ['access-denied', { code: ['EACCES', 'EPERM'] }],
 *     ['timeout', value => value instanceof DOMException && value.name === 'TimeoutError'],
 *   )
 */
export const createTags = <const T extends string | null, const U extends Helpers.TagEntry[]>(
  prefix: T,
  ...list: U
): Helpers.Tags<T, U> => {
  const result = {} as Record<string, string>
  const matchers: (readonly [string, Helpers.TagMatcher])[] = []

  for (const entry of list) {
    const [name, matcher] = typeof entry === 'string' ? [entry] : entry
    const tag = prefix ? `${prefix}.${name}` : name

    result[kebabToPascal(name)] = tag
    if (matcher) {
      matchers.push([tag, matcher])
    }
  }

  Object.defineProperty(result, TAG_MATCHERS, { value: Object.freeze(matchers) })

  return result as unknown as Helpers.Tags<T, U>
}
