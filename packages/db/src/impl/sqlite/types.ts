import type { Operation } from 'std:effect'

import type { Database } from 'bun:sqlite'

export namespace Sqlite {
  export interface Options {
    /** Database file path, `':memory:'` (default) for an ephemeral in-process database. */
    readonly path?: string | undefined
  }

  /** A minimal FIFO mutex: `acquire` resolves a release function once the lock is held. */
  export interface Lock {
    acquire(): Operation<() => void>
  }

  export interface State {
    readonly db: Database

    /** SQLite is one shared handle, so top-level transactions serialize on this. */
    readonly lock: Lock
  }
}
