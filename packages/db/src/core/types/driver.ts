import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { DriverConnection, ResolvedClientConfiguration } from './common'

/** The driver protocol as a plugin type — a backend. `setup()` returns {@link DriverDef.Info}; the
 * `connect`/`end` actions hand out physical connections and tear the backend down. */
export type DriverDef = Plugin<DriverDef.Info, [DriverDef.Options?], DriverDef.Actions>

export namespace DriverDef {
  /** Backend metadata a driver's `setup()` returns (the protocol context). */
  export interface Info {
    readonly dialect: 'postgres' | 'surreal'
  }

  /** Per-driver install options (e.g. SurrealDB's namespace/database); generic at the protocol level. */
  export type Options = unknown

  export interface Actions {
    /** Open a fresh physical connection using the resolved client configuration. */
    connect(config: ResolvedClientConfiguration): Future<DriverConnection>
    /** Tear the backend (and any shared handle/pool/socket) down. */
    end(): Future<void>
  }
}
