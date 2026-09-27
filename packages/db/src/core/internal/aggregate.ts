import type { Spec } from '../types/spec'

const compare = (left: unknown, right: unknown): number => {
  const a = left instanceof Date ? left.getTime() : left
  const b = right instanceof Date ? right.getTime() : right

  if (a === b) {
    return 0
  }

  return (a as never) < (b as never) ? -1 : 1
}

/** One aggregate op over a group's rows (`sum` of nothing is `0`, `avg`/`min`/`max` of nothing
 * `null`). */
export const fold = (rows: readonly Spec.Doc[], op: Spec.AggregateOp): unknown => {
  if (op.kind === 'count') {
    return rows.length
  }

  const values = rows
    .map(row => row[op.field!])
    .filter(value => value !== null && value !== undefined)

  if (values.length === 0) {
    return op.kind === 'sum' ? 0 : null
  }

  switch (op.kind) {
    case 'sum': {
      return values.reduce<number>((total, value) => total + Number(value), 0)
    }

    case 'avg': {
      return values.reduce<number>((total, value) => total + Number(value), 0) / values.length
    }

    case 'min': {
      return values.reduce((best, value) => (compare(value, best) < 0 ? value : best))
    }

    default: {
      return values.reduce((best, value) => (compare(value, best) > 0 ? value : best))
    }
  }
}
