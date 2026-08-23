// oxlint-disable import/exports-last
import type { Schema, Spec } from 'db:core'
import { DbErrors, sanitizeFilter } from 'db:core'
import type { EdgeDef } from 'server:core'
import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, fork, scoped } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { z } from 'zod'

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

  // (watches are unbounded: a delta stream has no page; `limit` is for `list`)
  const deltas = yield* (query as AnyType).watch({ mode: 'delta', since: frame.since })
  let first = true

  for (;;) {
    const step = yield* deltas.next()
    const delta = step.value as AnyType

    if (first) {
      first = false
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
