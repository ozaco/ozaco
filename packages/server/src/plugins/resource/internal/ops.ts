// oxlint-disable import/exports-last
import type { Change, Schema, Spec } from 'db:core'
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
import { CtxRef, ServerErrors, statusOf, tagOf } from 'server:core'
import { dispatchSpan, EXCEPTION_EVENT_NAME, scopeOf as traceScopeOf } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt, ensure, fork, scoped, sleep, until, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace, TraceSeverity } from 'std:trace'

import { z } from 'zod'

import type { AuthDef } from '../../auth'
import { Auth } from '../../auth'
import { AuthCauses } from '../../auth/errors'
import { CrudCauses } from '../errors'
import type { Helpers } from '../types/helpers'
import type { ResourceDef } from '../types/resource'

/** The instrumentation scope of every crud span (`@ozaco/server/crud`). */
const CRUD_SCOPE = traceScopeOf('crud')

/** The span event of a hook that REPLACED what flowed through it. */
const HOOK_EVENT = 'crud.hook'

/** How a crud op span classifies a failure escaping it — like the action it runs in: the server's
 * status table and tags (the dispatch span's own classifier, with the action's `errors`, wins). */
const OP_FAILURE: TraceDef.FailureOptions = {
  status: failure => statusOf(failure),
  type: tagOf,
  eventName: EXCEPTION_EVENT_NAME.action,
}

/** A failed watch is an ERROR whatever its tag: the subscriber only gets an error frame. */
const WATCH_FAILURE: TraceDef.FailureOptions = {
  status: () => 500,
  type: tagOf,
  eventName: EXCEPTION_EVENT_NAME.action,
}

/** The most `change.writer` links one live push carries (the latest writers win). */
const MAX_WRITER_LINKS = 8

/** How many writers a delta watch's feed keeps before the oldest go unlinked. */
const WRITER_RING = 64

/** How many scheduler turns a push lets the writer feed catch up to its token. */
const CATCH_UP_TURNS = 16

/** A hook REPLACED what flowed through it (`before`/`around` the input, `after`/`around` the
 * output, `error` the failure): `crud.hook` on the op's span `at` (a built-in's DISPATCH
 * span, a watch's own span). */
const hookEvent = (
  at: TraceDef.SpanHandle,
  phase: 'before' | 'after' | 'around' | 'error',
): void => {
  at.addEvent(HOOK_EVENT, { 'ozaco.crud.hook.phase': phase })
}

/** Whether `outer` carries `inner` among its nested causes, at any depth (each failure walked
 * once — a cyclic chain ends). */
const wraps = (outer: Result.Failure<unknown>, inner: Result.Failure<unknown>): boolean => {
  const seen = new Set<Result.Failure<unknown>>([outer])
  // an explicit stack, not recursion: a chain of any depth never overflows the call stack
  const stack: Result.Failure<unknown>[] = [outer]

  while (stack.length > 0) {
    const at = stack.pop() as Result.Failure<unknown>

    for (const cause of at.causes) {
      if (typeof cause === 'string') {
        continue
      }

      if (cause === inner) {
        return true
      }

      if (!seen.has(cause)) {
        seen.add(cause)
        stack.push(cause)
      }
    }
  }

  return false
}

/** An `error` hook replaced `original` with `replacement`: the hook event — and, when the
 * replacement does not wrap it (`fail(tag, message, original)` keeps it as a nested cause), the
 * original recorded handled (WARN) on the op's span `at`, so the failure it hides never
 * disappears. */
