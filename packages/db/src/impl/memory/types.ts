import type { Spec } from 'db:core'
import type { Operation } from 'std:effect'

export namespace Memory {
  /** The whole in-memory backend: rows by table, the current column set per table (what
   * `introspect` reports) and the declared indexes. */

  export interface State {
    readonly tables: Map<string, Map<string, Spec.Doc>>

    /** column name → the kind it was created with (the memory "native type"). */
    readonly shapes: Map<string, Map<string, Spec.ColumnKind>>
    readonly indexes: Map<string, Map<string, Spec.Index>>

    /** top-level transactions run one at a time: a rollback restores a snapshot, which must
     * never wipe what a CONCURRENT transaction wrote meanwhile. */
    readonly lock: Lock
  }

  export interface Lock {
    acquire(): Operation<() => void>
  }
}
