// oxlint-disable import/exports-last
import type { Schema, Spec } from 'db:core'
import {
  clampLimit,
  DbErrors,
  FIELDS,
  filterFields,
  filterValues,
  sanitizeFilter,
  useDb,
} from 'db:core'
import type { EdgeDef, ServerDef } from 'server:core'
import { CtxRef, ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, scoped, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { AuthDef } from '../auth'
import { Auth } from '../auth'

import type { Helpers } from './types/helpers'
import type { ResourceDef } from './types/resource'

/** A zod schema mirroring a column kind (docs + request validation; the db validates again). */
const columnSchema = (column: Spec.Column): z.ZodType => {
  switch (column.kind) {
    case 'text': {
      return z.string()
    }

    case 'int': {
      return z.number().int()
    }

    case 'float': {
      return z.number()
    }

    case 'boolean': {
      return z.boolean()
    }

    case 'timestamp': {
      return z.coerce.date()
    }

    case 'enum': {
      return z.enum(column.enumValues as [string, ...string[]])
    }

    default: {
      return z.unknown()
    }
  }
}

/** The insert shape: optional columns and columns with defaults may be omitted. */
export const insertSchema = (table: Schema.Table): z.ZodObject =>
  z.object(
    Object.fromEntries(
      table.columns.map(column => [
        column.name,
        column.optional || column.hasDefault
          ? columnSchema(column).optional()
          : columnSchema(column),
      ]),
    ),
  )

/** The patch shape: everything optional. */
export const patchSchema = (table: Schema.Table): z.ZodObject =>
  z.object(
    Object.fromEntries(table.columns.map(column => [column.name, columnSchema(column).optional()])),
  )

/** The stored row shape (system fields included). */
export const docSchema = (table: Schema.Table): z.ZodObject =>
  z.object({
    _id: z.string(),
    _created_at: z.coerce.date(),
    _updated_at: z.coerce.date(),
    _version: z.string(),
    ...Object.fromEntries(
      table.columns.map(column => [
        column.name,
        column.optional ? columnSchema(column).nullable() : columnSchema(column),
      ]),
    ),
  })

export const listInput = z.object({
  /** a filter (JSON algebra) as an object or a JSON string (query strings). */
  filter: z.unknown().optional(),
  order: z.string().optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
})

/** The `list` envelope over a row schema — typed from the doc, so a custom action's `output`
 * infers the real page shape (no cast needed). */
export const pageSchema = <T extends z.ZodType>(doc: T): Helpers.PageShape<T> =>
  z.object({
    data: z.array(doc).readonly(),
    nextCursor: z.string().nullable(),
    prevCursor: z.string().nullable(),
    token: z.string(),
  })

/** The realtime socket's inbound frame schema (published in the manifest as `receives`). */
export const clientFrameSchema: z.ZodType = z.union([
  z.object({ t: z.literal('auth'), token: z.string() }),
  z.object({
    t: z.literal('watch'),
    id: z.string(),
    filter: z.unknown().optional(),
    order: z
      .object({ field: z.string(), direction: z.enum(['asc', 'desc']).optional() })
      .optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.union([z.string(), z.number()]).optional(),
    back: z.boolean().optional(),
    since: z.string().optional(),
  }),
  z.object({ t: z.literal('unwatch'), id: z.string() }),
])

/** The realtime socket's outbound frame schema over a row schema (`sends` in the manifest). */
export const serverFrameSchema = (doc: z.ZodType): z.ZodType => {
  const page = z.object({
    next: z.string().nullable(),
    prev: z.string().nullable(),
    total: z.number(),
  })

  return z.union([
    z.object({
      t: z.literal('sync'),
      id: z.string(),
      rows: z.array(doc).readonly(),
      token: z.string(),
      page: page.optional(),
    }),
    z.object({
      t: z.literal('delta'),
      id: z.string(),
      added: z.array(doc).readonly(),
      changed: z.array(doc).readonly(),
      removed: z.array(z.string()).readonly(),
      token: z.string(),
      page: page.optional(),
    }),
    z.object({ t: z.literal('notify'), id: z.string(), token: z.string(), page }),
    z.object({ t: z.literal('error'), id: z.string(), tag: z.string(), message: z.string() }),
  ])
}

/** Every column + system fields, in the rich `filterable` form. */
export const defaultFilterable = (table: Schema.Table): readonly ResourceDef.FilterableField[] => [
  ...table.columns.map(column => ({ field: column.name })),
  ...Object.values(FIELDS).map(field => ({ field })),
]

/** Normalize a `filterable` option (names or rich entries) to the rich form. */
export const filterableOf = (
  filterable: ResourceDef.Filterable | undefined,
  table: Schema.Table,
): readonly ResourceDef.FilterableField[] => {
  if (filterable === undefined) {
    return defaultFilterable(table)
  }

  return filterable.map(entry => (typeof entry === 'string' ? { field: entry } : entry))
}

/** Per-action http statuses for the db failures a resource raises. */
export const ERRORS = { [DbErrors.Conflict]: 412, [DbErrors.NotFound]: 404, [DbErrors.Unique]: 409 }

/** The wire cursor: `0` (or `'0'`, empty, null) is the START of the set — the manifest
 * documents it as the realtime default; anything else is an opaque keyset cursor. */
export const cursorOf = (value: unknown): string | undefined =>
  value === undefined || value === null || value === 0 || value === '0' || value === ''
    ? undefined
    : String(value)

export const ifMatch = (headers: Readonly<Record<string, string>>): string | undefined => {
  const header = headers['if-match']
  return header ? header.replaceAll('"', '') : undefined
}

/** Which operators a filter node may use per field (the rich `filterable` form). */
function* guardFilterOps(
  filter: Spec.Filter,
  fields: readonly ResourceDef.FilterableField[],
): Operation<void> {
  const allowed = new Map(fields.filter(entry => entry.ops).map(entry => [entry.field, entry.ops!]))

  if (allowed.size === 0) {
    return
  }

  const walk = function* (node: Spec.Filter): Operation<void> {
    switch (node.op) {
      case 'and':
      case 'or': {
        for (const inner of node.filters) {
          yield* walk(inner)
        }
        return
      }

      case 'not': {
        return yield* walk(node.filter)
      }

      default: {
        const ops = allowed.get(node.field)

        if (ops && !ops.includes(node.op)) {
          return yield* fail(
            ServerErrors.BadRequest,
            `operator "${node.op}" is not allowed on "${node.field}"`,
          )
        }
      }
    }
  }

  yield* walk(filter)
}

/** A client filter (object, or a JSON string from a query param) through the sanitizer, then
 * the per-field operator guard. */
export function* filterOf(
  input: unknown,
  fields: readonly ResourceDef.FilterableField[],
): Operation<AnyType> {
  if (input === undefined || input === null || input === '') {
    return null
  }

  const raw = typeof input === 'string' ? yield* attempt(() => parseJson(input)) : { value: input }

  if (isFailure(raw as AnyType)) {
    return yield* fail(ServerErrors.BadRequest, 'filter is not valid JSON')
  }

  const sanitized = yield* sanitizeFilter((raw as AnyType).value, {
    fields: fields.map(entry => entry.field),
  })

  yield* guardFilterOps(sanitized, fields)

  return sanitized
}

function* parseJson(text: string): Operation<{ value: unknown }> {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return yield* fail(ServerErrors.BadRequest, 'invalid JSON')
  }
}