function* replacedFailure(
  at: TraceDef.SpanHandle,
  original: Result.Failure<unknown>,
  replacement: Result.Failure<unknown>,
): Operation<void> {
  hookEvent(at, 'error')

  if (!wraps(replacement, original)) {
    yield* at.recordFailure(original, { handled: true })
  }
}

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

    // `json` and `blob` have no wire schema of their own: a json column is whatever the app
    // stores, a blob is bytes the handler must encode itself (crud does not base64 for you)
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
 *
 * Telemetry lands on the DISPATCH span (the built-in's op — `dispatchSpan()`, even under a
 * plugin span wrapping the chain, such as a cache span): a hook that REPLACES the input, the
 * output or the failure adds `crud.hook` (`ozaco.crud.hook.phase`); an `error` hook that
 * RECOVERS sets `ozaco.crud.recovered` and records the failure it swallowed (handled, WARN) — as
 * does one that replaces it with an UNRELATED failure (a wrap keeps it as a nested cause).
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

  const chain = function* (
    at: TraceDef.SpanHandle,
    input: AnyType,
    ctx: ServerDef.Ctx,
  ): Operation<AnyType> {
    let value = input

    if (hooks.before) {
      const replaced = yield* hooks.before({ op, input: value, ctx } as AnyType)

      if (replaced !== undefined) {
        value = replaced
        hookEvent(at, 'before')
      }
    }

    let output = yield* handler({ input: value, ctx })

    if (hooks.after) {
      const replaced = yield* hooks.after({ op, input: value, ctx, output } as AnyType)

      if (replaced !== undefined) {
        output = replaced
        hookEvent(at, 'after')
      }
    }

    return output
  }

  /** `around` owns the call: it REPLACED it when it passed `next` another input, or answered
   * with something other than what `next` returned (or never called it). */
  // oxlint-disable-next-line max-params -- the span · the hook · the call's input and ctx
  const surround = function* (
    at: TraceDef.SpanHandle,
    around: NonNullable<ResourceDef.CrudHooks<AnyType>['around']>,
    input: AnyType,
    ctx: ServerDef.Ctx,
  ): Operation<AnyType> {
    let inner: { readonly input: AnyType; readonly output: AnyType } | null = null
    const output = yield* around({ op, input, ctx } as AnyType, function* (value: AnyType) {
      const result = yield* chain(at, value, ctx)

      inner = { input: value, output: result }

      return result
    })
    const seen = inner as { readonly input: AnyType; readonly output: AnyType } | null

    if (!seen || seen.input !== input || seen.output !== output) {
      hookEvent(at, 'around')
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
    // the built-in's op IS its dispatch span — whatever plugin span is active around the handler
    const dispatch = yield* dispatchSpan()
    const invoke = around
      ? () => surround(dispatch, around, input, ctx)
      : () => chain(dispatch, input, ctx)

    if (!error) {
      return yield* invoke()
    }

    const outcome = yield* attempt(invoke)

    if (!isFailure(outcome)) {
      return outcome.value
    }

    // raised or returned, a failure from the hook replaces the original
    const verdict = yield* attempt(() => error({ op, input, ctx, failure: outcome } as AnyType))
    const replaced = isFailure(verdict) ? verdict : verdict.value

    if (replaced === undefined) {
      return yield* outcome
    }

    if (isFailure(replaced as AnyType)) {
      const failure = replaced as Result.Failure<unknown>

      if (failure !== outcome) {
        yield* replacedFailure(dispatch, outcome, failure)
      }

      return yield* failure
    }

    // RECOVERED: the answer is the hook's — the failure it swallowed stays visible
    dispatch.setAttribute('ozaco.crud.recovered', true)
    hookEvent(dispatch, 'error')
    yield* dispatch.recordFailure(outcome, { handled: true })

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

    return { db: options.db, headers: ctx?.headers ?? {} }
  }

  const ctx = yield* opCtx(options.ctx)

  return { db: yield* looseDb(), headers: ctx.headers }
}

/**
 * A RUNNABLE op (`crud.list(table, …)` inside a custom action, a hook, a script): its own span
 * `crud.{op} {table}` under the active one — none without a recording parent — carrying
 * `ozaco.crud.scoped`. The db spans it causes nest under it (they carry the `db.*` keys).
 */
function* runnable<T>(
  call: Helpers.OpCall,
  pipeline: (env: Helpers.OpEnv) => Operation<T>,
): Operation<T> {
  const env = yield* opEnv(call.options)

  return yield* Trace.actions.span(
    `crud.${call.op} ${call.table.name}`,
    {
      kind: 'internal',
      scope: CRUD_SCOPE,
      requireParent: true,
      attributes: { 'ozaco.crud.scoped': call.options.scope !== undefined },
      failure: OP_FAILURE,
    },
    () => pipeline(env),
  )
}

