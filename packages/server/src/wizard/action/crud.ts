// oxlint-disable import/exports-last
import type { Infer, InferInsert, Page, TableDef } from 'db:realtime'
import { eq, like, or, useDatabase } from 'db:realtime'
import { CoreErrors, useRequest } from 'server:core'
import { attempt } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { CrudOptions, FnModule, Mutation, Query } from '../types'
import { collectionEvent, doc, page } from '../utils/schema'

/** The list action's argument shape: pagination + sort + free-text + arbitrary facet filters. */
export interface CrudListArgs {
  readonly limit?: number
  readonly cursor?: string
  readonly direction?: 'forward' | 'backward'
  readonly sort?: string
  readonly q?: string
  readonly [facet: string]: unknown
}

/** One item in a `batch` request — a discriminated bulk operation. `update`/`replace`/`delete` accept
 * an optional per-item `ifMatch` (`_version`) for optimistic concurrency, isolated to that item. */
export type BatchOp<T extends TableDef> =
  | { readonly op: 'create'; readonly data: InferInsert<T> }
  | {
      readonly op: 'update'
      readonly id: string
      readonly patch: Partial<InferInsert<T>>
      readonly ifMatch?: string
    }
  | {
      readonly op: 'replace'
      readonly id: string
      readonly data: InferInsert<T>
      readonly ifMatch?: string
    }
  | { readonly op: 'delete'; readonly id: string; readonly ifMatch?: string }

/** One result in a `batch` response — per-item success or failure, so a partial batch reports exactly
 * which items applied and which did not (never all-or-nothing). */
export type BatchResult<T extends TableDef> =
  | { readonly status: 'ok'; readonly op: string; readonly id?: string; readonly row?: Infer<T> }
  | { readonly status: 'error'; readonly op: string; readonly id?: string; readonly error: string }

/** The typed function module a `type: 'crud'` resource generates for a table `T` — each action carries
 * the table's row (`Infer<T>`) and insert (`InferInsert<T>`) types so `Broker.call` returns them. */
export interface CrudModule<T extends TableDef> {
  readonly list: Query<CrudListArgs, Page<Infer<T>>>
  readonly get: Query<{ readonly id: string }, Infer<T>>
  readonly create: Mutation<InferInsert<T>, Infer<T>>
  readonly update: Mutation<Partial<InferInsert<T>> & { readonly id: string }, Infer<T>>
  readonly replace: Mutation<InferInsert<T> & { readonly id: string }, Infer<T>>
  readonly remove: Mutation<{ readonly id: string }, Infer<T> | undefined>
  readonly batch: Mutation<
    { readonly operations: readonly BatchOp<T>[] },
    { readonly results: readonly BatchResult<T>[] }
  >
}

const BASE_LIST_ARGS = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  sort: z.string().optional(),
  q: z.string().optional(),
}

/** Case-insensitive header lookup over the request meta bag. */
const headerOf = (meta: Record<string, string>, name: string): string | undefined => {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(meta)) {
    if (key.toLowerCase() === lower) {
      return value
    }
  }
  return undefined
}

/**
 * The standard REST collection for a table (spec §0.1): `GET /` (cursor list), `GET /:id`, `POST /`,
 * `PATCH /:id` (+ `If-Match` optimistic concurrency → 412), `PUT /:id`, `DELETE /:id`, and
 * `PATCH /batch`. The `list` watch emits row-delta {@link collectionEvent}s. Internal — reached via
 * `resource(table, { type: 'crud' })`, not called directly.
 */
