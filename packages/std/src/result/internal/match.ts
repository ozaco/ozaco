import type { AnyType, Helpers } from 'std:shared'
import { TAG_MATCHERS } from 'std:shared'

/** A field of a foreign value (`code`, `name`, `message`): a throwing getter or proxy trap — or a
 * value that has no fields — reads as `undefined`, so classifying a value never throws. */
const fieldOf = (value: unknown, key: 'code' | 'name' | 'message'): unknown => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined
  }

  try {
    return (value as AnyType)[key] as unknown
  } catch {
    return undefined
  }
}

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** A foreign value's own text: its `message`, else its `code` (when a non-empty string). */
const ownTextOf = (value: unknown): string | undefined =>
  textOf(fieldOf(value, 'message')) ?? textOf(fieldOf(value, 'code'))

const oneOf = (expected: unknown, actual: unknown): boolean =>
  Array.isArray(expected) ? expected.includes(actual) : expected === actual

/** Whether `matcher` recognizes `value` — a function's string answer is the message too; a
 * throwing function is no match. */
const recognize = (matcher: Helpers.TagMatcher, value: unknown): boolean | string => {
  if (typeof matcher === 'function') {
    try {
      const verdict = matcher(value)

      return verdict === true || (typeof verdict === 'string' && verdict.length > 0 && verdict)
    } catch {
      return false
    }
  }

  if (matcher.code === undefined && matcher.name === undefined) {
    return false
  }

  return (
    (matcher.code === undefined || oneOf(matcher.code, fieldOf(value, 'code'))) &&
    (matcher.name === undefined || oneOf(matcher.name, fieldOf(value, 'name')))
  )
}

/** Whether `tags` is a `createTags` bundle (it carries matchers, maybe none). */
export const isTagSet = (tags: unknown): tags is Helpers.TagMatchers =>
  typeof tags === 'object' && tags !== null && TAG_MATCHERS in tags

/** The first matcher of `tags` (declaration order) that recognizes `value`: its tag, and the
 * message it named (else the value's own text, else `fallback`). */
export const matchOf = (
  value: unknown,
  tags: Helpers.TagMatchers,
  fallback: () => string,
): { tag: string; message: string } | undefined => {
  for (const [tag, matcher] of tags[TAG_MATCHERS]) {
    const verdict = recognize(matcher, value)

    if (verdict !== false) {
      const message = typeof verdict === 'string' ? verdict : (ownTextOf(value) ?? fallback())

      return { tag, message }
    }
  }

  return undefined
}
