import { hasCodec } from 'std:codec'
import { attempt, fork, sleep, useContext } from 'std:effect'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { CHANGES_PREFIX, DEFAULT_REPLAY_WINDOW_MS, FIELDS } from '../const'
import { DbErrors } from '../errors'
import { bridgeTransports, createBus, logOf, publishWrites, specOf } from '../internal/client'
import { StateRef } from '../internal/context'
import { createHandle } from '../internal/handle'
import { attachBus, createHub } from '../internal/hub'
import {
  appendLog,
  compactLog,
  isLogName,
  logSpecOf,
  logStats,
  readLog,
  replayLog,
} from '../internal/log'
import { applyPlan, planMigration } from '../internal/migrate'
import type { Bus } from '../types/bus'
import type { Change } from '../types/change'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'
import { eq } from '../utils/filter'
import { tableSpecOf } from '../utils/schema'

import { Db, DbAdapter } from './protocol'

/**
 * The reactive database engine over the installed adapter. `setup` reconciles the schema (unless
 * `migrations: 'manual'`), fixes this node's origin, wires the change hub over the node's local
 * bus (bridging the installed `DbBus`) and resolves the typed {@link Database.Handle}
 * as the plugin context.
 * `JsonCodec` is a BASELINE dependency (`json` columns, keyset cursors and unique-index keys are
 * all (de)serialized through it) — installed here unless the scope already carries a codec.
 */
const DbImpl = Db.implement<Database.Context, [options: Database.Options]>({
  name: 'db-client',
  version: '0.1.0',
  description: 'The reactive database engine over the installed adapter',

  *setup(options) {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }

    const adapter = (options.adapter ?? DbAdapter).actions
    const described = yield* attempt(() => adapter.describe())
    if (isFailure(described)) {
      return yield* fail(
        DbErrors.Configuration,
        'no db adapter installed — install a db:impl/* adapter before DbClient',
        String(described.error),
      )
    }

    // ids are ULIDs minted by the installed `std:io` impl (or a custom minter): probe it once
    // here so a missing IO install fails the install loudly instead of the first insert
    const mintId = options.id ?? (() => IO.actions.ulid({ length: 32, window: 100 }))
    const probe = yield* attempt(mintId)
    if (isFailure(probe)) {
      return yield* fail(
        DbErrors.Configuration,
        'cannot mint ids — install a std:io impl (BunIO/NodeIO) before DbClient, or pass `options.id`',
        String(probe.error),
      )
    }

    // this node's identity: the HLC origin of every token it mints (8 Crockford chars) — by
    // default 8 random hex digits (hex is a Crockford subset), independent of how ids look; the
    // first token doubles as the format check
    const origin = (
      options.origin ?? (yield* IO.actions.uuid()).replaceAll('-', '').slice(0, 8)
    ).toUpperCase()
    const mintToken = () => IO.actions.hlc({ origin })
    const minted = yield* attempt(mintToken)
    if (isFailure(minted)) {
      return yield* fail(
        DbErrors.Configuration,
        `invalid origin "${origin}" — 8 Crockford base32 characters expected`,
        String(minted.error),
      )
    }

    const reserved = options.tables.find(def => isLogName(def.name))
    if (reserved) {
      return yield* fail(
        DbErrors.Configuration,
        `table name "${reserved.name}" is reserved (names starting with "__" belong to the change logs)`,
      )
    }
    const base = {
      tables: new Map(options.tables.map(def => [def.name, def])),
      specs: new Map(options.tables.map(def => [def.name, tableSpecOf(def)])),
      logs: new Map(
        options.tables.filter(def => def.log).map(def => [def.name, logSpecOf(def.name)]),
      ),
      safe: options.safe ?? false,
      adapter,
      info: described.value,
      origin,
      replayWindowMs: options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS,
      mintId,
      mintToken,
    }
    if ((options.migrations ?? 'auto') === 'auto') {
      yield* applyPlan(base, yield* planMigration(base))
    }

    const outbox = yield* createBus(origin, options.bus)
    const hub = createHub({
      bus: outbox.bus,
      mintToken,
      persist: (writes, tx) => appendLog(base, writes, tx),
      replay: (table, fromTs) => replayLog(base, table, fromTs),
      observe: token => IO.actions.observeHlc(token),
      replayWindowMs: base.replayWindowMs,
      tables: [...base.specs.keys()],
    })
    const state: Database.State = {
      ...base,
      hub,
      bus: outbox.bus,
      bridged: new Set(),
      outbox: outbox.counters,
    }
    yield* StateRef.set(state)

    yield* attachBus(hub, outbox.bus)
    yield* bridgeTransports(state)
    const pollMs = options.pollMs ?? 0
    if (pollMs > 0) {
      yield* fork(function* () {
        for (;;) {
          yield* sleep(pollMs)
          yield* attempt(() => hub.sync())
        }
      })
    }
    return createHandle(state)
  },
})

