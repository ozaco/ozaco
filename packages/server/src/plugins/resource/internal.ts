// oxlint-disable import/exports-last
import type { Schema, Spec } from 'db:core'
import { DbErrors, sanitizeFilter } from 'db:core'
import type { EdgeDef, ServerDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, scoped, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

import type { AuthDef } from '../auth'
import { Auth } from '../auth'

import type { ResourceDef } from './types'

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

/** A client filter (object, or a JSON string from a query param) through the sanitizer. */
export function* filterOf(input: unknown, fields: readonly string[]): Operation<AnyType> {
  if (input === undefined || input === null || input === '') {
    return null
  }

  const raw = typeof input === 'string' ? yield* attempt(() => parseJson(input)) : { value: input }

  if (isFailure(raw as AnyType)) {
    return yield* fail(ServerErrors.BadRequest, 'filter is not valid JSON')
  }

  return yield* sanitizeFilter((raw as AnyType).value, { fields })
}

function* parseJson(text: string): Operation<{ value: unknown }> {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return yield* fail(ServerErrors.BadRequest, 'invalid JSON')
  }
}

/**
 * Run the `schema` hook ONCE, synchronously — `crud()` derives its schemas at definition time,
 * outside any scope, so the hook may not suspend: a raised failure is thrown as-is (it refuses
 * the definition), any other yield is a configuration error. `undefined` (or the schema itself)
 * keeps the derived default.
 */
export const shaper =
  (hook: ResourceDef.SchemaHook | undefined) =>
  <T extends z.ZodType>(schema: T, of: ResourceDef.SchemaOf): T => {
    if (!hook) {
      return schema
    }

    const steps = hook(schema as AnyType, of)[Symbol.iterator]()
    const step = steps.next()

    if (!step.done) {
      if (isFailure(step.value as AnyType)) {
        throw step.value
      }

      throw fail(
        ServerErrors.Configuration,
        `the schema hook runs at definition time and must be effect-free — it suspended while deriving "${of}"`,
      )
    }

    return (step.value === undefined ? schema : step.value) as T
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
  hooks: ResourceDef.CrudHooks,
  handler: THandler,
): THandler => {
  if (!hooks.before && !hooks.after && !hooks.around && !hooks.error) {
    return handler
  }

  const chain = function* (input: AnyType, ctx: ServerDef.Ctx): Operation<AnyType> {
    let current = input

    if (hooks.before) {
      const replaced = yield* hooks.before({ op, input: current, ctx })
      current = replaced === undefined ? current : replaced
    }

    let output = yield* handler({ input: current, ctx })

    if (hooks.after) {
      const replaced = yield* hooks.after({ op, input: current, ctx, output })
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
      ? () => around({ op, input, ctx }, value => chain(value, ctx))
      : () => chain(input, ctx)

    if (!error) {
      return yield* invoke()
    }

    const outcome = yield* attempt(invoke)

    if (!isFailure(outcome)) {
      return outcome.value
    }

    const replaced = yield* error({ op, input, ctx, failure: outcome })

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

/**
 * The realtime handshake guard: a presented bearer (`authorization` header, or the `?token=`
 * the edge promotes) is ALWAYS verified — an expired or malformed token rejects the upgrade
 * even on an open resource — and the resource's `read` requirement gates who may subscribe.
 */
export const guardHandshake = (resource: ResourceDef.Crud) =>
  function* (request: Request): Operation<void> {
    const requirement = (resource.auth.read ?? false) as AuthDef.Requirement
    const header = request.headers.get('authorization')
    const queryToken = new URL(request.url).searchParams.get('token')
    const headers: Record<string, string> = {}

    if (header !== null) {
      headers['authorization'] = header
    } else if (queryToken !== null) {
      headers['authorization'] = `Bearer ${queryToken}`
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

    yield* Auth.actions.authorize(requirement, headers)
  }

/** One client watch on the realtime socket. */
export function* watch(
  socket: EdgeDef.Socket,
  resource: ResourceDef.Crud,
  incoming: Extract<ResourceDef.ClientFrame, { t: 'watch' }>,
): Operation<void> {
  const { ctx } = socket
  const hooks = resource.hooks

  // the after hook projects outgoing rows: a returned value replaces the sync/delta frame
  // (`t`/`id` pinned back so a careless hook cannot break the protocol)
  const send = function* (out: ResourceDef.ServerFrame): Operation<void> {
    let frame = out

    if (hooks.after && (out.t === 'sync' || out.t === 'delta')) {
      const replaced = yield* hooks.after({ op: 'watch', input: incoming, ctx, output: out })

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
      const replaced = yield* hooks.before({ op: 'watch', input: incoming, ctx })

      if (replaced !== undefined) {
        frame = { ...(replaced as AnyType), t: 'watch', id: incoming.id }
      }
    }

    const filter = yield* filterOf(frame.filter, resource.filterable)
    let query = ctx.db.query(resource.table.name)

    if (filter) {
      query = query.filter(filter)
    }

    if (frame.order && resource.filterable.includes(frame.order.field)) {
      query = query.order(frame.order.field, frame.order.direction ?? 'asc')
    }

    if (frame.limit !== undefined) {
      yield* windowed({ ctx, resource, frame, query, send })
      return
    }

    const deltas = yield* (query as AnyType).watch({ mode: 'delta', since: frame.since })

    for (;;) {
      const step = yield* deltas.next()
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
        error({ op: 'watch', input: incoming, ctx, failure: outcome }),
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

interface WindowedArgs {
  readonly ctx: ServerDef.Ctx
  readonly resource: ResourceDef.Crud
  readonly frame: Extract<ResourceDef.ClientFrame, { t: 'watch' }>
  readonly query: AnyType

  /** the watch's (hook-aware) frame sender. */
  readonly send: (out: ResourceDef.ServerFrame) => Operation<void>
}

/**
 * A WINDOWED watch: the subscription owns one keyset page. Table changes recompute the page
 * (a `limit`-sized read, never the whole set): rows entering/leaving/changing IN the window go
 * out as `delta`; a set that changed AROUND an untouched window (another client's write moved
 * the range or the total) goes out as `notify` — every frame stamped with the page's token, so
 * subscribers track versions uniformly. A new `watch` on the same id (another cursor) replaces
 * the window for THIS subscriber only.
 */
function* windowed({ ctx, resource, frame, query, send }: WindowedArgs): Operation<void> {
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

  const changes = yield* ctx.db.changes(resource.table.name)

  for (;;) {
    const event = yield* changes.next()
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

/** The realtime socket handler of one resource: `watch`/`unwatch` frames, one task per watch. */
export const realtime = (resource: ResourceDef.Crud): EdgeDef.SocketHandler =>
  function* (socket) {
    const watches = new Map<string, { halt(): Operation<void> }>()
    const messages = yield* socket.messages

    for (;;) {
      const step = yield* messages.next()

      if (step.done) {
        return
      }

      const frame = step.value as ResourceDef.ClientFrame
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
