import { compareValues, isNil, likeRegex, ordered, read } from '../internal/evaluate'
import type { Spec } from '../types/spec'

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

/**
 * Evaluate the portable filter algebra against one document, with SQL null semantics (comparisons
 * against null are false; `eq(field, null)` behaves as IS NULL). The same evaluator backs the
 * memory adapter and the watch layer's query-aware wake-ups.
 */
export const matches = (doc: Spec.Doc, filter: Spec.Filter): boolean => {
  switch (filter.op) {
    case 'eq': {
      if (filter.value === null) {
        return isNil(read(doc, filter))
      }

      return ordered(doc, filter) === 0
    }

    case 'ne': {
      if (filter.value === null) {
        return !isNil(read(doc, filter))
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
      return filter.value.some(value => compareValues(read(doc, filter), value) === 0)
    }

    case 'not-in': {
      const value = read(doc, filter)

      return !isNil(value) && !filter.value.some(entry => compareValues(value, entry) === 0)
    }

    case 'like': {
      const value = read(doc, filter)

      return (
        typeof value === 'string' &&
        likeRegex(filter.pattern, filter.insensitive ?? false).test(value)
      )
    }

    case 'is-null': {
      return isNil(read(doc, filter))
    }

    case 'not-null': {
      return !isNil(read(doc, filter))
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
