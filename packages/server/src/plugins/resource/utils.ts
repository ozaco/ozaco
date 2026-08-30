import type { Schema } from 'db:core'
import type { ServiceDef } from 'server:core'
import { action, service } from 'server:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import {
  clientFrameSchema,
  countOp,
  createManyOp,
  createOp,
  docSchema,
  ERRORS,
  filterableOf,
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
  resolveSchemas,
  scopeOf,
  scopeSides,
  serverFrameSchema,
  updateOp,
} from './internal'
import type { Helpers } from './types/helpers'
import type { ResourceDef } from './types/resource'

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
 * `path` (default `/<name>`), typed from the column kinds, filters sanitized to the allowed
 * columns. The `actions` option picks which built-ins exist (`'realtime'` is the socket;
 * omitted or `true` = all), `extend` merges custom actions into the SAME service, the `schema`
 * transforms reshape the derived schemas once at definition time AND in the types, `scope` is
 * the trusted per-caller filter (tenancy — optionally split `{ read, write }`), `ops` carries
 * per-op options/errors, and the `before`/`after`/`around`/`error` hooks are the seams (see
 * `ResourceDef`). The `_realtime` socket is an `action.socket` entry of the service itself
 * with declared `receives`/`sends` frames. Returns the service plus the resolved typed
 * `shapes` for `extend` actions to reuse.
 */
const builder = <
  TTable extends Schema.Table,
  const TName extends string = TTable['name'],
  const TNames extends readonly ResourceDef.ActionName[] | true = true,
  TExtend extends ServiceDef.ActionMap = Record<never, ServiceDef.ActionEntry>,
  TDoc extends z.ZodType = never,
  TPage extends z.ZodType = never,
  TList extends z.ZodType = never,
  TCreate extends z.ZodType = never,
  TUpdate extends z.ZodType = never,
  TReplace extends z.ZodType = never,
>(
  table: TTable,
  // NoInfer: the table is the ONLY inference site for `TTable` — a hook annotated with the
  // default shapes would otherwise widen it back to the base `Schema.Table`
  options: ResourceDef.CrudOptions<
    NoInfer<TTable>,
    TName,
    TNames,
    TExtend,
    TDoc,
    TPage,
    TList,
    TCreate,
    TUpdate,
    TReplace
  > = {} as never,
): ResourceDef.Crud<
  TTable,
  TName,
  TNames,
  TExtend,
  ResourceDef.Resolved<TTable, TDoc, TPage, TList, TCreate, TUpdate, TReplace>
