import type { Schema } from 'db:core'
import { clampLimit, FIELDS } from 'db:core'
import type { ServiceDef } from 'server:core'
import { action, ServerErrors, service } from 'server:core'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import {
  docSchema,
  ERRORS,
  filterOf,
  ifMatch,
  insertSchema,
  listInput,
  patchSchema,
} from './internal'
import type { ResourceDef } from './types'

/**
 * A CRUD service for a table: `list` (filter/order/limit/cursor), `get`, `create`, `update`
 * (`If-Match` = `_version` → 412 on conflict), `replace`, `remove` — REST routes under
 * `/<name>`, typed from the column kinds, filters sanitized to the allowed columns. Returns the
 * service plus what the `Resource` plugin needs for its realtime route.
 */
export const crud = <TName extends string, TDoc, TInsert>(
  table: Schema.Table<TName, TDoc, TInsert>,
  options: ResourceDef.CrudOptions = {},
): ResourceDef.Crud<TName, TDoc, TInsert> => {
  const name = (options.name ?? table.name) as TName

  const filterable = options.filterable ?? [
    ...table.columns.map(column => column.name),
    ...Object.values(FIELDS),
  ]
  const maxLimit = options.maxLimit ?? 100
  const auth = options.auth ?? {}
  const extra = options.options ?? {}
  const read = auth.read === undefined ? {} : { auth: auth.read }
  const write = auth.write === undefined ? {} : { auth: auth.write }
  const doc = docSchema(table)
  const id = z.object({ id: z.string() })

  const svc = service(name, {
    list: action.query(
      {
        ...extra,
        ...read,
        input: listInput,
        output: z.object({
          data: z.array(doc),
          nextCursor: z.string().nullable(),
          prevCursor: z.string().nullable(),
          token: z.string(),
        }),
        route: { method: 'GET', path: `/${name}` },
        errors: ERRORS,
      },
      function* ({ input, ctx }) {
        let query = ctx.db.query(table.name)
        const filter = yield* filterOf(input.filter, filterable)
        if (filter) {
          query = query.filter(filter)
        }
        if (input.order) {
          if (!filterable.includes(input.order)) {
            return yield* fail(ServerErrors.BadRequest, `cannot order by "${input.order}"`)
          }
          query = query.order(input.order, input.direction ?? 'asc')
        }
        const page = yield* query.paginate({
          limit: clampLimit(input.limit ?? maxLimit, maxLimit),
          cursor: input.cursor,
        })
        return {
          data: page.data as AnyType,
          nextCursor: page.pageInfo.nextCursor,
          prevCursor: page.pageInfo.prevCursor,
          token: page.token,
        }
      },
    ),
    get: action.query(
      {
        ...extra,
        ...read,
        input: id,
        output: doc,
        route: { method: 'GET', path: `/${name}/:id` },
        errors: ERRORS,
      },
      function* ({ input, ctx }) {
        const row = yield* ctx.db.get(table.name, input.id)
        if (!row) {
          return yield* fail(ServerErrors.NotFound, `${name} ${input.id} not found`)
        }
        return row as AnyType
      },
    ),
    create: action.mutation(
      {
        ...extra,
        ...write,
        input: insertSchema(table),
        output: doc,
        route: { method: 'POST', path: `/${name}` },
        errors: ERRORS,
      },
      function* ({ input, ctx }) {
        return (yield* ctx.db.insert(table.name, input as AnyType)) as AnyType
      },
    ),
    update: action.mutation(
      {
        ...extra,
        ...write,
        input: id.extend(patchSchema(table).shape),
        output: doc,
        route: { method: 'PATCH', path: `/${name}/:id` },
        errors: ERRORS,
      },
      function* ({ input, ctx }) {
        const { id: rowId, ...patch } = input as AnyType
        const row = yield* ctx.db.patch(table.name, rowId, patch, {
          ifVersion: ifMatch(ctx.headers),
        })
        if (!row) {
          return yield* fail(ServerErrors.NotFound, `${name} ${rowId} not found`)
        }
        return row as AnyType
      },
    ),
    replace: action.mutation(
      {
        ...extra,
        ...write,
        input: id.extend(insertSchema(table).shape),
        output: doc,
        route: { method: 'PUT', path: `/${name}/:id` },
        errors: ERRORS,
      },
      function* ({ input, ctx }) {
        const { id: rowId, ...value } = input as AnyType
        const row = yield* ctx.db.replace(table.name, rowId, value, {
          ifVersion: ifMatch(ctx.headers),
        })
        if (!row) {
          return yield* fail(ServerErrors.NotFound, `${name} ${rowId} not found`)
        }
        return row as AnyType
      },
    ),
    remove: action.mutation(
      {
        ...extra,
        ...write,
        input: id,
        output: z.object({ removed: z.boolean() }),
        route: { method: 'DELETE', path: `/${name}/:id` },
        errors: ERRORS,
      },
      function* ({ input, ctx }) {
        return {
          removed: yield* ctx.db.delete(table.name, input.id, { ifVersion: ifMatch(ctx.headers) }),
        }
      },
    ),
  })

  return {
    service: svc as unknown as ServiceDef.Service<TName, ResourceDef.CrudActions<TDoc, TInsert>>,
    table,
    filterable,
    maxLimit,
    auth,
  }
}
