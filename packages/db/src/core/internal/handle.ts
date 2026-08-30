import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { FIELDS } from '../const'
import { DbErrors } from '../errors'
import type { Change } from '../types/change'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'
import { filterValues, where } from '../utils/filter'

import { TxBuffer } from './context'
import { createQuery } from './query'
import { prepareInsert, preparePatch } from './validate'
import { watchDoc } from './watch'

/** The loose write options every internal path works with (the typed generics live on the
 * public {@link Database.Handle} alone). */
interface WriteOptions {
  readonly ifVersion?: string | undefined
  readonly scope?: Spec.Filter | undefined
}

/** The read predicate of a document addressed by id, narrowed by a trusted `scope`. */
const readGuard = (id: string, scope: Spec.Filter | undefined): Spec.Filter =>
  scope === undefined ? where.eq(FIELDS.id, id) : where.and(where.eq(FIELDS.id, id), scope)

/** The write predicate: the id and the `scope`, plus the expected `_version` under optimistic
 * concurrency. */
const writeGuard = (id: string, options?: WriteOptions): Spec.Filter => {
  const guard = readGuard(id, options?.scope)

  return options?.ifVersion === undefined
    ? guard
    : where.and(guard, where.eq(FIELDS.version, options.ifVersion))
}

/**
 * Build the typed {@link Database.Handle} over an install's state: validated writes with
 * system-field stamping, structured queries, and hub-backed reactivity. Every call dispatches
 * through the adapter actions, so `DbAdapter.around/before/after` middleware wraps the real
 * backend calls. `base` is the trusted predicate of a `db.scoped(...)` derivation: every
 * operation of the derived handle runs under it (AND-ed with any per-call `options.scope`).
 */