> => {
  const name = (options.name ?? table.name) as TName
  const root = options.path ?? `/${name}`
  const filterable = filterableOf(options.filterable, table)
  const maxLimit = options.maxLimit ?? 100
  const auth = options.auth ?? {}
  const scope = scopeSides(options.scope)
  const shared = options.options ?? {}
  const perOp = options.ops ?? {}

  const hooks: ResourceDef.CrudHooks<AnyType> = {
    before: options.before as AnyType,
    after: options.after as AnyType,
    around: options.around as AnyType,
    error: options.error as AnyType,
  }

  // the RESOLVED schemas (returned as `shapes` so `extend` actions reuse them) — the `schema`
  // transforms applied once, right here at definition time
  const shapes = resolveSchemas(table, options.schema)
  const idSchema = z.object({ id: z.string() })

  // the manifest publishes the resource's FILTER SURFACE on the list entry (`docs.filters`):
  // which fields a client may filter/order by, their column kinds and allowed operators
  const filtersDoc = filterable.map(entry => ({
    field: entry.field,
    kind: table.columns.find(column => column.name === entry.field)?.kind ?? 'text',
    ops: entry.ops ?? null,
  }))

  /** One built-in's full config: the shared options, the op's own (winning), the side's auth
   * and the three-layer errors merge (db baseline ← resource ← op). */
  const configFor = (
    op: Exclude<ResourceDef.ActionName, 'realtime'>,
    side: 'read' | 'write',
  ): Record<string, unknown> => {
    const own = perOp[op] ?? {}
    const { errors: ownErrors, ...ownOptions } = own
    const requirement = own.auth ?? auth[side]

    return {
      ...shared,
      ...ownOptions,
      ...(requirement === undefined ? {} : { auth: requirement }),
      errors: { ...ERRORS, ...options.errors, ...ownErrors },
    }
  }

  const builtins: Record<string, ServiceDef.ActionEntry> = {
    list: action.query(
      {
        ...configFor('list', 'read'),
        input: shapes.list,
        output: shapes.page,
        route: { method: 'GET', path: root },
        docs: { filters: filtersDoc },
      },
      hooked('list', hooks, function* ({ input, ctx }) {
        return (yield* listOp(table, {
          ctx,
          input: input as AnyType,
          filterable,
          maxLimit,
          scope: yield* scopeOf(scope.read, ctx),
        })) as AnyType
      }),
    ),
    get: action.query(
      {
        ...configFor('get', 'read'),
        input: idSchema,
        output: shapes.doc,
        route: { method: 'GET', path: `${root}/:id` },
      },
      hooked('get', hooks, function* ({ input, ctx }) {
        return yield* getOp(table, {
          ctx,
          id: (input as AnyType).id,
          scope: yield* scopeOf(scope.read, ctx),
        })
      }),
    ),
    create: action.mutation(
      {
        ...configFor('create', 'write'),
        input: shapes.create,
        output: shapes.doc,
        route: { method: 'POST', path: root },
      },
      hooked('create', hooks, function* ({ input, ctx }) {
        return yield* createOp(table, {
          ctx,
          value: input as AnyType,
          scope: yield* scopeOf(scope.write, ctx),
        })
      }),
    ),
    update: action.mutation(
      {
        ...configFor('update', 'write'),
        input: shapes.update,
        output: shapes.doc,
        route: { method: 'PATCH', path: `${root}/:id` },
      },
      hooked('update', hooks, function* ({ input, ctx }) {
        const { id: rowId, ...patch } = input as AnyType
        return yield* updateOp(table, {
          ctx,
          id: rowId,
          patch,
          scope: yield* scopeOf(scope.write, ctx),
        })
      }),
    ),
    replace: action.mutation(
      {
        ...configFor('replace', 'write'),
        input: shapes.replace,
        output: shapes.doc,
        route: { method: 'PUT', path: `${root}/:id` },
      },
      hooked('replace', hooks, function* ({ input, ctx }) {
        const { id: rowId, ...value } = input as AnyType
        return yield* replaceOp(table, {
          ctx,
          id: rowId,
          value,
          scope: yield* scopeOf(scope.write, ctx),
        })
      }),
    ),
    remove: action.mutation(
      {
        ...configFor('remove', 'write'),
        input: idSchema,
        output: z.object({ removed: z.boolean() }),
        route: { method: 'DELETE', path: `${root}/:id` },
      },
      hooked('remove', hooks, function* ({ input, ctx }) {
        return yield* removeOp(table, {
          ctx,
          id: (input as AnyType).id,
          scope: yield* scopeOf(scope.write, ctx),
        })
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
      { table, filterable, maxLimit, auth, hooks, scope: scope.read },
      shapes.doc,
      { path: `${root}${options.realtimePath ?? '/_realtime'}` },
    )
  }

  const svc = service(name, { ...picked, ...options.extend })

  // the crud handle IS the service: `services: [todos]`, no `.service` hop.
  // THE one runtime→type boundary of the plugin: the generics mirror what the call site wrote
  return {
    ...svc,
    table,
    path: root,
    filterable,
    maxLimit,
    auth,
    hooks,
    scope,
    shapes,
    enabled,
  } as unknown as ResourceDef.Crud<
    TTable,
    TName,
    TNames,
    TExtend,
    ResourceDef.Resolved<TTable, TDoc, TPage, TList, TCreate, TUpdate, TReplace>
  >
}

const pageFor: Helpers.PageFn = ((source: Schema.Table | z.ZodType) =>
  pageSchema(
    'columns' in source ? docSchema(source as Schema.Table) : (source as z.ZodType),
  )) as Helpers.PageFn

/** The realtime socket entry over a resolved source (shared by `crud()` and
 * `crud.realtime`) — its frames are DECLARED (`receives`/`sends`), so the manifest and a
 * generated client speak them. */
const realtimeSocket = (
  source: ResourceDef.RealtimeSource,
  doc: z.ZodType,
  config: { readonly path?: string | undefined; readonly description?: string | undefined },
): ServiceDef.SocketAction<AnyType, AnyType> =>
  action.socket(
    {
      path: config.path,
      protocol: 'resource',
      description: config.description ?? 'watch/unwatch frames in, sync/delta/error frames out',
      authorize: guardHandshake(source),
      authorizeMode: 'first-frame',
      defaults: { cursor: 0 },
      receives: clientFrameSchema,
      sends: serverFrameSchema(doc),
    },
    realtime(source) as AnyType,
  )

/** The delta-watch socket as an `action.socket` entry for ANY service: mounts at
 * `/<service>/<key>` (or `path`), listed under that service in the manifest with the
 * realtime opening-frame defaults and its declared frames. */
const realtimeAction = (
  table: Schema.Table,
  options: ResourceDef.RealtimeOptions = {},
): ServiceDef.SocketAction<AnyType, AnyType> =>
  realtimeSocket(
    {
      table,
      filterable: filterableOf(options.filterable, table),
      maxLimit: options.maxLimit ?? 100,
      auth: options.auth === undefined ? {} : { read: options.auth },
      hooks: options.hooks ?? {},
      scope: options.scope,
    },
    docSchema(table),
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
  list: listOp as Helpers.ListFn,
  get: getOp as Helpers.GetFn,

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
