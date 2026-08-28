import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { FIELDS } from '../const'
import { DbErrors } from '../errors'
import type { Change } from '../types/change'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'
import { where } from '../utils/filter'

import { createQuery } from './query'
import { prepareInsert, preparePatch } from './validate'
import { watchDoc } from './watch'

/** The write predicate: the id, plus the expected `_version` under optimistic concurrency. */
const writeGuard = (id: string, options?: Database.WriteOptions): Spec.Filter =>
  options?.ifVersion === undefined
    ? where.eq(FIELDS.id, id)
    : where.and(where.eq(FIELDS.id, id), where.eq(FIELDS.version, options.ifVersion))

/**
 * Build the typed {@link Database.Handle} over an install's state: validated writes with
 * system-field stamping, structured queries, and hub-backed reactivity. Every call dispatches
 * through the adapter actions, so `DbAdapter.around/before/after` middleware wraps the real
 * backend calls.
 */
export const createHandle = (state: Database.State): Database.Handle => {
  const { hub, adapter } = state

  const targetOf = function* (table: string) {
    const def = state.tables.get(table)
    const spec = state.specs.get(table)

    if (!def || !spec) {
      return yield* fail(DbErrors.Validation, `unknown table "${table}"`)
    }

    return { def, spec } as Helpers.WriteTarget
  }

  const loadOne = function* (spec: Spec.Table, id: string) {
    const rows = yield* adapter.find({
      table: spec,
      filter: where.eq(FIELDS.id, id),
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

  /** A guarded write matched nothing: absent doc → null result, version mismatch → conflict. */
  const missed = function* (
    target: Helpers.WriteTarget,
    id: string,
    options: Database.WriteOptions | undefined,
  ) {
    if (options?.ifVersion === undefined) {
      return null
    }

    const current = yield* loadOne(target.spec, id)

    return current ? yield* conflict(target, current, options.ifVersion) : null
  }

  /** The shared tail of `patch`/`replace`: a guarded update that re-versions the row with a fresh
   * token and announces which columns changed. */

  // oxlint-disable-next-line max-params
  const write = function* (
    target: Helpers.WriteTarget,
    id: string,
    data: Spec.Doc,
    options?: Database.WriteOptions,
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
      return yield* missed(target, id, options)
    }

    yield* announce(change)

    return doc
  }

  const get = function* (table: string, id: string) {
    const target = yield* targetOf(table)
    return yield* loadOne(target.spec, id)
  }

  const insertMany = function* (table: string, values: readonly unknown[]) {
    const target = yield* targetOf(table)
    const rows: Spec.Doc[] = []

    for (const value of values) {
      rows.push(yield* stamp(yield* prepareInsert(target.def, value)))
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
  const patch = function* (
    table: string,
    id: string,
    value: unknown,
    options?: Database.WriteOptions,
  ) {
    const target = yield* targetOf(table)
    return yield* write(target, id, yield* preparePatch(target.def, value), options)
  }

  // oxlint-disable-next-line max-params
  const replace = function* (
    table: string,
    id: string,
    value: unknown,
    options?: Database.WriteOptions,
  ) {
    const target = yield* targetOf(table)

    // prepareInsert normalizes EVERY declared column (omitted optionals become null), so this is
    // a true replace: unspecified fields reset instead of surviving from the previous version
    return yield* write(target, id, yield* prepareInsert(target.def, value), options)
  }

  const remove = function* (table: string, id: string, options?: Database.WriteOptions) {
    const target = yield* targetOf(table)
    const change = yield* hub.record({ table, id, op: 'delete' })
    const removed = yield* adapter.remove({ table: target.spec, filter: writeGuard(id, options) })

    if (removed.length === 0) {
      yield* missed(target, id, options)
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

    const retries = Math.max(0, options?.retries ?? 2)

    for (let attemptIndex = 0; ; attemptIndex += 1) {
      const buffer: Change.Write[] = []

      const outcome = yield* attempt(
        adapter.transaction(function* () {
          const result = yield* hub.isolate(buffer, () => body(handle))
          // the log rows go in as the transaction's LAST step so their `ts` ≈ commit time
          const tx = yield* state.mintToken()
          yield* hub.persist(buffer as Helpers.Tokened[], tx)
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
   * upsert of the same key, so the "both inserted" race is closed. */
  const upsert = function* (table: string, match: Record<string, unknown>, value: unknown) {
    return yield* transaction(function* (tx) {
      const existing = yield* tx
        .query(table)
        .where(match as never)
        .unique()

      if (!existing) {
        return yield* tx.insert(table, { ...match, ...(value as object) } as never)
      }

      const updated = yield* tx.patch(
        table,
        String((existing as Spec.Doc)[FIELDS.id]),
        value as never,
      )

      return updated ?? existing
    })
  }

  const handle: Database.Handle = {
    get,
    insert,
    insertMany,
    upsert,
    patch,
    replace,
    delete: remove,
    query: (table: string) =>
      createQuery({
        state,
        // an unknown table still returns a handle; its terminals fail with `db.validation`
        spec: state.specs.get(table) ?? { name: table, columns: [], indexes: [] },
      }),
    watch: (table: string, id: string) => watchDoc({ hub, table, id, load: () => get(table, id) }),
    changes: (table?: string) => hub.changes(table),
    transaction,
    version: (table: string) => hub.version(table),
  } as unknown as Database.Handle

  return handle
}