export const createHandle = (state: Database.State, base?: Spec.Filter): Database.Handle => {
  const { hub, adapter } = state

  /** The effective trusted predicate of one call: the handle's own AND the per-call one. */
  const scopeOf = (scope: Spec.Filter | undefined): Spec.Filter | undefined =>
    base === undefined ? scope : scope === undefined ? base : where.and(base, scope)

  const guardOptions = (options?: WriteOptions): WriteOptions => ({
    ifVersion: options?.ifVersion,
    scope: scopeOf(options?.scope),
  })

  const targetOf = function* (table: string) {
    const def = state.tables.get(table)
    const spec = state.specs.get(table)

    if (!def || !spec) {
      return yield* fail(DbErrors.Validation, `unknown table "${table}"`)
    }

    return { def, spec } as Helpers.WriteTarget
  }

  const loadOne = function* (spec: Spec.Table, id: string, scope?: Spec.Filter) {
    const rows = yield* adapter.find({
      table: spec,
      filter: readGuard(id, scope),
      order: [],
      limit: 1,
      offset: null,
    })

    return rows[0] ?? null
  }

  const stamp = function* (data: Spec.Doc) {
    const now = Date.now()

    return {
      [FIELDS.id]: yield* state.mintId(),
      [FIELDS.created]: now,
      [FIELDS.updated]: now,
      [FIELDS.version]: yield* state.mintToken(),
      ...data,
    } as Spec.Doc
  }

  /** The values a scope PINS onto every inserted row (so a scoped insert cannot write outside
   * its own scope). A scope that pins nothing exact cannot shape an insert — refuse loudly. */
  const pinned = function* (table: string, scope: Spec.Filter | undefined) {
    if (scope === undefined) {
      return {}
    }

    const values = filterValues(scope)

    if (values === null) {
      return yield* fail(
        DbErrors.Validation,
        `cannot insert into "${table}" under a scope that pins no exact values`,
      )
    }

    return values
  }

  /** Announce one change AFTER its write landed: identity + op (+ changed column names on
   * update) — never documents. The log row went in BEFORE the write (`hub.record`). */
  const announce = (write: Helpers.Tokened): Operation<void> => hub.announce(write)

  /** A guarded write found the document but changed nothing: only a stale `ifVersion` explains
   * that — report the conflict. */
  const conflict = (target: Helpers.WriteTarget, before: Spec.Doc, expected: string) =>
    fail(
      DbErrors.Conflict,
      `"${target.spec.name}" document ${String(before[FIELDS.id])} is at version ${String(before[FIELDS.version])}, expected ${expected}`,
    )

  /** A guarded write matched nothing: absent doc → null result, version mismatch → conflict.
   * The re-read keeps the `scope` on, so a row OUTSIDE it reads as absent — an out-of-scope
   * write is a miss, never a conflict that would prove the row exists. */
  const missed = function* (target: Helpers.WriteTarget, id: string, options?: WriteOptions) {
    if (options?.ifVersion === undefined) {
      return null
    }

    const current = yield* loadOne(target.spec, id, options.scope)

    return current ? yield* conflict(target, current, options.ifVersion) : null
  }

  /** The shared tail of `patch`/`replace`: a guarded update that re-versions the row with a fresh
   * token and announces which columns changed. `options` arrives ALREADY merged with the
   * handle's base scope. */

  // oxlint-disable-next-line max-params
  const write = function* (
    target: Helpers.WriteTarget,
    id: string,
    data: Spec.Doc,
    options?: WriteOptions,
  ) {
    // one write, one token: the log row and the event carry the row's new version
    const change = yield* hub.record({
      table: target.spec.name,
      id,
      op: 'update',
      fields: Object.keys(data),
    })

    const updated = yield* adapter.update({
      table: target.spec,
      filter: writeGuard(id, options),
      set: { ...data, [FIELDS.updated]: Date.now(), [FIELDS.version]: change.token },
    })
    const doc = updated[0]

    if (!doc) {
      // the write never happened: take its log row back (harmless if we crash in between —
      // a phantom row only costs a spurious recompute, and `compact` sweeps it)
      yield* hub.retract(change)
      return yield* missed(target, id, options)
    }

    yield* announce(change)

    return doc
  }

  const get = function* (table: string, id: string, options?: WriteOptions) {
    const target = yield* targetOf(table)
    return yield* loadOne(target.spec, id, scopeOf(options?.scope))
  }

  const insertMany = function* (table: string, values: readonly unknown[]) {
    const target = yield* targetOf(table)
    // the base scope's pinned values land on every row LAST — a scoped handle cannot write
    // outside its own scope
    const pins = yield* pinned(table, base)
    const rows: Spec.Doc[] = []

    for (const value of values) {
      rows.push(yield* stamp(yield* prepareInsert(target.def, { ...(value as object), ...pins })))
    }

    if (rows.length === 0) {
      return []
    }

    const writes: Helpers.Tokened[] = []

    for (const row of rows) {
      writes.push(
        yield* hub.record({
          table,
          id: String(row[FIELDS.id]),
          op: 'insert',
          token: String(row[FIELDS.version]),
        }),
      )
    }

    const stored = yield* adapter.insert(target.spec, rows)
    const docs = stored.length === rows.length ? stored : rows

    for (const change of writes) {
      yield* announce(change)
    }

    return docs
  }

  const insert = function* (table: string, value: unknown) {
    const docs = yield* insertMany(table, [value])
    return docs[0]!
  }

  // oxlint-disable-next-line max-params
  const patch = function* (table: string, id: string, value: unknown, options?: WriteOptions) {
    const target = yield* targetOf(table)
    return yield* write(target, id, yield* preparePatch(target.def, value), guardOptions(options))
  }

  // oxlint-disable-next-line max-params
  const replace = function* (table: string, id: string, value: unknown, options?: WriteOptions) {
    const target = yield* targetOf(table)
    // the scope's pinned values override the replacement, so a replace cannot move the row
    // out of the scope it was written under
    const pins = base === undefined ? {} : (filterValues(base) ?? {})

    // prepareInsert normalizes EVERY declared column (omitted optionals become null), so this is
    // a true replace: unspecified fields reset instead of surviving from the previous version
    return yield* write(
      target,
      id,
      yield* prepareInsert(target.def, { ...(value as object), ...pins }),
      guardOptions(options),
    )
  }

  const remove = function* (table: string, id: string, options?: WriteOptions) {
    const target = yield* targetOf(table)
    const merged = guardOptions(options)
    const change = yield* hub.record({ table, id, op: 'delete' })
    const removed = yield* adapter.remove({ table: target.spec, filter: writeGuard(id, merged) })

    if (removed.length === 0) {
      // nothing was deleted: take the log row back before deciding miss vs conflict
      yield* hub.retract(change)
      yield* missed(target, id, merged)
      return false
    }

    yield* announce(change)

    return true
  }

  const transaction = function* (
    body: (db: Database.Handle) => Operation<unknown>,
    options?: Database.TransactionOptions,
  ) {
    if (!state.info.capabilities.transactions) {
      return yield* fail(
        DbErrors.Unsupported,
        `the "${state.info.adapter}" adapter does not support transactions`,
      )
    }

    const nested = (yield* TxBuffer.get()) !== undefined
    const retries = Math.max(0, options?.retries ?? 2)

    for (let attemptIndex = 0; ; attemptIndex += 1) {
      const buffer: Change.Write[] = []

      const outcome = yield* attempt(
        adapter.transaction(function* () {
          const result = yield* hub.isolate(buffer, () => body(handle))
          // the log rows go in as the transaction's LAST step so their `ts` ≈ commit time.
          // NESTED: the outer transaction owns the log write — persisting here too would
          // insert the same tokens twice (`db.unique` on `__changes_<table>`).
          const tx = yield* state.mintToken()

          if (!nested) {
            yield* hub.persist(buffer as Helpers.Tokened[], tx)
          }

          return { result, tx }
        }),
      )

      if (!isFailure(outcome)) {
        yield* hub.flush(buffer, outcome.value.tx)
        return outcome.value.result
      }

      if (outcome.error !== DbErrors.Conflict || attemptIndex >= retries) {
        return yield* outcome
      }
    }
  }

  /** Insert-or-update in ONE transaction: the read and the write cannot interleave with another
   * upsert of the same key, so the "both inserted" race is closed. The handle's base scope is
   * applied by the inner calls themselves; only the per-call `options.scope` is added here. */

  // oxlint-disable-next-line max-params
  const upsert = function* (
    table: string,
    match: Record<string, unknown>,
    value: unknown,
    options?: WriteOptions,
  ) {
    return yield* transaction(function* (tx) {
      const loose = tx as AnyType
      let lookup = loose.query(table).where(match)

      if (options?.scope) {
        lookup = lookup.filter(options.scope)
      }

      const existing = yield* lookup.unique()

      if (!existing) {
        const pins = yield* pinned(table, options?.scope)
        return yield* loose.insert(table, { ...match, ...(value as object), ...pins })
      }

      const updated = yield* loose.patch(table, String((existing as Spec.Doc)[FIELDS.id]), value, {
        ifVersion: options?.ifVersion,
        scope: options?.scope,
      })

      return updated ?? existing
    })
  }

  const handle = {
    get,
    insert,
    insertMany,
    upsert,
    patch,
    replace,
    delete: remove,
    query: (table: string) => {
      const built = createQuery({
        state,
        // an unknown table still returns a handle; its terminals fail with `db.validation`
        spec: state.specs.get(table) ?? { name: table, columns: [], indexes: [] },
      })

      // a scoped handle's queries START narrowed — `filter` stacks, so refiners AND onto it
      return base === undefined ? built : built.filter(base as AnyType)
    },
    watch: (table: string, id: string, options?: WriteOptions) =>
      watchDoc({ hub, table, id, load: () => get(table, id, options) }),
    changes: (table?: string) => hub.changes(table),
    transaction,
    version: (table: string) => hub.version(table),
    scoped: (scope: Spec.Filter) =>
      createHandle(state, base === undefined ? scope : where.and(base, scope)),
    // THE one runtime→type boundary of the package: the loose internals above ARE the typed
    // surface — every generic method narrows these `(table: string, …)` implementations
  } as unknown as Database.Handle

  return handle
}
