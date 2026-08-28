/** HLC version tokens are 22 Crockford chars (see std:io `hlc`). */
const TOKEN_LENGTH = 22

/** Protocol subtype markers (`Db` / `DbAdapter` / `DbBus`). */
export const DATABASE = Symbol.for('db:db')
export const DATABASE_ADAPTER = Symbol.for('db:adapter')

/** Protocol subtype marker of the `Kv` store protocol. */
export const KV_STORE = Symbol.for('db:kv')

/** The key namespace a Kv install uses when none is given. */
export const DEFAULT_KV_PREFIX = 'kv'

/** The transport topic `DbBus` carries envelopes on (under the transport's prefix). */
export const DEFAULT_BUS_TOPIC = 'db.change'

/** Marker symbols for the schema DSL's runtime objects. */
export const COLUMN = Symbol.for('db:column')
export const TABLE = Symbol.for('db:table')

/** The system fields stamped on every stored document (never declared by the schema). */
export enum FIELDS {
  id = '_id',
  created = '_created_at',
  updated = '_updated_at',
  version = '_version',
}

/** The default keyset-pagination sort column. */
export const DEFAULT_ORDER = FIELDS.created

/** The `patch` clear sentinel: `db.patch(table, id, { field: CLEAR })` nulls an OPTIONAL column
 * (typed, unlike `null as never`); a required column rejects it like `null`. */
export const CLEAR: unique symbol = Symbol.for('db:clear')

/** The "unversioned" row/table token: the smallest token, decodes to time 0 / origin `00000000`.
 * DDL default of `_version`, and what `db.version(table)` reports before any change. */
export const VERSION_ZERO = '0'.repeat(TOKEN_LENGTH)

/** Name prefix of the hidden per-table change-log tables (`__changes_<table>`); `table()` names
 * starting with `__` are reserved for them. */
export const CHANGES_PREFIX = '__changes_'

/** Default `replayWindowMs`: how far back (by `ts`) a replay / `since` check re-scans the change
 * log to catch commits whose tokens are older than what was already applied. */
export const DEFAULT_REPLAY_WINDOW_MS = 5000

/** Outbox defaults. */
export const DEFAULT_MAX_PENDING = 4096
export const DEFAULT_DRAIN_TIMEOUT_MS = 1000

/** Declared TABLE names: snake_case, one optional leading underscore (framework tables). */
export const TABLE_NAME = /^_?[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u

/** Declared COLUMN names: snake_case, no underscore prefix (that namespace is the system's). */
export const COLUMN_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u
