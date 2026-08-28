import type { Schema } from 'db:core'
import type { ServiceDef } from 'server:core'
import { action, service } from 'server:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { PageShape } from './internal'
import {
  countOp,
  createManyOp,
  createOp,
  defaultFilterable,
  docSchema,
  ERRORS,
  getOp,
  guardHandshake,
  hooked,
  insertSchema,
  listInput,
  listOp,
  pageSchema,
  patchSchema,
  realtime,
  removeOp,
  replaceOp,
  shaper,
  updateOp,
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
 * `schema` hooks reshape the derived schemas once at definition time (`input`: list / create /
 * update / replace, `output`: doc / page). The
 * `before`/`after`/`around`/`error` hooks are the resource's seams: they see every built-in
 * operation (the realtime watch included) with the full ctx and may transform the input, the
 * output or the failure (see `ResourceDef.CrudHooks`). The `_realtime` socket is an
 * `action.socket` entry of the service itself (`realtimePath` moves it) — no plugin mounts
 * it. Returns the service plus the resolved `shapes` for `extend` actions to reuse.
 */
const builder = <
  TTable extends Schema.Table,
  const TNames extends readonly ResourceDef.ActionName[] | true = true,
  TExtend extends ServiceDef.ActionMap = Record<never, ServiceDef.ActionEntry>,
>(
  table: TTable,
  options: ResourceDef.CrudOptions<TTable, TNames, TExtend> = {},
): ResourceDef.Crud<TTable, TNames, TExtend> => {
  const name = (options.name ?? table.name) as TTable['name']

  const filterable = options.filterable ?? defaultFilterable(table)
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
  // the `schema` hooks reshape what the table derives — once, right here at definition time
  const shape = shaper(options.schema)
  const id = z.object({ id: z.string() })

  const doc = shape.output(docSchema(table), 'doc')

  // the RESOLVED schemas (returned as `shapes` so `extend` actions reuse them)
  const shapes: ResourceDef.Crud['shapes'] = {
    doc,
    page: shape.output(pageSchema(doc), 'page'),
    list: shape.input(listInput, 'list'),
    create: shape.input(insertSchema(table), 'create'),
    update: shape.input(id.extend(patchSchema(table).shape), 'update'),
    replace: shape.input(id.extend(insertSchema(table).shape), 'replace'),
  }

  const builtins: Record<string, ServiceDef.ActionEntry> = {
    list: action.query(
      {
        ...extra,
        ...read,
        input: shapes.list,
        output: shapes.page,
        route: { method: 'GET', path: `/${name}` },
        errors: ERRORS,
      },
      hooked('list', hooks, function* ({ input, ctx }) {
        return (yield* listOp(table, {
          ctx,
          input: input as AnyType,
          filterable,
          maxLimit,
        })) as AnyType
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
        return yield* getOp(table, { ctx, id: input.id })
      }),
    ),
    create: action.mutation(
      {
        ...extra,
        ...write,
        input: shapes.create,
        output: doc,
        route: { method: 'POST', path: `/${name}` },
        errors: ERRORS,
      },
      hooked('create', hooks, function* ({ input, ctx }) {
        return yield* createOp(table, { ctx, value: input as AnyType })
      }),
    ),
    update: action.mutation(
      {
        ...extra,
        ...write,
        input: shapes.update,
        output: doc,
        route: { method: 'PATCH', path: `/${name}/:id` },
        errors: ERRORS,
      },
      hooked('update', hooks, function* ({ input, ctx }) {
        const { id: rowId, ...patch } = input as AnyType
        return yield* updateOp(table, { ctx, id: rowId, patch })
      }),
    ),
    replace: action.mutation(
      {
        ...extra,
        ...write,
        input: shapes.replace,
        output: doc,
        route: { method: 'PUT', path: `/${name}/:id` },
        errors: ERRORS,
      },
      hooked('replace', hooks, function* ({ input, ctx }) {
        const { id: rowId, ...value } = input as AnyType
        return yield* replaceOp(table, { ctx, id: rowId, value })
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
        return yield* removeOp(table, { ctx, id: input.id })
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

  // the realtime socket is part of the SERVICE itself (an `action.socket` entry) — no plugin
  // mounts it; a same-named `extend` entry still replaces it
  if (enabled.includes('realtime')) {
    picked['_realtime'] = realtimeSocket(
      { table, filterable, maxLimit, auth, hooks },
      options.realtimePath === undefined ? {} : { path: `/${name}${options.realtimePath}` },
    )
  }

  const svc = service(name, { ...picked, ...options.extend })

  // the crud handle IS the service: `services: [todos]`, no `.service` hop
  return {
    ...svc,
    table,
    filterable,
    maxLimit,
    auth,
    hooks,
    shapes,
    enabled,
  } as unknown as ResourceDef.Crud<TTable, TNames, TExtend>
}

/** `crud.list` — `total: true` also counts the set, so the page carries `total`. */
interface ListFn {
  <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.ListOp & { readonly total: true },
  ): Operation<ResourceDef.Page<Schema.Infer<TTable>> & { readonly total: number }>
  <TTable extends Schema.Table>(
    table: TTable,
    options?: ResourceDef.ListOp,
  ): Operation<ResourceDef.Page<Schema.Infer<TTable>>>
}

/** `crud.get` — `optional: true` returns `null` instead of failing `server.not-found`. */
interface GetFn {
  <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.GetOp & { readonly optional: true },
  ): Operation<Schema.Infer<TTable> | null>
  <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.GetOp,
  ): Operation<Schema.Infer<TTable>>
}

/** The `list` envelope schema over a table (its derived doc) or an already-reshaped row
 * schema — `.extend` it (`total`, facet metadata) for a custom list's `output`; the page
 * shape infers from the doc, so the handler's `crud.list` return needs no cast. */
interface PageFn {
  <T extends z.ZodType>(doc: T): PageShape<T>
  (table: Schema.Table): PageShape<z.ZodObject>
}

const pageFor: PageFn = ((source: Schema.Table | z.ZodType) =>
  pageSchema(
    'columns' in source ? docSchema(source as Schema.Table) : (source as z.ZodType),
  )) as PageFn

/** The realtime socket entry over a resolved source (shared by `crud()` and
 * `crud.realtime`). */
const realtimeSocket = (
  source: ResourceDef.RealtimeSource,
  config: { readonly path?: string | undefined; readonly description?: string | undefined },
): ServiceDef.SocketAction =>
  action.socket(
    {
      path: config.path,
      protocol: 'resource',
      description: config.description ?? 'watch/unwatch frames in, sync/delta/error frames out',
      authorize: guardHandshake(source),
      defaults: { cursor: 0 },
    },
    realtime(source),
  )

/** The delta-watch socket as an `action.socket` entry for ANY service: mounts at
 * `/<service>/<key>` (or `path`), listed under that service in the manifest with the
 * realtime opening-frame defaults. */
const realtimeAction = (
  table: Schema.Table,
  options: ResourceDef.RealtimeOptions = {},
): ServiceDef.SocketAction =>
  realtimeSocket(
    {
      table,
      filterable: options.filterable ?? defaultFilterable(table),
      maxLimit: options.maxLimit ?? 100,
      auth: options.auth === undefined ? {} : { read: options.auth },
      hooks: options.hooks ?? {},
      scope: options.scope,
    },
    { path: options.path, description: options.description },
  )

/**
 * `crud(table, options)` builds the service; the RUNNABLE ops on it (`crud.list(table, …)`,
 * `crud.get`, …) are the same pipelines as single calls inside ANY handler — they read the
 * dispatch ctx ambiently (pass `ctx` outside one), so a custom action owns its route, schemas,
 * errors and tags while the crud mechanics stay one `yield*` away. `crud.realtime(table, …)`
 * is the delta-watch socket as an `action.socket` entry, `crud.errors` the db failure → status
 * map, and `crud.schemas` the derived building blocks (`doc`/`insert`/`patch`/`listInput`/
 * `page`) for the custom action's own declarations.
 */
export const crud = Object.assign(builder, {
  list: listOp as ListFn,
  get: getOp as GetFn,

  create: createOp as <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.CreateOp<Schema.InferInsert<TTable>>,
  ) => Operation<Schema.Infer<TTable>>,

  update: updateOp as <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.UpdateOp<Schema.InferInsert<TTable>>,
  ) => Operation<Schema.Infer<TTable>>,

  replace: replaceOp as <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.ReplaceOp<Schema.InferInsert<TTable>>,
  ) => Operation<Schema.Infer<TTable>>,

  remove: removeOp as <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.RemoveOp,
  ) => Operation<{ readonly removed: boolean }>,

  count: countOp as <TTable extends Schema.Table>(
    table: TTable,
    options?: ResourceDef.CountOp,
  ) => Operation<number>,

  createMany: createManyOp as <TTable extends Schema.Table>(
    table: TTable,
    options: ResourceDef.CreateManyOp<Schema.InferInsert<TTable>>,
  ) => Operation<readonly Schema.Infer<TTable>[]>,

  realtime: realtimeAction,

  /** per-action http statuses for the db failures the ops raise — spread into a custom
   * action's `errors`. */
  errors: ERRORS,

  schemas: {
    /** the stored row shape (system fields included). */
    doc: docSchema,

    /** the insert shape: optional columns and columns with defaults may be omitted. */
    insert: insertSchema,

    /** the patch shape: everything optional. */
    patch: patchSchema,

    /** the wire `list` input — `.extend` facet params onto it. */
    listInput,
    page: pageFor,
  },
})
