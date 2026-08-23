import type { Spec } from 'db:core'

export namespace Memory {
  /** The whole in-memory backend: rows by table, the current column set per table (what
   * `introspect` reports) and the declared indexes. */

  export interface State {
    readonly tables: Map<string, Map<string, Spec.Doc>>

    /** column name → the kind it was created with (the memory "native type"). */
    readonly shapes: Map<string, Map<string, Spec.ColumnKind>>
    readonly indexes: Map<string, Map<string, Spec.Index>>
  }
}
