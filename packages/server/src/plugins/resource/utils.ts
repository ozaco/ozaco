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
  hooked,
  ifMatch,
  insertSchema,
  listInput,
  patchSchema,
  shaper,
} from './internal'
import type { ResourceDef } from './types'

const ALL_ACTIONS: readonly ResourceDef.ActionName[] = [
  'list',
  'get',
  'create',
  'update',
  'replace',
  'remove',
  'realtime',
]

/**
 * A CRUD service for a table: `list` (filter/order/limit/cursor), `get`, `create`, `update`
 * (`If-Match` = `_version` → 412 on conflict), `replace`, `remove` — REST routes under
 * `/<name>`, typed from the column kinds, filters sanitized to the allowed columns. The
 * `actions` option picks which built-ins exist (`'realtime'` is the socket; omitted or `true`
 * = all), `extend` merges custom actions into the SAME service (no side-service needed), the
 * `schema` hook reshapes the derived schemas once at definition time (doc / list / create /
 * update / replace). The
 * `before`/`after`/`around`/`error` hooks are the resource's seams: they see every built-in
 * operation (the realtime watch included) with the full ctx and may transform the input, the
 * output or the failure (see `ResourceDef.CrudHooks`). Returns the service plus what the
 * `Resource` plugin needs for its realtime route.
 */
export const crud = <
  TTable extends Schema.Table,
  const TNames extends readonly ResourceDef.ActionName[] | true = true,
  TExtend extends ServiceDef.ActionMap = Record<never, ServiceDef.ActionEntry>,
>(
  table: TTable,
  options: ResourceDef.CrudOptions<TNames, TExtend> = {},
): ResourceDef.Crud<TTable, TNames, TExtend> => {
  const name = (options.name ?? table.name) as TTable['name']

  const filterable = options.filterable ?? [
    ...table.columns.map(column => column.name),
    ...Object.values(FIELDS),
  ]
  const maxLimit = options.maxLimit ?? 100
  const auth = options.auth ?? {}
  const extra = options.options ?? {}

  const hooks: ResourceDef.CrudHooks = {
    before: options.before,
    after: options.after,
    around: options.around,
    error: options.error,
  }
  const read = auth.read === undefined ? {} : { auth: auth.read }
  const write = auth.write === undefined ? {} : { auth: auth.write }
  // the `schema` hook reshapes what the table derives — once, right here at definition time
  const shape = shaper(options.schema)
  const doc = shape(docSchema(table), 'doc')
  const id = z.object({ id: z.string() })

  const builtins: Record<string, ServiceDef.ActionEntry> = {
    list: action.query(
      {
        ...extra,
        ...read,
        input: shape(listInput, 'list'),
        output: z.object({
          data: z.array(doc),
          nextCursor: z.string().nullable(),
          prevCursor: z.string().nullable(),
          token: z.string(),
        }),
        route: { method: 'GET', path: `/${name}` },
        errors: ERRORS,
      },
      hooked('list', hooks, function* ({ input, ctx }) {
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
      }),
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
      hooked('get', hooks, function* ({ input, ctx }) {
        const row = yield* ctx.db.get(table.name, input.id)
        if (!row) {
          return yield* fail(ServerErrors.NotFound, `${name} ${input.id} not found`)
        }
        return row as AnyType
      }),
    ),
    create: action.mutation(
      {
        ...extra,
        ...write,
        input: shape(insertSchema(table), 'create'),
        output: doc,
        route: { method: 'POST', path: `/${name}` },
        errors: ERRORS,
      },
      hooked('create', hooks, function* ({ input, ctx }) {
        return (yield* ctx.db.insert(table.name, input as AnyType)) as AnyType
      }),
    ),
    update: action.mutation(
      {
        ...extra,
        ...write,
        input: shape(id.extend(patchSchema(table).shape), 'update'),
        output: doc,
        route: { method: 'PATCH', path: `/${name}/:id` },
        errors: ERRORS,
      },
      hooked('update', hooks, function* ({ input, ctx }) {
        const { id: rowId, ...patch } = input as AnyType
        const row = yield* ctx.db.patch(table.name, rowId, patch, {
          ifVersion: ifMatch(ctx.headers),
        })
        if (!row) {
          return yield* fail(ServerErrors.NotFound, `${name} ${rowId} not found`)
        }
        return row as AnyType
      }),
    ),
    replace: action.mutation(
      {
        ...extra,
        ...write,
        input: shape(id.extend(insertSchema(table).shape), 'replace'),
        output: doc,
        route: { method: 'PUT', path: `/${name}/:id` },
        errors: ERRORS,
      },
      hooked('replace', hooks, function* ({ input, ctx }) {
        const { id: rowId, ...value } = input as AnyType
        const row = yield* ctx.db.replace(table.name, rowId, value, {
          ifVersion: ifMatch(ctx.headers),
        })
        if (!row) {
          return yield* fail(ServerErrors.NotFound, `${name} ${rowId} not found`)
        }
        return row as AnyType
      }),
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
      hooked('remove', hooks, function* ({ input, ctx }) {
        return {
          removed: yield* ctx.db.delete(table.name, input.id, { ifVersion: ifMatch(ctx.headers) }),
        }
      }),
    ),
  }

  const enabled =
    options.actions === undefined || options.actions === true
      ? ALL_ACTIONS
      : (options.actions as readonly ResourceDef.ActionName[])

  const picked = Object.fromEntries(
    Object.entries(builtins).filter(([key]) => enabled.includes(key as ResourceDef.ActionName)),
  )

  const svc = service(name, { ...picked, ...options.extend })

  return {
    service: svc as unknown as ResourceDef.Crud<TTable, TNames, TExtend>['service'],
    table,
    filterable,
    maxLimit,
    auth,
    hooks,
    actions: enabled,
  }
}