/**
 * Apply the `schema` transforms ONCE, at definition time. Each transform is a PLAIN function;
 * returning `undefined` (or the schema itself) keeps the derived default. The resolution order
 * is `doc` first, `page` derived from the resolved doc, then the four inputs.
 */
export const resolveSchemas = (
  table: Schema.Table,
  transforms: ResourceDef.SchemaTransforms | undefined,
): {
  readonly doc: z.ZodObject
  readonly page: z.ZodObject
  readonly list: z.ZodObject
  readonly create: z.ZodObject
  readonly update: z.ZodObject
  readonly replace: z.ZodObject
} => {
  const apply = (
    transform: ((schema: AnyType) => z.ZodType) | undefined,
    schema: z.ZodObject,
  ): z.ZodObject => (transform?.(schema) ?? schema) as z.ZodObject

  const id = z.object({ id: z.string() })
  const doc = apply(transforms?.doc, docSchema(table))

  return {
    doc,
    page: apply(transforms?.page, pageSchema(doc)),
    list: apply(transforms?.list, listInput),
    create: apply(transforms?.create, insertSchema(table)),
    update: apply(transforms?.update, id.extend(patchSchema(table).shape)),
    replace: apply(transforms?.replace, id.extend(insertSchema(table).shape)),
  }
}

