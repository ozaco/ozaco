// oxlint-disable import/exports-last
import type { Schema, Spec } from 'db:core'
import { DbErrors, sanitizeFilter } from 'db:core'
import type { EdgeDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, scoped, sleep } from 'std:effect'
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
    _createdAt: z.coerce.date(),
    _updatedAt: z.coerce.date(),
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
  frame: Extract<ResourceDef.ClientFrame, { t: 'watch' }>,
): Operation<void> {
  const { ctx } = socket
  const send = (out: ResourceDef.ServerFrame) => socket.send(out)
  const filter = yield* attempt(() => filterOf(frame.filter, resource.filterable))

  if (isFailure(filter)) {
    yield* send({ t: 'error', id: frame.id, tag: String(filter.error), message: filter.message })
    return
  }

  let query = ctx.db.query(resource.table.name)

  if (filter.value) {
    query = query.filter(filter.value)
  }

  if (frame.order && resource.filterable.includes(frame.order.field)) {
    query = query.order(frame.order.field, frame.order.direction ?? 'asc')
  }

  // a failing watch must SAY so — an error frame ends this watch, never the whole socket
  const outcome = yield* attempt(function* () {
    if (frame.limit !== undefined) {
      yield* windowed(socket, resource, frame, query)
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
    yield* attempt(() =>
      send({ t: 'error', id: frame.id, tag: String(outcome.error), message: outcome.message }),
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
// oxlint-disable-next-line max-params -- socket · resource · frame · prepared query
function* windowed(
  socket: EdgeDef.Socket,
  resource: ResourceDef.Crud,
  frame: Extract<ResourceDef.ClientFrame, { t: 'watch' }>,
  query: AnyType,
): Operation<void> {
  const { ctx } = socket
  const send = (out: ResourceDef.ServerFrame) => socket.send(out)
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
