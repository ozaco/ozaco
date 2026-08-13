// oxlint-disable import/exports-last
import type { Doc, Filter } from '../types'

/** Collapse a value to a comparable scalar (`Date` → epoch millis). */
const scalar = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value)

/** SQL-ish three-way compare; null when the pair is incomparable (type mismatch / nulls). */
export const compareValues = (left: unknown, right: unknown): number | null => {
  const a = scalar(left)
  const b = scalar(right)
  if (a === null || a === undefined || b === null || b === undefined) {
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

const likeRegex = (pattern: string, insensitive: boolean): RegExp => {
  const escaped = pattern.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
  const source = `^${escaped.replaceAll('%', '.*').replaceAll('_', '.')}$`
  return new RegExp(source, insensitive ? 'iu' : 'u')
}

/**
 * Evaluate the portable filter algebra against one document, with SQL null semantics (comparisons
 * against null are false; `eq(field, null)` behaves as IS NULL). The same evaluator backs the
 * memory adapter and the watch layer's query-aware wake-ups.
 */
export const matches = (doc: Doc, filter: Filter): boolean => {
  switch (filter.op) {
    case 'eq': {
      const value = doc[filter.field]
      if (filter.value === null) {
        return value === null || value === undefined
      }
      return compareValues(value, filter.value) === 0
    }
    case 'ne': {
      const value = doc[filter.field]
      if (filter.value === null) {
        return value !== null && value !== undefined
      }
      const order = compareValues(value, filter.value)
      return order !== null && order !== 0
    }
    case 'gt': {
      const order = compareValues(doc[filter.field], filter.value)
      return order !== null && order > 0
    }
    case 'gte': {
      const order = compareValues(doc[filter.field], filter.value)
      return order !== null && order >= 0
    }
    case 'lt': {
      const order = compareValues(doc[filter.field], filter.value)
      return order !== null && order < 0
    }
    case 'lte': {
      const order = compareValues(doc[filter.field], filter.value)
      return order !== null && order <= 0
    }
    case 'in': {
      return filter.values.some(value => compareValues(doc[filter.field], value) === 0)
    }
    case 'not-in': {
      const value = doc[filter.field]
      if (value === null || value === undefined) {
        return false
      }
      return !filter.values.some(entry => compareValues(value, entry) === 0)
    }
    case 'like': {
      const value = doc[filter.field]
      return (
        typeof value === 'string' &&
        likeRegex(filter.pattern, filter.insensitive ?? false).test(value)
      )
    }
    case 'is-null': {
      const value = doc[filter.field]
      return value === null || value === undefined
    }
    case 'not-null': {
      const value = doc[filter.field]
      return value !== null && value !== undefined
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