/** A BUILT-IN action's op: the dispatch span IS the op — no span of its own, `ozaco.crud.scoped`
 * goes on the dispatch span (`dispatchSpan()`, even under a plugin span wrapping the chain). */
function* builtin<T>(
  options: Helpers.OpCall['options'],
  pipeline: (env: Helpers.OpEnv) => Operation<T>,
): Operation<T> {
  const env = yield* opEnv(options)
  const dispatch = yield* dispatchSpan()

  dispatch.setAttribute('ozaco.crud.scoped', options.scope !== undefined)

  return yield* pipeline(env)
}

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
function* listIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.ListOp,
): Operation<ResourceDef.Page<AnyType>> {
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
}

/** The size of the (scoped) set — `list`'s counting side alone. */
function* countIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.CountOp,
): Operation<number> {
  const fields = richFields(options.filterable, table)
  const client = yield* filterOf(options.filter, fields)
  const filter = combine(options.scope, client)
  let query = env.db.query(table.name)

  if (filter) {
    query = query.filter(filter as AnyType)
  }

  return yield* query.count()
}

function* getIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.GetOp,
): Operation<AnyType> {
  const row = yield* env.db.get(table.name, options.id, { scope: options.scope })

  if (!row) {
    if (options.optional === true) {
      return null
    }

    return yield* fail(
      ServerErrors.NotFound,
      `${table.name} ${options.id} not found`,
      CrudCauses.Get,
    )
  }

  return row
}

function* createIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.CreateOp,
): Operation<AnyType> {
  const pins = yield* stampOf(options.scope)

  return yield* env.db.insert(table.name, { ...(options.value as object), ...pins } as AnyType)
}

function* createManyIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.CreateManyOp,
): Operation<readonly AnyType[]> {
  const pins = yield* stampOf(options.scope)

  return yield* env.db.insertMany(
    table.name,
    options.values.map(value => ({ ...(value as object), ...pins })) as AnyType[],
  )
}

function* updateIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.UpdateOp,
): Operation<AnyType> {
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
    return yield* fail(
      ServerErrors.NotFound,
      `${table.name} ${options.id} not found`,
      CrudCauses.Update,
    )
  }

  return row
}

function* replaceIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.ReplaceOp,
): Operation<AnyType> {
  const pins = yield* stampOf(options.scope)
  const row = yield* env.db.replace(
    table.name,
    options.id,
    { ...(options.value as object), ...pins } as AnyType,
    guard(env.headers, options),
  )

  if (!row) {
    return yield* fail(
      ServerErrors.NotFound,
      `${table.name} ${options.id} not found`,
      CrudCauses.Replace,
    )
  }

  return row
}

function* removeIn(
  env: Helpers.OpEnv,
  table: Schema.Table,
  options: ResourceDef.RemoveOp,
): Operation<{ removed: boolean }> {
  const removed = yield* env.db.delete(table.name, options.id, guard(env.headers, options))

  if (!removed && options.strict === true) {
    return yield* fail(
      ServerErrors.NotFound,
      `${table.name} ${options.id} not found`,
      CrudCauses.Remove,
    )
  }

  return { removed }
}

/** `crud.list(table, …)` — the built-in list pipeline, runnable (its span `crud.list {table}`). */
export function* listOp(
  table: Schema.Table,
  options: ResourceDef.ListOp = {},
): Operation<ResourceDef.Page<AnyType>> {
  return yield* runnable({ op: 'list', table, options }, env => listIn(env, table, options))
}

/** `crud.count(table, …)` — the size of the (scoped) set, runnable. */
export function* countOp(
  table: Schema.Table,
  options: ResourceDef.CountOp = {},
): Operation<number> {
  return yield* runnable({ op: 'count', table, options }, env => countIn(env, table, options))
}

export function* getOp(table: Schema.Table, options: ResourceDef.GetOp): Operation<AnyType> {
  return yield* runnable({ op: 'get', table, options }, env => getIn(env, table, options))
}

export function* createOp(table: Schema.Table, options: ResourceDef.CreateOp): Operation<AnyType> {
  return yield* runnable({ op: 'create', table, options }, env => createIn(env, table, options))
}