/**
 * The hook chain around one crud handler: `error( around( before → handler → after ) )` — every
 * hook may transform what flows through it (see `ResourceDef.CrudHooks`). Hooks run INSIDE the
 * dispatch, so the input they see is already validated and the output they return still passes
 * the action's output schema. Without hooks the handler is returned untouched.
 */
export const hooked = <
  THandler extends (call: { input: AnyType; ctx: ServerDef.Ctx }) => Operation<AnyType>,
>(
  op: ResourceDef.Op,
  hooks: ResourceDef.CrudHooks<AnyType>,
  handler: THandler,
): THandler => {
  if (!hooks.before && !hooks.after && !hooks.around && !hooks.error) {
    return handler
  }

  const chain = function* (input: AnyType, ctx: ServerDef.Ctx): Operation<AnyType> {
    let current = input

    if (hooks.before) {
      const replaced = yield* hooks.before({ op, input: current, ctx } as AnyType)
      current = replaced === undefined ? current : replaced
    }

    let output = yield* handler({ input: current, ctx })

    if (hooks.after) {
      const replaced = yield* hooks.after({ op, input: current, ctx, output } as AnyType)
      output = replaced === undefined ? output : replaced
    }

    return output
  }

  const wrapped = function* ({
    input,
    ctx,
  }: {
    input: AnyType
    ctx: ServerDef.Ctx
  }): Operation<AnyType> {
    const { around, error } = hooks
    const invoke = around
      ? () => around({ op, input, ctx } as AnyType, value => chain(value, ctx))
      : () => chain(input, ctx)

    if (!error) {
      return yield* invoke()
    }

    const outcome = yield* attempt(invoke)

    if (!isFailure(outcome)) {
      return outcome.value
    }

    const replaced = yield* error({ op, input, ctx, failure: outcome } as AnyType)

    if (replaced === undefined) {
      return yield* outcome
    }

    if (isFailure(replaced as AnyType)) {
      return yield* replaced as Result.Failure<unknown>
    }

    return replaced
  }

  return wrapped as THandler
}

// --- scope -----------------------------------------------------------------------------------

/** Normalize a `scope` option to its `{ read, write }` sides (one function covers both). */
export const scopeSides = (
  option: ResourceDef.ScopeOption | undefined,
): {
  readonly read?: ResourceDef.Scope | undefined
  readonly write?: ResourceDef.Scope | undefined
} => {
  if (option === undefined) {
    return {}
  }

  if (typeof option === 'function') {
    return { read: option, write: option }
  }

  return option
}

/** Resolve one scope side for THIS call — run inside the handler, under every hook, so no
 * `before`/`around` can widen it. */
export function* scopeOf(
  scope: ResourceDef.Scope | undefined,
  ctx: ServerDef.Ctx,
): Operation<Spec.Filter | undefined> {
  if (!scope) {
    return undefined
  }

  return ((yield* scope(ctx)) as Spec.Filter | null | undefined) ?? undefined
}

/** The values a scope PINS onto a written row (nested `and`s flattened, `eq` → value, `isNull`
 * → `null`) — a scope that pins nothing exact cannot shape a create/replace. */
export function* stampOf(
  scope: Spec.Filter | undefined,
): Operation<Readonly<Record<string, unknown>>> {
  if (scope === undefined) {
    return {}
  }

  const values = filterValues(scope)

  if (values === null) {
    return yield* fail(
      ServerErrors.Configuration,
      'this scope pins no exact values (`or`/`not`/ranges) — it cannot shape a create/replace; make it eq-shaped or disable those actions',
    )
  }

  return values
}

