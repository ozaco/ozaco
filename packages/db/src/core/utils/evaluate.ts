// oxlint-disable import/exports-last
import type { Spec } from '../types/spec'

/** Collapse a value to a comparable scalar (`Date` → epoch millis). */
const scalar = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value)

const isNil = (value: unknown): value is null | undefined => value === null || value === undefined

/** SQL-ish three-way compare; null when the pair is incomparable (type mismatch / nulls). */
const compareValues = (left: unknown, right: unknown): number | null => {
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

/** Sort a copy by the order spec — nulls last ascending, first descending (Postgres defaults). */
export const sortDocs = (rows: readonly Spec.Doc[], order: readonly Spec.OrderBy[]): Spec.Doc[] => {
  if (order.length === 0) {
    return [...rows]
  }

  return rows.toSorted((left, right) => {
    for (const entry of order) {
      const a = left[entry.field]
      const b = right[entry.field]
      const sign = entry.direction === 'desc' ? -1 : 1
      if (isNil(a) || isNil(b)) {
        if (isNil(a) && isNil(b)) {
          continue
        }
        return sign * (isNil(a) ? 1 : -1)
      }
      const rank = compareValues(a, b) ?? 0
      if (rank !== 0) {
        return sign * rank
      }
    }
    return 0
  })
}

const likeRegex = (pattern: string, insensitive: boolean): RegExp => {
  const escaped = pattern.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
  const source = `^${escaped.replaceAll('%', '.*').replaceAll('_', '.')}$`

  return new RegExp(source, insensitive ? 'iu' : 'u')
}

/** Three-way compare of `doc[field]` against the filter's value (null when incomparable). */
const ordered = (doc: Spec.Doc, filter: { field: string; value: Spec.FilterValue }) =>
  compareValues(doc[filter.field], filter.value)

/**
 * Evaluate the portable filter algebra against one document, with SQL null semantics (comparisons
 * against null are false; `eq(field, null)` behaves as IS NULL). The same evaluator backs the
 * memory adapter and the watch layer's query-aware wake-ups.
 */
export const matches = (doc: Spec.Doc, filter: Spec.Filter): boolean => {
  switch (filter.op) {
    case 'eq': {
      if (filter.value === null) {
        return isNil(doc[filter.field])
      }

      return ordered(doc, filter) === 0
    }

    case 'ne': {
      if (filter.value === null) {
        return !isNil(doc[filter.field])
      }

      const rank = ordered(doc, filter)

      return rank !== null && rank !== 0
    }

    case 'gt': {
      const rank = ordered(doc, filter)
      return rank !== null && rank > 0
    }

    case 'gte': {
      const rank = ordered(doc, filter)
      return rank !== null && rank >= 0
    }

    case 'lt': {
      const rank = ordered(doc, filter)
      return rank !== null && rank < 0
    }

    case 'lte': {
      const rank = ordered(doc, filter)
      return rank !== null && rank <= 0
    }

    case 'in': {
      return filter.values.some(value => compareValues(doc[filter.field], value) === 0)
    }

    case 'not-in': {
      const value = doc[filter.field]
      return !isNil(value) && !filter.values.some(entry => compareValues(value, entry) === 0)
    }

    case 'like': {
      const value = doc[filter.field]

      return (
        typeof value === 'string' &&
        likeRegex(filter.pattern, filter.insensitive ?? false).test(value)
      )
    }

    case 'is-null': {
      return isNil(doc[filter.field])
    }

    case 'not-null': {
      return !isNil(doc[filter.field])
    }

    case 'and': {
      return filter.filters.every(inner => matches(doc, inner))
    }

    case 'or': {
      return filter.filters.some(inner => matches(doc, inner))
    }

    case 'not': {
      return !matches(doc, filter.filter)
    }

    default: {
      return true
    }
  }
}
