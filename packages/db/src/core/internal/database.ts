// oxlint-disable import/exports-last
import type { Flow } from 'std:effect'
import { attempt, operation } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbAdapter } from '../adapter'
import { CREATED, ID, UPDATED, VERSION } from '../const'
import { DbErrors } from '../errors'
import { and, eq } from '../query/ops'
import type {
  AdapterDef,
  Database,
  Doc,
  Filter,
  SchemaDef,
  TableDef,
  TableSpec,
  TransactionOptions,
  WriteOptions,
} from '../types'

import { createQueryHandle } from './builder'
import type { Hub, LocalWrite } from './hub'
import { prepareInsert, preparePatch } from './validate'

export interface DatabaseDeps {
  readonly schema: SchemaDef
  readonly specs: ReadonlyMap<string, TableSpec>
  readonly hub: Hub
  readonly info: AdapterDef.Info
}

interface Target {
  readonly def: TableDef
  readonly spec: TableSpec
}

/**
 * Build the typed {@link Database} handle over the installed adapter: validated writes with system-
 * field stamping, structured queries, and hub-backed reactivity. Every method dispatches through
 * the `DbAdapter` protocol, so `DbAdapter.around/before/after` middleware wraps the real backend
 * calls.
 */
export const createDatabase = (deps: DatabaseDeps): Database => {
  const { hub } = deps

  const targetOf = operation(function* (table: string) {
    const def = deps.schema.tables[table]
    const spec = deps.specs.get(table)
    if (!def || !spec) {
      return yield* fail(DbErrors.Validation, `unknown table "${table}"`)
    }
    return { def, spec } as Target
  })

  const getRow = operation(function* (table: string, id: string) {
    const target = yield* targetOf(table)
    const rows = yield* DbAdapter.actions.find({
      table: target.spec,
      filter: eq(ID, id),
      order: [],
      limit: 1,
      offset: null,
    })
    return (rows[0] ?? null) as AnyType
  })

  const stampNew = (data: Doc): Doc => {
    const now = Date.now()
    return { [ID]: crypto.randomUUID(), [CREATED]: now, [UPDATED]: now, [VERSION]: 1, ...data }
  }

  const insertRow = operation(function* (table: string, value: unknown) {
    const target = yield* targetOf(table)
    const data = yield* prepareInsert(target.def, value)
    const row = stampNew(data)
    const stored = yield* DbAdapter.actions.insert(target.spec, [row])
    const doc = stored[0] ?? row
    yield* hub.publish({ table, id: String(doc[ID]), op: 'insert', doc })
    return doc as AnyType
  })

  const insertManyRows = operation(function* (table: string, values: readonly unknown[]) {
    const target = yield* targetOf(table)
    const rows: Doc[] = []
    for (const value of values) {
      rows.push(stampNew(yield* prepareInsert(target.def, value)))
    }
    if (rows.length === 0) {
      return [] as AnyType
    }
    const stored = yield* DbAdapter.actions.insert(target.spec, rows)
    const docs = stored.length === rows.length ? stored : rows
    for (const doc of docs) {
      yield* hub.publish({ table, id: String(doc[ID]), op: 'insert', doc })
    }
    return docs as AnyType
  })

  const writeGuard = (id: string, options?: WriteOptions): Filter =>
    options?.ifVersion === undefined ? eq(ID, id) : and(eq(ID, id), eq(VERSION, options.ifVersion))

  /** A guarded write matched nothing: absent doc -> null result, version mismatch -> conflict. */
  const missedWrite = operation(function* (
    target: Target,
    id: string,
    options: WriteOptions | undefined,
  ) {
    if (options?.ifVersion === undefined) {
      return null as AnyType
    }
    const rows = yield* DbAdapter.actions.find({
      table: target.spec,
      filter: eq(ID, id),
      order: [],
      limit: 1,
      offset: null,
    })
    if (rows.length === 0) {
      return null as AnyType
    }
    return yield* fail(
      DbErrors.Conflict,
      `"${target.spec.name}" document ${id} is at version ${String(rows[0]![VERSION])}, expected ${options.ifVersion}`,
    )
  })

  // oxlint-disable-next-line max-params
  const patchRow = operation(function* (
    table: string,
    id: string,
    value: unknown,
    options?: WriteOptions,
  ) {
    const target = yield* targetOf(table)
    const data = yield* preparePatch(target.def, value)
    const updated = yield* DbAdapter.actions.update({
      table: target.spec,
      filter: writeGuard(id, options),
      set: { ...data, [UPDATED]: Date.now() },
      bump: [VERSION],
    })
    const doc = updated[0]
    if (!doc) {
      return yield* missedWrite(target, id, options)
    }
    yield* hub.publish({ table, id, op: 'update', doc })
    return doc as AnyType
  })

  // oxlint-disable-next-line max-params
  const replaceRow = operation(function* (
    table: string,
    id: string,
    value: unknown,
    options?: WriteOptions,
  ) {
    const target = yield* targetOf(table)
    // prepareInsert normalizes EVERY declared column (omitted optionals become null), so this is a
    // true replace: unspecified fields reset instead of surviving from the previous version.
    const data = yield* prepareInsert(target.def, value)
    const updated = yield* DbAdapter.actions.update({
      table: target.spec,
      filter: writeGuard(id, options),
      set: { ...data, [UPDATED]: Date.now() },
      bump: [VERSION],
    })
    const doc = updated[0]
    if (!doc) {
      return yield* missedWrite(target, id, options)
    }
    yield* hub.publish({ table, id, op: 'update', doc })
    return doc as AnyType
  })

  const deleteRow = operation(function* (table: string, id: string, options?: WriteOptions) {
    const target = yield* targetOf(table)
    const removed = yield* DbAdapter.actions.remove({
      table: target.spec,
      filter: writeGuard(id, options),
    })
    if (removed.length === 0) {
      const missed = yield* missedWrite(target, id, options)
      return missed === null ? false : (missed as AnyType)
    }
    yield* hub.publish({ table, id, op: 'delete', doc: removed[0] ?? null })
    return true
  })

  const watchDoc = (table: string, id: string): Flow<AnyType, never> =>
    ({
      *[Symbol.iterator]() {
        const subscription = yield* hub.changes(table)
        let primed = false
        // the highest row `_version` this watcher has emitted — an event whose payload is not
        // strictly newer (e.g. a notification queued before we primed) triggers a re-fetch
        // instead of rewinding the watcher to a stale snapshot
        let seen = 0
        const versionOf = (doc: unknown): number =>
          Number((doc as Record<string, unknown> | null)?._version ?? 0)
        return {
          next: operation(function* () {
            if (!primed) {
              primed = true
              const current = yield* getRow(table, id)
              seen = versionOf(current)
              return { done: false as const, value: current }
            }
            for (;;) {
              const step = yield* subscription.next()
              if (step.done) {
                continue
              }
              // a table-level touch (empty id) means "anything here may have changed" — doc
              // watchers re-read too (this is how live-feed reconnects heal them)
              const relevant =
                step.value.id === id || (step.value.op === 'touch' && step.value.id === '')
              if (!relevant) {
                continue
              }
              if (step.value.op === 'delete') {
                return { done: false as const, value: null }
              }
              if (step.value.doc && versionOf(step.value.doc) > seen) {
                seen = versionOf(step.value.doc)
                return { done: false as const, value: step.value.doc }
              }
              const fresh = yield* getRow(table, id)
              seen = Math.max(seen, versionOf(fresh))
              return { done: false as const, value: fresh }
            }
          }),
        }
      },
    }) as Flow<AnyType, never>

  const database: Database = {
    get: getRow,
    insert: insertRow,
    insertMany: insertManyRows,
    patch: patchRow,
    replace: replaceRow,
    delete: deleteRow,
    query: (table: string) => {
      const spec = deps.specs.get(table)
      // an unknown table still returns a handle; its terminals fail with `db.validation`
      return createQueryHandle({
        spec: spec ?? { name: table, columns: [], indexes: [] },
        hub,
      }) as AnyType
    },
    watch: watchDoc,
    changes: (table?: string) => hub.changes(table),
    transaction: operation(function* (
      body: (db: Database) => AnyType,
      options?: TransactionOptions,
    ) {
      if (!deps.info.capabilities.transactions) {
        return yield* fail(
          DbErrors.Unsupported,
          `the "${deps.info.adapter}" adapter does not support transactions`,
        )
      }
      const retries = Math.max(0, options?.retries ?? 2)
      for (let attemptIndex = 0; ; attemptIndex += 1) {
        const events: LocalWrite[] = []
        const outcome = yield* attempt(
          DbAdapter.actions.transaction(() => hub.isolate(events, () => body(database))),
        )
        if (!isFailure(outcome)) {
          yield* hub.flush(events)
          return outcome.value as AnyType
        }
        if (outcome.error === DbErrors.Conflict && attemptIndex < retries) {
          continue
        }
        return yield* outcome
      }
    }),
    version: (table: string) => hub.version(table),
  } as unknown as Database

  return database
}