// --- runnable ops ----------------------------------------------------------------------------

/** The ctx a runnable op works with: the given override, or the AMBIENT dispatch ctx (planted
 * around every action handler and socket handler). */
export function* opCtx(given: ServerDef.Ctx | undefined): Operation<ServerDef.Ctx> {
  if (given) {
    return given
  }

  const ambient = yield* CtxRef.get()

  if (ambient) {
    return ambient
  }

  return yield* fail(
    ServerErrors.Configuration,
    'crud ops read the dispatch ctx — call them inside a handler, or pass `ctx`',
  )
}

const looseDb = (): Operation<Helpers.LooseDb> => useDb() as Operation<Helpers.LooseDb>

function* opEnv(options: ResourceDef.OpOptions): Operation<Helpers.OpEnv> {
  if (options.db) {
    const ctx = options.ctx ?? (yield* CtxRef.get()) ?? null
    return { db: options.db, headers: ctx?.headers ?? {}, ctx }
  }

  const ctx = yield* opCtx(options.ctx)
  return { db: yield* looseDb(), headers: ctx.headers, ctx }
}

/** Every op is its own child span when a ctx is reachable (`crud.<op> <table>`). */
const spanned = <T>(env: Helpers.OpEnv, name: string, body: () => Operation<T>): Operation<T> =>
  env.ctx ? env.ctx.span(name, body) : body()

/** The write ops' version gate: omitted = the ambient `If-Match` header, `false` = none. */
const versionFor = (
  headers: Readonly<Record<string, string>>,
  ifVersion: string | false | undefined,
): string | undefined => (ifVersion === false ? undefined : (ifVersion ?? ifMatch(headers)))

/** A trusted `scope` filter AND-ed under the (sanitized) client filter. */
export const combine = (scope: Spec.Filter | undefined | null, client: AnyType): AnyType =>
  scope ? (client ? { op: 'and', filters: [scope, client] } : scope) : client

/** Write options carrying both gates: the version and the trusted scope. */
const guard = (
  headers: Readonly<Record<string, string>>,
  options: {
    readonly ifVersion?: string | false | undefined
    readonly scope?: Spec.Filter | undefined
  },
) => ({ ifVersion: versionFor(headers, options.ifVersion), scope: options.scope })

const richFields = (
  filterable: ResourceDef.Filterable | undefined,
  table: Schema.Table,
): readonly ResourceDef.FilterableField[] => filterableOf(filterable, table)

/** The built-in list pipeline as one call: sanitized client filter AND-ed with the trusted
 * `scope`, guarded order, clamped limit, keyset pagination — `total: true` also counts the
 * whole set. */
export function* listOp(
  table: Schema.Table,
  options: ResourceDef.ListOp = {},
): Operation<ResourceDef.Page<AnyType>> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.list ${table.name}`, function* () {
    const input = options.input ?? {}
    const fields = richFields(options.filterable, table)
    const maxLimit = options.maxLimit ?? 100
    const client = yield* filterOf(input.filter, fields)
    const filter = combine(options.scope, client)
    let query = env.db.query(table.name)

    if (filter) {
      query = query.filter(filter as AnyType)
    }

    if (input.order) {
      if (!fields.some(entry => entry.field === input.order)) {
        return yield* fail(ServerErrors.BadRequest, `cannot order by "${input.order}"`)
      }

      query = query.order(input.order, input.direction ?? 'asc')
    }

    const page = (yield* query.paginate({
      limit: clampLimit(input.limit ?? maxLimit, maxLimit),
      cursor: input.cursor,
      ...(options.total === true ? { count: true } : {}),
    })) as AnyType

    return {
      data: page.data,
      nextCursor: page.pageInfo.nextCursor,
      prevCursor: page.pageInfo.prevCursor,
      token: page.token,
      ...(options.total === true ? { total: page.total ?? 0 } : {}),
    }
  })
}

/** The size of the (scoped) set — `list`'s counting side alone. */
export function* countOp(
  table: Schema.Table,
  options: ResourceDef.CountOp = {},
): Operation<number> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.count ${table.name}`, function* () {
    const fields = richFields(options.filterable, table)
    const client = yield* filterOf(options.filter, fields)
    const filter = combine(options.scope, client)
    let query = env.db.query(table.name)

    if (filter) {
      query = query.filter(filter as AnyType)
    }

    return yield* query.count()
  })
}

