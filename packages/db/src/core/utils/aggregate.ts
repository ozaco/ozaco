// oxlint-disable import/exports-last
import type { Spec } from '../types/spec'

const compare = (left: unknown, right: unknown): number => {
  const a = left instanceof Date ? left.getTime() : left
  const b = right instanceof Date ? right.getTime() : right

  if (a === b) {
    return 0
  }

  return (a as never) < (b as never) ? -1 : 1
}

const fold = (rows: readonly Spec.Doc[], op: Spec.AggregateOp): unknown => {
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

/**
 * Group the matching rows and fold each group — the in-memory answer to `Spec.Aggregate`, for
 * adapters whose backend cannot aggregate (the memory adapter, a KV-backed store…): hand it the
 * FILTERED rows and the spec, get back one row per group carrying the grouped columns plus every
 * op under its `as` name (`sum` of nothing is `0`, `avg`/`min`/`max` of nothing `null`).
 */
export function aggregateDocs(
  rows: readonly Spec.Doc[],
  spec: Spec.Aggregate,
): readonly Spec.Doc[] {
  const answer = (group: readonly Spec.Doc[], key: Spec.Doc): Spec.Doc => {
    const out: Spec.Doc = { ...key }

    for (const op of spec.ops) {
      out[op.as] = fold(group, op)
    }

    return out
  }

  if (spec.groupBy.length === 0) {
    return [answer(rows, {})]
  }

  const groups = new Map<string, { key: Spec.Doc; rows: Spec.Doc[] }>()

  for (const row of rows) {
    const key: Spec.Doc = {}

    for (const field of spec.groupBy) {
      key[field] = row[field] ?? null
    }

    const id = spec.groupBy.map(field => String(key[field])).join('\u0000')
    const bucket = groups.get(id)

    if (bucket) {
      bucket.rows.push(row)
    } else {
      groups.set(id, { key, rows: [row] })
    }
  }

  return [...groups.values()].map(bucket => answer(bucket.rows, bucket.key))
}
