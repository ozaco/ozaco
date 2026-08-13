// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { createContext, fork, operation, useContext } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbAdapter } from './adapter'
import { DbErrors } from './errors'
import { createDatabase } from './internal/database'
import type { Hub } from './internal/hub'
import { bridgeBus, createHub, pumpLive } from './internal/hub'
import { applyPlan, planMigration } from './internal/migrate'
import { schemaFrom, tableSpecOf } from './schema/table'
import type { ChangeBus, Database, DbDef, SchemaFrom, TableDef, TableSpec } from './types'

/**
 * The app-facing database protocol. Install an adapter, then {@link DbClient}; resolve the typed
 * {@link Database} handle anywhere with {@link useDb}. `Db.actions` carries the management plane
 * (migrations, imperative DDL, bus wiring, the `raw` escape hatch).
 */
const DbProtocol = defineProtocol<DbDef.Context, DbDef.Actions>({
  name: 'db',
  version: '0.1.0',
  description: 'Reactive, adapter-agnostic database plugin',
})

export const Db = DbProtocol

interface DbState {
  readonly specs: ReadonlyMap<string, TableSpec>
  readonly safe: boolean
  readonly hub: Hub
  readonly database: Database
}

const StateRef = createContext<DbState>('db:state')

const attachBus = operation(function* (state: DbState, bus: ChangeBus) {
  if (!state.hub.setBus(bus)) {
    return false
  }
  // subscribe HERE, then fork the drain — a forked subscribe races the first send
  const subscription = yield* bus.events
  yield* fork(() => bridgeBus(state.hub, bus.origin, subscription))
  return true
})

const DbClientImpl = DbProtocol.implement<DbDef.Context, [options: DbDef.Options]>({
  name: 'db-client',
  version: '0.1.0',
  description: 'The reactive database engine over the installed adapter',
  *setup(options) {
    const info = yield* DbAdapter.context.get()
    if (!info) {
      return yield* fail(
        DbErrors.Configuration,
        'no db adapter installed — install a db:impl/* adapter before DbClient',
      )
    }
    const schema = schemaFrom(options.tables)
    const specs = new Map(options.tables.map(def => [def.name, tableSpecOf(def)]))
    const safe = options.safe ?? false

    if ((options.migrations ?? 'auto') === 'auto') {
      const plan = yield* planMigration([...specs.values()])
      yield* applyPlan(plan, { safe })
    }
    // open the native feed FIRST: only a feed that actually opened may own the change stream —
    // deciding on the capability alone would silence local emission with nothing replacing it
    const feed = info.capabilities.live ? yield* DbAdapter.actions.live([...specs.values()]) : null
    const hub = createHub({ emitLocal: !feed })
    const database = createDatabase({ schema, specs, hub, info })
    const state: DbState = { specs, safe, hub, database }
    yield* StateRef.set(state)

    if (feed) {
      const subscription = yield* feed
      yield* fork(() => pumpLive(hub, subscription, [...specs.keys()]))
    }
    if (options.bus) {
      yield* attachBus(state, options.bus)
    }
    return database
  },
})

export const DbClient: DbDef = DbClientImpl.build({
  migrate: operation(function* () {
    const state = yield* useContext(StateRef)
    const plan = yield* planMigration([...state.specs.values()])
    yield* applyPlan(plan, { safe: state.safe })
  }),

  planMigration: operation(function* () {
    const state = yield* useContext(StateRef)
    return yield* planMigration([...state.specs.values()])
  }),

  raw: operation(function* (
    statement: string,
    params?: readonly unknown[],
    options?: DbDef.RawOptions,
  ) {
    let spec: TableSpec | undefined
    if (options?.table) {
      const state = yield* useContext(StateRef)
      spec = state.specs.get(options.table)
      if (!spec) {
        return yield* fail(DbErrors.Validation, `unknown table "${options.table}"`)
      }
    }
    return yield* DbAdapter.actions.raw(statement, params, spec)
  }),

  touch: operation(function* (table: string, id?: string) {
    const state = yield* useContext(StateRef)
    if (!state.specs.has(table)) {
      return yield* fail(DbErrors.Validation, `unknown table "${table}"`)
    }
    yield* state.hub.publish({ table, id: id ?? '', op: 'touch', doc: null })
  }),

  hasBus: operation(function* () {
    return (yield* useContext(StateRef)).hub.hasBus()
  }),

  connectBus: operation(function* (bus: ChangeBus) {
    const state = yield* useContext(StateRef)
    return yield* attachBus(state, bus)
  }),

  dropTable: operation(function* (table: string) {
    yield* DbAdapter.actions.migrate([{ kind: 'drop-table', table }])
  }),

  dropIndex: operation(function* (table: string, index: string) {
    yield* DbAdapter.actions.migrate([{ kind: 'drop-index', table, index }])
  }),

  reindex: operation(function* (table: string) {
    const state = yield* useContext(StateRef)
    const spec = state.specs.get(table)
    if (!spec) {
      return yield* fail(DbErrors.Validation, `unknown table "${table}"`)
    }
    yield* DbAdapter.actions.migrate([{ kind: 'reindex', table, indexes: spec.indexes }])
  }),
})

/**
 * Resolve the installed {@link Database}, typed by the tables you pass (types only — the runtime
 * handle is the install's): `const db = yield* useDb(users, posts)`.
 */
export const useDb = <TTables extends readonly TableDef[]>(
  ...tables: TTables
): Operation<Database<SchemaFrom<TTables>>> => {
  void tables
  return DbProtocol.context.expect() as AnyType
}