export function* createManyOp(
  table: Schema.Table,
  options: ResourceDef.CreateManyOp,
): Operation<readonly AnyType[]> {
  return yield* runnable({ op: 'create-many', table, options }, env =>
    createManyIn(env, table, options),
  )
}

export function* updateOp(table: Schema.Table, options: ResourceDef.UpdateOp): Operation<AnyType> {
  return yield* runnable({ op: 'update', table, options }, env => updateIn(env, table, options))
}

export function* replaceOp(
  table: Schema.Table,
  options: ResourceDef.ReplaceOp,
): Operation<AnyType> {
  return yield* runnable({ op: 'replace', table, options }, env => replaceIn(env, table, options))
}

export function* removeOp(
  table: Schema.Table,
  options: ResourceDef.RemoveOp,
): Operation<{ removed: boolean }> {
  return yield* runnable({ op: 'remove', table, options }, env => removeIn(env, table, options))
}

/**
 * The ops as the BUILT-IN crud actions run them: the same pipelines, but the dispatch span IS
 * the op — no span of their own (a `crud.list todos` under `todos.list` would only repeat it),
 * `ozaco.crud.scoped` on the dispatch span.
 */
export const builtinOps = {
  list: (table: Schema.Table, options: ResourceDef.ListOp) =>
    builtin(options, env => listIn(env, table, options)),
  get: (table: Schema.Table, options: ResourceDef.GetOp) =>
    builtin(options, env => getIn(env, table, options)),
  create: (table: Schema.Table, options: ResourceDef.CreateOp) =>
    builtin(options, env => createIn(env, table, options)),
  update: (table: Schema.Table, options: ResourceDef.UpdateOp) =>
    builtin(options, env => updateIn(env, table, options)),
  replace: (table: Schema.Table, options: ResourceDef.ReplaceOp) =>
    builtin(options, env => replaceIn(env, table, options)),
  remove: (table: Schema.Table, options: ResourceDef.RemoveOp) =>
    builtin(options, env => removeIn(env, table, options)),
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
          AuthCauses.Missing,
        )
      }

      return
    }

    return yield* Auth.actions.authorize(requirement, headers)
  }

/** The writer of one change: the span its write ran under (`Change.Event.meta` — a dispatch
 * ships its span as bus meta while it records). */
function* writerOf(event: Change.Event): Operation<TraceDef.SpanContext | null> {
  return event.meta ? yield* Trace.actions.extract(name => event.meta?.[name] ?? null) : null
}

const linkOf = (context: TraceDef.SpanContext, reason: string): TraceDef.LinkInput => ({
  context,
  attributes: { 'ozaco.link.reason': reason },
})

/** The same span once (a transaction's writes share their writer), the latest `MAX_WRITER_LINKS`. */
const distinct = (contexts: readonly TraceDef.SpanContext[]): TraceDef.SpanContext[] => {
  const byId = new Map(contexts.map(context => [context.spanId, context]))

  return [...byId.values()].slice(-MAX_WRITER_LINKS)
}

/** The ids of the rows a delta carries: added, changed and removed. */
const rowsOf = (delta: AnyType): ReadonlySet<string> =>
  new Set([
    ...[...(delta.added ?? []), ...(delta.changed ?? [])].map((row: AnyType) =>
      String(row?.[FIELDS.id]),
    ),
    ...(delta.removed ?? []).map(String),
  ])

/**
 * The writers of a DELTA watch's changes — its emissions carry only the resulting diff, so the
 * table's change feed is followed beside it (subscribed BEFORE the watch, so no change it reacts
 * to is missed): a bounded ring of (token, row id, writer) a push reflecting token `T` takes the
 * writers up to `T` from — only those of the rows the push carries (a change of another row, one
 * outside the query, recomputed to an empty diff and is no writer of this push; a table-level
 * `touch` has no row and may be behind any of them). Every entry up to `T` leaves the ring. The
 * hub fans a change out to every subscriber at once, so the feed has it queued when the watch
 * emits — the take lets the feed catch up to `T` first (a few scheduler turns at most, never a
 * wait). Only while tracing records (a feed nobody links is not followed).
 */
