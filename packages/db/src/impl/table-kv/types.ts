import type { KvDef, Spec } from 'db:core'
import type { Operation } from 'std:effect'

export namespace TableKvDef {
  export interface Options extends KvDef.CommonOptions {
    /** The table the entries live in (tags in `<table>_tags`). Default `_kv`. Both are declared
     * without a change log, so an application `DbClient` on the same adapter never sees them as
     * its own leftovers. */
    readonly table?: string | undefined
  }

  /** Serialize `get`-modify-`set` cycles (`incr`) inside this process. */
  export interface Lock {
    acquire(): Operation<() => void>
  }

  export interface State {
    readonly entries: Spec.Table
    readonly tags: Spec.Table
    readonly lock: Lock
  }
}
