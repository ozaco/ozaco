// oxlint-disable import/exports-last
import { usePool } from 'db:core'
import { createContext, operation, spawn, useContext } from 'std:effect'
import { defineProtocol } from 'std:plugin'

import { bridgeChangeBus, createRealtimeDatabase } from './impl/database'
import { applySchema, planSchema } from './impl/migrate'
import { schemaFrom } from './schema/define'
import type { BusHolder, ChangeBus } from './types/change'
import type { DBActions, DBContext, RealtimeState, RealtimeDbConfig } from './types/database'

export const DB = defineProtocol<DBContext, [unknown], DBActions>({
  name: 'db-realtime',
  version: '0.0.1',
  subtype: Symbol.for('db:realtime:protocol'),
})

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
