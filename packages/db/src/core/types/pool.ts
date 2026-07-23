import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { ClientConfiguration, DatabasePool } from './common'

/** The pool protocol as a plugin type. Context is the {@link DatabasePool} an install resolves;
 * `close` tears it down. */
export type PoolDef = Plugin<PoolDef.Context, [PoolDef.Config], PoolDef.Actions>

export namespace PoolDef {
  export type Context = DatabasePool
  /** Pool configuration — the full {@link ClientConfiguration} (the backend comes from the installed
   * driver plugin, not a factory field). */
  export type Config = ClientConfiguration
  export interface Actions {
    close(): Future<void>
  }
}
