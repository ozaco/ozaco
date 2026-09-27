import { fold } from '../internal/aggregate'
import type { Spec } from '../types/spec'

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