function* writerFeed(table: string): Operation<Helpers.Writers> {
  const ring: {
    readonly token: string
    readonly id: string
    readonly writer: TraceDef.SpanContext
  }[] = []
  let seen = ''

  yield* fork(function* () {
    const events = yield* (yield* looseDb()).changes(table)

    for (;;) {
      const step = yield* events.next()

      if (step.done) {
        return
      }

      const writer = yield* writerOf(step.value)

      seen = step.value.token > seen ? step.value.token : seen

      if (writer) {
        ring.push({ token: step.value.token, id: step.value.id, writer })

        if (ring.length > WRITER_RING) {
          ring.shift()
        }
      }
    }
  })

  return function* (token, rows) {
    // `seen` moves on the feed's own task
    const behind = (): boolean => seen < token

    for (let turn = 0; turn < CATCH_UP_TURNS && behind(); turn += 1) {
      yield* until(Promise.resolve())
    }

    const taken = ring.filter(
      entry => entry.token <= token && (entry.id === '' || rows.has(entry.id)),
    )

    ring.splice(0, ring.length, ...ring.filter(entry => entry.token > token))

    return distinct(taken.map(entry => entry.writer))
  }
}

/**
 * One client watch on the realtime socket, in two phases (design §7):
 *
 * - SUBSCRIBE — the span `watch {table}` (under the frame that asked for it, `ozaco.crud.scoped`)
 *   covers the `before` hook, the filter, the subscription and the initial `sync`, nothing more;
 *   `subscribed` is called once it is over (ended or failed — or the watch halted first), so the
 *   socket handler can hold its frame (and the frame's span) open until then;
 * - LIVE — every recompute / push afterwards is its own `record: 'errors'` ROOT
 *   `crud.delta {table}` (exported only when it fails) LINKING the watch span (`crud.watch`) and
 *   the writers of the changes it reflects (`change.writer`, from `Change.Event.meta`); nothing
 *   between two pushes is traced.
 *
 * Both belong to the service that declared the socket (`service.name`, the db spans under them
 * inherit it) — on a gateway serving the socket of a service another node hosts too.
 *
 * A failure ends THIS watch (never the socket): the `error` hook shapes it inside the span it
 * failed in, it is recorded there as an ERROR, and the subscriber gets an `error` frame with the
 * tag and message — plus `recorded`, the `traceparent` of that span, once the failure is recorded
 * in its trace (a subscriber in the same trace then records nothing of its own).
 */
