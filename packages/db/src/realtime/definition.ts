// oxlint-disable import/exports-last
import type { DatabasePool } from 'db:core'
import { usePool } from 'db:core'
import type { Future } from 'std:effect'
import { createContext, operation, spawn, useContext } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { bridgeChangeBus, createRealtimeDatabase } from './database'
import type { BusHolder } from './database'
import type { MigrationMode, MigrationPlan } from './migrate'
import { applySchema, planSchema } from './migrate'
import { schemaFrom } from './schema/define'
import type { SchemaDef, TableDef } from './schema/types'
import type { ChangeBus, Database } from './types'

/** The realtime DB protocol context — the Convex-style {@link Database} an install resolves. */
export type DBContext = Database

export interface DBActions extends Record<string, AnyType> {
  close(): Future<void>
  /** Run the schema reconcile now (the `migrations: 'manual'` entry point). Respects `safe`. */
  migrate(): Future<void>
  /** Compute the pending reconcile without applying it — a manual-migration preview. */
  planMigration(): Future<MigrationPlan>
  /** Whether a cross-node {@link ChangeBus} is already attached. */
  hasBus(): Future<boolean>
  /** Attach a cross-node {@link ChangeBus} and start bridging foreign writes into `changes`. Idempotent
   * — a no-op returning `false` if one is already attached. The server calls this automatically with a
   * Broker-backed bus when resources mount, so multi-node reactivity needs no app wiring. */
  connectBus(bus: ChangeBus): Future<boolean>
}

export const DB = defineProtocol<DBContext, [unknown], DBActions>({
  name: 'db-realtime',
  version: '0.0.1',
  subtype: Symbol.for('db:realtime:protocol'),
})

/** Config for {@link RealtimeDb}: the tables to manage and the migration policy. The pool itself is
 * resolved via `usePool()` from an installed driver + `Pool` — install a driver and the pool first
 * (`install(SqliteDriver)` → `install(Pool, …)`), then `RealtimeDb`. */
export interface RealtimeDbConfig {
  readonly tables: readonly TableDef[]
  readonly migrations?: MigrationMode
  readonly safe?: boolean
  /** Cross-node fan-out transport. Omit for a single-node deployment (the default in-memory signal
   * suffices). Supply a {@link ChangeBus} (Redis / NATS / Postgres `LISTEN`-`NOTIFY`) so a write on any
   * node reaches every node's watchers — the plugin bridges foreign events into `changes` at install. */
  readonly bus?: ChangeBus
}

interface RealtimeState {
  readonly pool: DatabasePool
  readonly schema: SchemaDef
  readonly safe: boolean
  readonly db: Database
  readonly busHolder: BusHolder
}

const StateRef = createContext<RealtimeState>('db:realtime:state')

const closeAction = operation(function* () {
  // The pool's lifecycle is owned by the installed core pool plugin (`Pool`); closing `RealtimeDb`
  // does not end it. Nothing to tear down here.
})

const migrateAction = operation(function* () {
  const state = yield* useContext(StateRef)
  yield* applySchema(state.pool, state.schema, { allowDestructive: !state.safe })
})

const planAction = operation(function* () {
  const state = yield* useContext(StateRef)
  return yield* planSchema(state.pool, state.schema)
})

const hasBusAction = operation(function* () {
  return (yield* useContext(StateRef)).busHolder.current !== undefined
})

const connectBusAction = operation(function* (bus: ChangeBus) {
  const state = yield* useContext(StateRef)
  if (state.busHolder.current) {
    return false
  }
  state.busHolder.current = bus
  yield* spawn(() => bridgeChangeBus(state.db.changes, bus))
  return true
})

/**
 * The realtime database plugin — installs a Convex-style {@link Database} on top of an already-installed
 * core `@ozaco/db` pool (resolved via `usePool()`). The concrete backend (pg / Bun SQL / SQLite /
 * surreal) is chosen by which pool plugin you install. `migrations: 'auto'` (default) reconciles the
 * schema at install; `'manual'` defers to `DB.actions.migrate()`.
 */
export const RealtimeDb = DB.implement({
  name: 'realtime',
  version: '0.0.1',
  *setup(config: RealtimeDbConfig) {
    const pool = yield* usePool()
    const schema = schemaFrom(config.tables)
    const safe = config.safe ?? false
    const busHolder: BusHolder = {}
    const db = createRealtimeDatabase(pool, schema, busHolder)
    yield* StateRef.set({ pool, schema, safe, db, busHolder })
    if ((config.migrations ?? 'auto') === 'auto') {
      yield* applySchema(pool, schema, { allowDestructive: !safe })
    }
    const bus = config.bus
    if (bus) {
      // Explicit bus: attach it and forward remote nodes' writes into `changes` for the app's lifetime.
      busHolder.current = bus
      yield* spawn(() => bridgeChangeBus(db.changes, bus))
    }
    return db
  },
}).build({
  close: closeAction,
  migrate: migrateAction,
  planMigration: planAction,
  hasBus: hasBusAction,
  connectBus: connectBusAction,
})