export function* getOp(table: Schema.Table, options: ResourceDef.GetOp): Operation<AnyType> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.get ${table.name}`, function* () {
    const row = yield* env.db.get(table.name, options.id, { scope: options.scope })

    if (!row) {
      if (options.optional === true) {
        return null
      }

      return yield* fail(ServerErrors.NotFound, `${table.name} ${options.id} not found`)
    }

    return row
  })
}

export function* createOp(table: Schema.Table, options: ResourceDef.CreateOp): Operation<AnyType> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.create ${table.name}`, function* () {
    const pins = yield* stampOf(options.scope)
    return yield* env.db.insert(table.name, { ...(options.value as object), ...pins } as AnyType)
  })
}

export function* createManyOp(
  table: Schema.Table,
  options: ResourceDef.CreateManyOp,
): Operation<readonly AnyType[]> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.create-many ${table.name}`, function* () {
    const pins = yield* stampOf(options.scope)

    return yield* env.db.insertMany(
      table.name,
      options.values.map(value => ({ ...(value as object), ...pins })) as AnyType[],
    )
  })
}

export function* updateOp(table: Schema.Table, options: ResourceDef.UpdateOp): Operation<AnyType> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.update ${table.name}`, function* () {
    // EVERY field the scope references is the scope's, never the caller's — dropped from the
    // patch, so a patch cannot move the row out of scope (ranges included, not just `eq`s)
    const owned = options.scope === undefined ? [] : filterFields(options.scope)
    const patch =
      owned.length === 0
        ? options.patch
        : Object.fromEntries(
            Object.entries(options.patch as Record<string, unknown>).filter(
              ([key]) => !owned.includes(key),
            ),
          )
    const row = yield* env.db.patch(
      table.name,
      options.id,
      patch as AnyType,
      guard(env.headers, options),
    )

    if (!row) {
      return yield* fail(ServerErrors.NotFound, `${table.name} ${options.id} not found`)
    }

    return row
  })
}