export function* watch(
  socket: EdgeDef.Socket<AnyType, AnyType>,
  resource: ResourceDef.RealtimeSource,
  {
    frame: incoming,
    subscribed,
  }: {
    readonly frame: Extract<ResourceDef.ClientFrame, { t: 'watch' }>
    readonly subscribed: () => void
  },
): Operation<void> {
  // a watch halted (or crashing) before its subscribe phase is over still lets the handler go
  yield* ensure(subscribed)

  const { ctx } = socket
  const hooks = resource.hooks
  const table = resource.table.name
  // the service that declared the socket owns its spans (`service.name`) wherever it is served —
  // a gateway serving a service another node hosts included (never the node's own name)
  const service = ctx.service

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
        // the span sending it: the watch span (the initial sync) or a push's root
        hookEvent(yield* Trace.actions.current(), 'after')
      }
    }

    yield* socket.send(frame)
  }

  // the error hook may replace the failure (returned or raised) — a watch cannot recover, so
  // anything else keeps the original. It runs once, where the watch failed: that span (the
  // watch span, a push's root) records it, and the error frame names it
  let shaped: Helpers.Shaped | null = null

  const shape = function* (failure: Result.Failure<unknown>): Operation<Helpers.Shaped> {
    const at = yield* Trace.actions.current()
    let final = failure

    if (hooks.error) {
      const error = hooks.error
      const replaced = yield* attempt(() =>
        error({ op: 'watch', input: incoming, ctx, failure } as AnyType),
      )
      const verdict = isFailure(replaced) ? replaced : replaced.value

      if (isFailure(verdict as AnyType) && verdict !== failure) {
        final = verdict as Result.Failure<unknown>
        yield* replacedFailure(at, failure, final)
      }
    }

    shaped = { failure: final, at }

    return shaped
  }

  /** `body` with its failure shaped HERE — inside the span it failed in — and raised on. */
  const shaping = function* <T>(body: () => Operation<T>): Operation<T> {
    const outcome = yield* attempt(body)

    if (!isFailure(outcome)) {
      return outcome.value
    }

    return yield* (yield* shape(outcome)).failure
  }

  const subscribe = function* (handle: TraceDef.SpanHandle): Operation<Helpers.Live> {
    let frame = incoming

    if (hooks.before) {
      const replaced = yield* hooks.before({ op: 'watch', input: incoming, ctx } as AnyType)

      if (replaced !== undefined) {
        frame = { ...(replaced as AnyType), t: 'watch', id: incoming.id }
        hookEvent(handle, 'before')
      }
    }

    const client = yield* filterOf(frame.filter, resource.filterable)
    // the trusted per-subscriber scope (tenancy) joins AFTER the sanitizer — its fields need
    // not be in `filterable`, so they never open up to client filtering
    const trusted = yield* scopeOf(resource.scope, ctx)
    const filter = combine(trusted, client)
    let query = (yield* looseDb()).query(table)

    handle.setAttribute('ozaco.crud.scoped', trusted !== undefined)

    if (filter) {
      query = query.filter(filter)
    }

    if (frame.order && resource.filterable.some(entry => entry.field === frame.order!.field)) {
      query = query.order(frame.order.field, frame.order.direction ?? 'asc')
    }

    const args = { resource, frame, query, send }

    return frame.limit === undefined ? yield* deltas(args) : yield* windowed(args)
  }

  const outcome = yield* attempt(function* () {
    let watching: TraceDef.SpanContext | null = null

    const live = yield* Trace.actions.span(
      `watch ${table}`,
      { kind: 'internal', scope: CRUD_SCOPE, service, failure: WATCH_FAILURE },
      function* (handle) {
        watching = handle.recording ? handle.context : null

        return yield* shaping(() => subscribe(handle))
      },
    )

    subscribed()

    const push: Helpers.Push = (writers, body) => {
      const watched = watching as TraceDef.SpanContext | null

      return Trace.actions.span(
        `crud.delta ${table}`,
        {
          kind: 'internal',
          scope: CRUD_SCOPE,
          service,
          parent: null,
          record: 'errors',
          links: [
            ...(watched ? [linkOf(watched, 'crud.watch')] : []),
            ...writers.map(writer => linkOf(writer, 'change.writer')),
          ],
          failure: WATCH_FAILURE,
        },
        () => shaping(body),
      )
    }

    // the live phase belongs to no request: each push is a root of its own
    yield* Trace.actions.detached(() => live(push))
  })

  if (!isFailure(outcome)) {
    return
  }

  // (assigned inside the spans' bodies — TS cannot see it)
  const { failure, at: recorder } = (shaped as Helpers.Shaped | null) ?? (yield* shape(outcome))

  // a subscribe failure may still wait on the frame span that asked for it: settle it now, as the
  // ERROR it is (a no-op once it settled — a push is a root, it settles as it ends)
  yield* Trace.actions.settle(failure, { status: 500 })

  // nothing records here (tracing off): the process fallback sink (if any) gets it
  if (!(yield* Trace.actions.isTracing())) {
    yield* Trace.actions.recordFailure(failure, { severity: TraceSeverity.error })
  }

  // the span it failed in, once the failure is recorded in that span's trace: a subscriber whose
  // watch went out in that trace records nothing of its own
  const recorded =
    recorder.valid && (yield* Trace.actions.isRecorded(failure, recorder.context.traceId))
      ? (yield* Trace.actions.inject({ context: recorder.context })).traceparent
      : undefined

  yield* attempt(() =>
    socket.send({
      t: 'error',
      id: incoming.id,
      tag: tagOf(failure),
      message: failure.message,
      ...(recorded === undefined ? {} : { recorded }),
    }),
  )

  subscribed()
}