export const DbClient: Database.Client = DbImpl.build({
  *migrate() {
    const state = yield* useContext(StateRef)
    yield* applyPlan(state, yield* planMigration(state))
  },

  *planMigration() {
    return yield* planMigration(yield* useContext(StateRef))
  },

  *raw(statement: string, params?: readonly unknown[], options?: Database.RawOptions) {
    const state = yield* useContext(StateRef)
    const spec: Spec.Table | undefined = options?.table ? yield* specOf(options.table) : undefined
    const emit = options?.emit
    if (emit && !spec) {
      return yield* fail(DbErrors.Validation, '`emit` requires `table`')
    }
    const result = yield* state.adapter.raw(statement, params, spec)
    if (!emit || !spec) {
      return result
    }
    const ids = result.rows.map(row => row[FIELDS.id]).filter(id => id !== undefined && id !== null)
    if (ids.length === 0) {
      return yield* fail(
        DbErrors.Validation,
        `emit requires the statement to RETURNING "${FIELDS.id}" — nothing to announce`,
      )
    }
    // one token per row; insert/update re-version the rows so delta watchers and `ifVersion`
    // see the change (a structured update in the same session rides the open transaction)
    const stamp = emit.stamp ?? emit.op !== 'delete'
    const writes: Helpers.Tokened[] = []
    for (const id of ids) {
      const write = yield* state.hub.record({
        table: spec.name,
        id: String(id),
        op: emit.op,
        ...(emit.op === 'update' && emit.fields ? { fields: emit.fields } : {}),
      })
      if (stamp && emit.op !== 'delete') {
        yield* state.adapter.update({
          table: spec,
          filter: eq(FIELDS.id, String(id)),
          set: { [FIELDS.version]: write.token, [FIELDS.updated]: Date.now() },
        })
      }
      writes.push(write)
    }
    for (const write of writes) {
      yield* state.hub.announce(write)
    }
    return result
  },

  *touch(table: string, id?: string) {
    yield* publishWrites([{ table, id: id ?? '', op: 'touch' }])
  },

  *touchBatch(table: string, ids: readonly string[]) {
    yield* publishWrites(ids.map((id): Change.Write => ({ table, id, op: 'touch' })))
  },

  *publish(writes: readonly Change.Write[]) {
    yield* publishWrites(writes)
  },

  *version() {
    return yield* (yield* useContext(StateRef)).mintToken()
  },

  *bus() {
    return (yield* useContext(StateRef)).bus
  },

  *bridge() {
    return yield* bridgeTransports(yield* useContext(StateRef))
  },

  *busStats() {
    const state = yield* useContext(StateRef)
    return { ...state.outbox, ...state.hub.stats() } satisfies Bus.Stats
  },

  // a table and its change log come and go together
  *dropTable(table: string) {
    const state = yield* useContext(StateRef)
    yield* state.adapter.migrate([
      { kind: 'drop-table', table },
      { kind: 'drop-table', table: CHANGES_PREFIX + table },
    ])
  },

  *log(table: string, options?: Database.LogOptions) {
    const state = yield* useContext(StateRef)
    return yield* readLog(state, yield* logOf(table), options)
  },

  *logStats(table: string) {
    const state = yield* useContext(StateRef)
    return yield* logStats(state, yield* logOf(table))
  },

  *compact(table?: string, options?: Database.CompactOptions) {
    const state = yield* useContext(StateRef)
    const logs = table === undefined ? [...state.logs.values()] : [yield* logOf(table)]
    let removed = 0
    for (const log of logs) {
      removed += yield* compactLog(state, log, options)
    }
    return removed
  },

  *dropIndex(table: string, index: string) {
    const state = yield* useContext(StateRef)
    yield* state.adapter.migrate([{ kind: 'drop-index', table, index }])
  },

  *reindex(table: string) {
    const state = yield* useContext(StateRef)
    const spec = yield* specOf(table)
    yield* state.adapter.migrate([{ kind: 'reindex', table, indexes: spec.indexes }])
  },
})