export const buildCrudModule = <T extends TableDef>(
  target: T,
  options: CrudOptions = {},
): CrudModule<T> => {
  const table = target.name
  const access = options.access
  const document = doc(target)
  const idParams = options.idParams ?? ['id']
  const idPath = idParams.map(param => `/:${param}`).join('')
  const filters = options.filters ?? [...new Set(target.indexes.flatMap(index => index.columns))]
  const search = options.search ?? []

  const columnKind = new Map(target.columns.map(column => [column.name, column.kind]))
  // Coerce a string path/query value to the column's stored type so equality matches typed columns.
  const coerceValue = (column: string, value: unknown): unknown => {
    if (value === undefined || value === null) {
      return value
    }
    const kind = columnKind.get(column)
    if (kind === 'int' || kind === 'float' || kind === 'timestamp') {
      return Number(value)
    }
    if (kind === 'boolean') {
      return value === 'true' || value === true
    }
    return value
  }

  // Resolve the target row's `_id` from the body. The default single `id` param IS `_id`; a composite
  // key looks the row up by its declared columns.
  const resolveId = (db: AnyType, body: AnyType) =>
    (function* () {
      if (idParams.length === 1 && idParams[0] === 'id') {
        return String(body.id)
      }
      const match: Record<string, unknown> = {}
      for (const param of idParams) {
        match[param] = coerceValue(param, body[param])
      }
      const row = yield* db.query(table).where(match).unique()
      return row ? String(row._id) : null
    })()

  const idParamSet = new Set<string>(idParams)
  const stripIdParams = (body: AnyType): AnyType =>
    Object.fromEntries(
      Object.entries(body as Record<string, unknown>).filter(([key]) => !idParamSet.has(key)),
    )

  // Optimistic concurrency: when the request carries `If-Match`, reject a stale write with 412. No
  // request context (an in-process broker call) means no header — skip the check.
  const assertIfMatch = (db: AnyType, id: string) =>
    (function* () {
      const outcome = yield* attempt(useRequest())
      const request = isSuccess(outcome) ? outcome.value : undefined
      if (!request) {
        return
      }
      const ifMatch = headerOf(request.meta, 'if-match')
      if (ifMatch === undefined) {
        return
      }
      const current = yield* db.get(table, id)
      if (!current) {
        return yield* fail(CoreErrors.NotFound, `"${table}" record "${id}" not found`)
      }
      if (String(current._version) !== ifMatch) {
        return yield* fail(
          CoreErrors.PreconditionFailed,
          `"${table}" record "${id}" was modified (If-Match mismatch)`,
        )
      }
    })()

  // Optimistic concurrency against an EXPLICIT expected `_version` — the per-item `ifMatch` a `batch`
  // op carries inline (there is no request header for a single item). `undefined` skips the check.
  const assertVersion = (db: AnyType, id: string, expected: string | undefined) =>
    (function* () {
      if (expected === undefined) {
        return
      }
      const current = yield* db.get(table, id)
      if (!current) {
        return yield* fail(CoreErrors.NotFound, `"${table}" record "${id}" not found`)
      }
      if (String(current._version) !== expected) {
        return yield* fail(
          CoreErrors.PreconditionFailed,
          `"${table}" record "${id}" was modified (If-Match mismatch)`,
        )
      }
    })()

  // Apply one batch item. Fails (never returns falsy) when a target row is missing, so the caller can
  // report that item as an error while the rest of the batch proceeds.
  const applyBatchOp = (db: AnyType, op: AnyType) =>
    (function* () {
      if (op.op === 'create') {
        return yield* db.insert(table, op.data)
      }
      yield* assertVersion(db, op.id, op.ifMatch)
      if (op.op === 'update') {
        const row = yield* db.patch(table, op.id, op.patch)
        if (!row) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record "${op.id}" not found`)
        }
        return row
      }
      if (op.op === 'replace') {
        const row = yield* db.replace(table, op.id, op.data)
        if (!row) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record "${op.id}" not found`)
        }
        return row
      }
      const removed = yield* db.delete(table, op.id)
      if (!removed) {
        return yield* fail(CoreErrors.NotFound, `"${table}" record "${op.id}" not found`)
      }
      return undefined
    })()

  const idArgsShape = Object.fromEntries(idParams.map(param => [param, z.string()])) as AnyType
  const listArgs = z.object({
    ...BASE_LIST_ARGS,
    ...(Object.fromEntries(filters.map(facet => [facet, z.string().optional()])) as AnyType),
  })

  const module: FnModule = {
    list: {
      kind: 'query',
      args: listArgs,
      returns: page(target),
      emits: collectionEvent(target),
      reactive: 'delta',
      target: table,
      watch: [table],
      access,
      rest: { method: 'GET', path: '' },
      *handler(body) {
        const db = yield* useDatabase()
        let q = db.query(table) as AnyType
        for (const facet of filters) {
          const raw = (body as AnyType)[facet]
          if (raw !== undefined) {
            q = q.filter(eq(facet, coerceValue(facet, raw) as AnyType))
          }
        }
        if (body.q && search.length > 0) {
          q = q.filter(or(...search.map(column => like(column, `%${String(body.q)}%`))))
        }
        if (body.sort) {
          const desc = body.sort.startsWith('-')
          q = q.order(desc ? body.sort.slice(1) : body.sort, desc ? 'desc' : 'asc')
        }
        return yield* q.paginate({
          cursor: body.cursor ?? null,
          limit: body.limit ?? 25,
          direction: body.direction ?? 'forward',
        })
      },
    },
    get: {
      kind: 'query',
      args: z.object(idArgsShape),
      returns: document,
      target: table,
      watch: [table],
      access,
      rest: { method: 'GET', path: idPath },
      *handler(body) {
        const db = yield* useDatabase()
        const id = yield* resolveId(db, body)
        const found = id ? yield* db.get(table, id) : null
        if (!found) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record not found`)
        }
        return found
      },
    },
    create: {
      kind: 'mutation',
      args: target.validator,
      returns: document,
      target: table,
      access,
      rest: { method: 'POST', path: '' },
      *handler(body) {
        const db = yield* useDatabase()
        return yield* db.insert(table, body)
      },
    },
    update: {
      kind: 'mutation',
      args: target.validator.partial().extend(idArgsShape),
      returns: document,
      target: table,
      access,
      rest: { method: 'PATCH', path: idPath },
      *handler(body) {
        const db = yield* useDatabase()
        const id = yield* resolveId(db, body)
        if (!id) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record not found`)
        }
        yield* assertIfMatch(db, id)
        const updated = yield* db.patch(table, id, stripIdParams(body))
        if (!updated) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record "${id}" not found`)
        }
        return updated
      },
    },
    replace: {
      kind: 'mutation',
      args: target.validator.extend(idArgsShape),
      returns: document,
      target: table,
      access,
      rest: { method: 'PUT', path: idPath },
      *handler(body) {
        const db = yield* useDatabase()
        const id = yield* resolveId(db, body)
        if (!id) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record not found`)
        }
        yield* assertIfMatch(db, id)
        const replaced = yield* db.replace(table, id, stripIdParams(body))
        if (!replaced) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record "${id}" not found`)
        }
        return replaced
      },
    },
    remove: {
      kind: 'mutation',
      args: z.object(idArgsShape),
      target: table,
      access,
      rest: { method: 'DELETE', path: idPath },
      *handler(body) {
        const db = yield* useDatabase()
        const id = yield* resolveId(db, body)
        if (!id) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record not found`)
        }
        // Optimistic concurrency: `If-Match` on the DELETE rejects a stale delete with 412.
        yield* assertIfMatch(db, id)
        const removed = yield* db.delete(table, id)
        if (!removed) {
          return yield* fail(CoreErrors.NotFound, `"${table}" record "${id}" not found`)
        }
        // undefined body → the gateway responds 204 No Content
        return undefined
      },
    },
    batch: {
      kind: 'mutation',
      args: z.object({
        operations: z.array(
          z.discriminatedUnion('op', [
            z.object({ op: z.literal('create'), data: target.validator }),
            z.object({
              op: z.literal('update'),
              id: z.string(),
              patch: target.validator.partial(),
              ifMatch: z.string().optional(),
            }),
            z.object({
              op: z.literal('replace'),
              id: z.string(),
              data: target.validator,
              ifMatch: z.string().optional(),
            }),
            z.object({ op: z.literal('delete'), id: z.string(), ifMatch: z.string().optional() }),
          ]),
        ),
      }),
      returns: z.object({
        results: z.array(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              op: z.string(),
              id: z.string().optional(),
              row: document.optional(),
            }),
            z.object({
              status: z.literal('error'),
              op: z.string(),
              id: z.string().optional(),
              error: z.string(),
            }),
          ]),
        ),
      }),
      target: table,
      access,
      rest: { method: 'PATCH', path: '/batch' },
      *handler(body) {
        const db = yield* useDatabase()
        const results: AnyType[] = []
        // Each op is applied independently: a failed item is reported, not thrown, so the batch is a
        // partial success (per-item `ok`/`error`) rather than all-or-nothing.
        for (const op of body.operations as AnyType[]) {
          const outcome = yield* attempt(applyBatchOp(db, op))
          if (isSuccess(outcome)) {
            const row = outcome.value as AnyType
            results.push({ status: 'ok', op: op.op, id: row?._id ?? op.id, row })
          } else if (isFailure(outcome)) {
            results.push({ status: 'error', op: op.op, id: op.id, error: outcome.message })
          }
        }
        return { results }
      },
    },
  }

  return { ...module, ...options.actions } as unknown as CrudModule<T>
}
