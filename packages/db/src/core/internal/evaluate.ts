import type { Spec } from '../types/spec'

/** Collapse a value to a comparable scalar (`Date` → epoch millis). */
const scalar = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value)

/** A character matched literally inside a regex. */
const literal = (char: string): string => char.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)

/** `null` or `undefined` — SQL's NULL. */
export const isNil = (value: unknown): value is null | undefined =>
  value === null || value === undefined

/** SQL-ish three-way compare; null when the pair is incomparable (type mismatch / nulls). */
export const compareValues = (left: unknown, right: unknown): number | null => {
  const a = scalar(left)
  const b = scalar(right)

  if (isNil(a) || isNil(b)) {
    return null
  }

  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0
  }

  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b)
  }

  return null
}

/** SQL `LIKE` as a regex — `%`/`_` wildcards, `\` escaping the next character (what the SQL
 * adapters pin with `ESCAPE '\'`), `%` spanning newlines like the backends do. */
export const likeRegex = (pattern: string, insensitive: boolean): RegExp => {
  let source = '^'

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!

    if (char === '\\' && index + 1 < pattern.length) {
      index += 1
      source += literal(pattern[index]!)
    } else if (char === '%') {
      source += String.raw`[\s\S]*`
    } else if (char === '_') {
      source += String.raw`[\s\S]`
    } else {
      source += literal(char)
    }
  }

  return new RegExp(`${source}$`, insensitive ? 'iu' : 'u')
}

/** The value a leaf filter addresses: the column, or — with a `path` — the value at that path
 * inside the (json) column (`undefined` once the walk leaves an object/array). */
export const read = (
  doc: Spec.Doc,
  filter: { readonly field: string; readonly path?: readonly Spec.PathSegment[] | undefined },
): unknown => {
  let value: unknown = doc[filter.field]

  for (const segment of filter.path ?? []) {
    if (typeof value !== 'object' || value === null || value instanceof Date) {
      return undefined
    }

    value = (value as Record<string, unknown>)[segment]
  }

  return value
}

/** Three-way compare of the addressed value against the filter's value (null when
 * incomparable). */
export const ordered = (
  doc: Spec.Doc,
  filter: {
    readonly field: string
    readonly path?: readonly Spec.PathSegment[] | undefined
    readonly value: Spec.FilterValue
  },
) => compareValues(read(doc, filter), filter.value)
