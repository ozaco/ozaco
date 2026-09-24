/**
 * `@ozaco/db/adapter-kit` — everything a THIRD-PARTY `DbAdapter` is assembled from, as one
 * stable surface: the capability-gated defaults, and the in-memory evaluators for whatever the
 * backend cannot do natively (the portable filter algebra, the order spec, the aggregate plane).
 * Pair it with `@ozaco/db/testing`'s `runAdapterSuite` to prove the adapter conforms.
 *
 * ```ts
 * import { DbAdapter } from '@ozaco/db'
 * import { adapterDefaults, aggregateDocs, matches, sortDocs } from '@ozaco/db/adapter-kit'
 *
 * export const MyAdapter = DbAdapter.implement({ … }).build({
 *   ...adapterDefaults('mine'),
 *   *aggregate(spec) { return aggregateDocs(yield* rowsMatching(spec), spec) },
 *   …
 * })
 * ```
 */
export { FIELDS, VERSION_ZERO } from './core/const'
export { adapterDefaults } from './core/utils/adapter'
export { aggregateDocs } from './core/utils/aggregate'
export { matches, sortDocs } from './core/utils/evaluate'
export { filterFields, filterPaths, isPathSegment } from './core/utils/filter'
export { isDestructive, isSystemField } from './core/utils/is'
export { tableSpecOf } from './core/utils/schema'

export type { Adapter } from './core/types/adapter'
export type { Spec } from './core/types/spec'