/**
 * A DELTA watch (no `limit`): the db's delta-mode watch over the query. Without `since` its primed
 * baseline IS the initial `sync` (sent while subscribing); a `since` resume that is provably
 * current has none — its first emission may be a live diff — so everything it emits is live.
 */
function* deltas({ frame, query, send, resource }: Helpers.WatchArgs): Operation<Helpers.Live> {
  const writers = (yield* Trace.actions.isTracing()) ? yield* writerFeed(resource.table.name) : null
  const flow = yield* (query as AnyType).watch({ mode: 'delta', since: frame.since })

  const emit = function* (delta: AnyType): Operation<void> {
    // the db stamps its primed baseline — after a silent `since` resume there is none, and
    // the first emission is a LIVE diff that must go out as a delta, not swallow the sync
    if (delta.baseline === true) {
      yield* send({ t: 'sync', id: frame.id, rows: delta.added, token: delta.token })

      return
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

  let ended = false

  if (frame.since === undefined) {
    const first = yield* flow.next()

    if (first.done) {
      ended = true
    } else {
      yield* emit(first.value)
    }
  }

  return function* (push) {
    if (ended) {
      return
    }

    // the db's watch flow never ends on its own; a closing subscription ends this watch
    for (;;) {
      // the recompute runs inside the db's flow: a failing one still fails in a push span
      const step = yield* attempt(() => flow.next() as Operation<IteratorResult<AnyType, void>>)

      if (isFailure(step)) {
        yield* push([], () => step)

        return
      }

      if (step.value.done) {
        return
      }

      const delta = step.value.value
      // a baseline (a `since` resume that was not current) reflects no write of its own
      const linked =
        writers && delta.baseline !== true
          ? yield* writers(String(delta.token ?? ''), rowsOf(delta))
          : []

      yield* push(linked, () => emit(delta))
    }
  }
}

/**
 * A WINDOWED watch: the subscription owns one keyset page. Table changes recompute the page
 * (a `limit`-sized read, never the whole set): rows entering/leaving/changing IN the window go
 * out as `delta`; a set that changed AROUND an untouched window (another client's write moved
 * the range or the total) goes out as `notify` — every frame stamped with the page's token, so
 * subscribers track versions uniformly. A new `watch` on the same id (another cursor) replaces
 * the window for THIS subscriber only. Each recompute is a live push linking the change's writer.
 */
function* windowed({ resource, frame, query, send }: Helpers.WatchArgs): Operation<Helpers.Live> {
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

  const infoOf = (at: AnyType): ResourceDef.WindowInfo => ({
    next: at.pageInfo.nextCursor,
    prev: at.pageInfo.prevCursor,
    total: at.total ?? 0,
  })

  const versionsOf = (rows: readonly AnyType[]) =>
    new Map(rows.map(row => [String(row._id), String(row._version)]))

  let page = yield* pageOf()
  let info = infoOf(page)
  let prior = versionsOf(page.data as AnyType[])

  yield* send({ t: 'sync', id: frame.id, rows: page.data, token: page.token, page: info })

  const changes = yield* (yield* looseDb()).changes(resource.table.name)

  /** One recompute: the page again, what moved in or around it out. */
  const recompute = function* (): Operation<void> {
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

  return function* (push) {
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

      const writer = yield* writerOf(event.value as Change.Event)

      yield* push(writer ? [writer] : [], recompute)
    }
  }
}

/** The realtime socket handler of one resource: `watch`/`unwatch` frames, one task per watch.
 * The edge validates frames against `receives` and settles auth (a header, or the first
 * `auth` frame) before the handler sees anything — an `auth` frame reaching here is ignored.
 * A `watch` frame is held until its subscribe phase is over (the edge ends a frame's span at the
 * handler's next pull): `watch {table}` sits INSIDE the frame span that asked for it, and the
 * frames after it are taken in order. */
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
        const ready = withResolvers<void>('crud watch subscribe')
        const task = yield* fork(() =>
          scoped(() => watch(socket, resource, { frame, subscribed: () => ready.resolve() })),
        )

        watches.set(frame.id, task)
        yield* ready.operation
      }
    }
  }
