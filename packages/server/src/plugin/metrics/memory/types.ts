import type { MetricsStoreDef } from 'server:core'
import type { BoundLogger } from 'server:utils'

/** Store plumbing types — grouped (`Result.Failure` pattern); reach them as `MemoryStore.X`. */
export namespace MemoryStore {
  /** The setup-returned context: tables live here, NEVER module-global. */
  export interface Context {
    readonly tables: Map<string, MetricsStoreDef.Row[]>
    readonly log: BoundLogger
  }
}
