import type { Spec } from 'db:core'

/** The shapes the shared SQL layer passes around inside itself. */
export namespace Helpers {
  /** A leaf of the filter algebra (no `and` / `or` / `not`) — what a json-path predicate is. */
  export type PathLeaf = Exclude<Spec.Filter, { readonly op: 'and' | 'or' | 'not' }>
}