export function* replaceOp(
  table: Schema.Table,
  options: ResourceDef.ReplaceOp,
): Operation<AnyType> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.replace ${table.name}`, function* () {
    const pins = yield* stampOf(options.scope)
    const row = yield* env.db.replace(
      table.name,
      options.id,
      { ...(options.value as object), ...pins } as AnyType,
      guard(env.headers, options),
    )

    if (!row) {
      return yield* fail(ServerErrors.NotFound, `${table.name} ${options.id} not found`)
    }

    return row
  })
}

export function* removeOp(
  table: Schema.Table,
  options: ResourceDef.RemoveOp,
): Operation<{ removed: boolean }> {
  const env = yield* opEnv(options)

  return yield* spanned(env, `crud.remove ${table.name}`, function* () {
    const removed = yield* env.db.delete(table.name, options.id, guard(env.headers, options))

    if (!removed && options.strict === true) {
      return yield* fail(ServerErrors.NotFound, `${table.name} ${options.id} not found`)
    }

    return { removed }
  })
}

// --- realtime --------------------------------------------------------------------------------

/**
 * The realtime handshake guard: a presented bearer — the `authorization` header, or the token
 * of a first `{ t: 'auth' }` frame (browsers cannot set WS headers; tokens never travel in the
 * URL) — is ALWAYS verified: an expired or malformed token rejects even on an open resource.
 * The resource's `read` requirement gates who may subscribe; the verified principal is
 * RESOLVED so the edge plants it as the socket ctx's `auth`.
 */
export const guardHandshake = (resource: ResourceDef.RealtimeSource) =>
  function* (request: Request, token?: string): Operation<unknown> {
    const requirement = (resource.auth.read ?? false) as AuthDef.Requirement
    const header = request.headers.get('authorization')
    const headers: Record<string, string> = {}

    if (header !== null) {
      headers['authorization'] = header
    } else if (token !== undefined) {
      headers['authorization'] = `Bearer ${token}`
    }

    const auth = yield* Auth.context.get()

    if (!auth) {
      if (requirement !== false) {
        return yield* fail(
          ServerErrors.Unauthorized,
          'this resource requires auth, but no Auth plugin is installed',
          'auth:missing',
        )
      }

      return
    }

    return yield* Auth.actions.authorize(requirement, headers)
  }

/** One client watch on the realtime socket. */
export function* watch(
  socket: EdgeDef.Socket<AnyType, AnyType>,
  resource: ResourceDef.RealtimeSource,
  incoming: Extract<ResourceDef.ClientFrame, { t: 'watch' }>,
): Operation<void> {
  const { ctx } = socket
  const hooks = resource.hooks

  // the after hook projects outgoing rows: a returned value replaces the sync/delta frame
  // (`t`/`id` pinned back so a careless hook cannot break the protocol)
  const send = function* (out: ResourceDef.ServerFrame): Operation<void> {
    let frame = out

    if (hooks.after && (out.t === 'sync' || out.t === 'delta')) {
      const replaced = yield* hooks.after({
        op: 'watch',
        input: incoming,
        ctx,
        output: out,
      } as AnyType)

      if (replaced !== undefined) {
        frame = { ...(replaced as AnyType), t: out.t, id: out.id } as ResourceDef.ServerFrame
      }
    }

    yield* socket.send(frame)
  }

  // a failing watch must SAY so — an error frame ends this watch, never the whole socket
  const outcome = yield* attempt(function* () {
    let frame = incoming

    if (hooks.before) {
      const replaced = yield* hooks.before({ op: 'watch', input: incoming, ctx } as AnyType)

      if (replaced !== undefined) {
        frame = { ...(replaced as AnyType), t: 'watch', id: incoming.id }
      }
    }

    const client = yield* filterOf(frame.filter, resource.filterable)
    // the trusted per-subscriber scope (tenancy) joins AFTER the sanitizer — its fields need
    // not be in `filterable`, so they never open up to client filtering
    const trusted = yield* scopeOf(resource.scope, ctx)
    const filter = combine(trusted, client)
    let query = (yield* looseDb()).query(resource.table.name)

    if (filter) {
      query = query.filter(filter)
    }

    if (frame.order && resource.filterable.some(entry => entry.field === frame.order!.field)) {
      query = query.order(frame.order.field, frame.order.direction ?? 'asc')
    }

    if (frame.limit !== undefined) {
      yield* windowed({ ctx, resource, frame, query, send })
      return
    }

    const deltas = yield* (query as AnyType).watch({ mode: 'delta', since: frame.since })

    for (;;) {
      const step = yield* deltas.next()

      // the db's watch flow never ends on its own; a closing subscription ends this watch
      if (step.done) {
        return
      }

      const delta = step.value as AnyType

      // the db stamps its primed baseline — after a silent `since` resume there is none, and
      // the first emission is a LIVE diff that must go out as a delta, not swallow the sync
      if (delta.baseline === true) {
        yield* send({ t: 'sync', id: frame.id, rows: delta.added, token: delta.token })
        continue
      }

      yield* send({
        t: 'delta',
        id: frame.id,
        added: delta.added,
        changed: delta.changed,
        removed: delta.removed,
        token: delta.token,
      })
    }
  })

  if (isFailure(outcome)) {
    let failure: Result.Failure<unknown> = outcome

    // the error hook may replace the failure (returned or raised) — a watch cannot recover,
    // so anything else keeps the original
    if (hooks.error) {
      const error = hooks.error
      const replaced = yield* attempt(() =>
        error({ op: 'watch', input: incoming, ctx, failure: outcome } as AnyType),
      )

      if (isFailure(replaced)) {
        failure = replaced
      } else if (isFailure(replaced.value as AnyType)) {
        failure = replaced.value as Result.Failure<unknown>
      }
    }

    yield* attempt(() =>
      socket.send({
        t: 'error',
        id: incoming.id,
        tag: String(failure.error),
        message: failure.message,
      }),
    )
  }
}

/**
 * A WINDOWED watch: the subscription owns one keyset page. Table changes recompute the page
 * (a `limit`-sized read, never the whole set): rows entering/leaving/changing IN the window go
 * out as `delta`; a set that changed AROUND an untouched window (another client's write moved
 * the range or the total) goes out as `notify` — every frame stamped with the page's token, so
 * subscribers track versions uniformly. A new `watch` on the same id (another cursor) replaces
 * the window for THIS subscriber only.
 */
function* windowed({ resource, frame, query, send }: Helpers.WindowedArgs): Operation<void> {
  const limit = Math.max(1, Math.min(frame.limit ?? 1, resource.maxLimit))
  const cursor = cursorOf(frame.cursor)

  const pageOf = () =>
    query.paginate({
      limit,
      cursor,
      // `back` only means something with a real cursor — the start of the set pages forward
      direction: frame.back === true && cursor !== undefined ? 'backward' : 'forward',
      count: true,
    }) as AnyType

  const infoOf = (current: AnyType): ResourceDef.WindowInfo => ({
    next: current.pageInfo.nextCursor,
    prev: current.pageInfo.prevCursor,
    total: current.total ?? 0,
  })

  const versionsOf = (rows: readonly AnyType[]) =>
    new Map(rows.map(row => [String(row._id), String(row._version)]))

  let page = yield* pageOf()
  let info = infoOf(page)
  let prior = versionsOf(page.data as AnyType[])

  yield* send({ t: 'sync', id: frame.id, rows: page.data, token: page.token, page: info })

  const changes = yield* (yield* looseDb()).changes(resource.table.name)

  for (;;) {
    const event = yield* changes.next()

    if (event.done) {
      return
    }

    const token = String((event.value as AnyType)?.token ?? '')

    // the page already reflects this change (a burst lands as ONE recompute)
    if (token !== '' && token <= page.token) {
      continue
    }

    yield* sleep(15)
    const next = yield* pageOf()
    const rows = next.data as AnyType[]
    const ids = new Set(rows.map(row => String(row._id)))
    const before = prior
    const added = rows.filter(row => !before.has(String(row._id)))

    const changed = rows.filter(row => {
      const version = before.get(String(row._id))
      return version !== undefined && version !== String(row._version)
    })

    const removed = [...before.keys()].filter(id => !ids.has(id))
    const nextInfo = infoOf(next)

    if (added.length > 0 || changed.length > 0 || removed.length > 0) {
      yield* send({
        t: 'delta',
        id: frame.id,
        added,
        changed,
        removed,
        token: next.token,
        page: nextInfo,
      })
    } else if (
      nextInfo.total !== info.total ||
      nextInfo.next !== info.next ||
      nextInfo.prev !== info.prev
    ) {
      yield* send({ t: 'notify', id: frame.id, token: next.token, page: nextInfo })
    }

    page = next
    info = nextInfo
    prior = versionsOf(rows)
  }
}

/** The realtime socket handler of one resource: `watch`/`unwatch` frames, one task per watch.
 * The edge validates frames against `receives` and settles auth (a header, or the first
 * `auth` frame) before the handler sees anything — an `auth` frame reaching here is ignored. */
export const realtime = (resource: ResourceDef.RealtimeSource): EdgeDef.SocketHandler =>
  function* (socket) {
    const watches = new Map<string, { halt(): Operation<void> }>()
    const messages = yield* socket.messages

    for (;;) {
      const step = yield* messages.next()

      if (step.done) {
        return
      }

      const frame = step.value as ResourceDef.ClientFrame

      // only watch/unwatch address a subscription — and only they may replace one
      if (frame.t !== 'watch' && frame.t !== 'unwatch') {
        continue
      }

      const running = watches.get(frame.id)

      if (running) {
        yield* running.halt()
        watches.delete(frame.id)
      }

      if (frame.t === 'watch') {
        const task = yield* fork(() => scoped(() => watch(socket, resource, frame)))
        watches.set(frame.id, task)
      }
    }
  }
