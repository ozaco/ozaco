import type { Operation } from 'std:effect'

import type { Database } from 'bun:sqlite'

export namespace Sqlite {
  export interface Options {
    /** Database file path, `':memory:'` (default) for an ephemeral in-process database. */
    readonly path?: string | undefined

    /** WAL journal mode (file databases): readers never block the writer and the writer never
     * blocks readers — the mode another process's reads can't fail your writes in. Persisted
     * on the file. Default true. */
    readonly wal?: boolean | undefined

    /** How long a write WAITS for a competing connection's lock before `db.conflict` — writes
     * queue instead of failing the moment someone else holds the file. Default 5000. */
    readonly busyTimeoutMs?: number | undefined
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
