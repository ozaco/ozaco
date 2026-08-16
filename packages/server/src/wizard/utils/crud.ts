import { DbErrors } from 'db:core'
import type { TableDef } from 'db:core'
import { useResponse } from 'server:core'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../const'
import { WizardErrors } from '../errors'
import { cursorOf, database, ifMatchVersion, limitOf, listQuery } from '../internal'
import type { CrudFns, CrudOptions, Wizard } from '../types'

import { mutation, query } from './fn'

const notFound = (table: string, id: unknown) =>
  fail(WizardErrors.NotFound, `"${table}/${String(id)}" not found`)

/**
 * Generate the six standard fns for a table — spread them into `resource(table, { ...crud(table) })`:
 *
 * - `list` — `GET /` query: `filter` (JSON `Filter`, sanitized against the table's columns),
 *   facet eq-params from `options.filters`, `order`/`direction`, `limit` (clamped) + `cursor`
 *   keyset pagination → `{ data, cursor, version }`. Realtime-watchable.
 * - `get` — `GET /:id`; missing → 404 `server:wizard.not-found`.
 * - `create` — `POST /` mutation → 201 with the stored doc.
 * - `update` — `PATCH /:id`; optional `If-Match: <version>` → 412 `db.conflict` on mismatch.
 * - `replace` — `PUT /:id`, same `If-Match` semantics.
 * - `remove` — `DELETE /:id` → 204; `If-Match` honored.
 */
export const crud = <TTable extends TableDef>(
  table: TTable,
  options?: CrudOptions,
): CrudFns<TTable> => {
  const pipeline: Wizard.ListPipeline = {
    table,
    filters: options?.filters ?? [],
    pageSize: options?.pageSize ?? DEFAULT_PAGE_SIZE,
    maxPageSize: options?.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
  }
  const access = options?.access

  const list = {
    ...query({
      access,
      rest: { method: 'GET', path: '/' },
      watch: true,
      errors: {
        [DbErrors.Validation]: 400,
        [DbErrors.Cursor]: 400,
        [WizardErrors.BadFilter]: 400,
      },
      *handler(args: AnyType) {
        const input = (args ?? {}) as Record<string, unknown>
        const handle = yield* listQuery(pipeline, input)
        const page = yield* handle.paginate({
          cursor: cursorOf(input),
          limit: limitOf(pipeline, input),
        })

        return { data: page.data, cursor: page.pageInfo.nextCursor, version: page.version }
      },
    }),
    pipeline,
  }

  const get = query({
    access,
    rest: { method: 'GET', path: '/:id' },
    errors: { [WizardErrors.NotFound]: 404 },
    *handler(args: AnyType) {
      const db = yield* database()
      const doc = yield* db.get(table.name, String(args.id))

      if (doc === null) {
        return yield* notFound(table.name, args.id)
      }

      return doc
    },
  })

  const create = mutation({
    access,
    rest: { method: 'POST', path: '/' },
    errors: { [DbErrors.Validation]: 400, [DbErrors.Unique]: 409 },
    *handler(args: AnyType) {
      const db = yield* database()
      const doc = yield* db.insert(table.name, (args ?? {}) as AnyType)
      const response = yield* useResponse()

      response.status = 201

      return doc
    },
  })

  const update = mutation({
    access,
    rest: { method: 'PATCH', path: '/:id' },
    errors: {
      [WizardErrors.NotFound]: 404,
      [DbErrors.Validation]: 400,
      [DbErrors.Conflict]: 412,
      [DbErrors.Unique]: 409,
    },
    *handler(args: AnyType) {
      const db = yield* database()
      const { id, ...patch } = args as Record<string, unknown>
      const ifVersion = yield* ifMatchVersion()
      const doc = yield* db.patch(table.name, String(id), patch as AnyType, { ifVersion })

      if (doc === null) {
        return yield* notFound(table.name, id)
      }

      return doc
    },
  })

  const replace = mutation({
    access,
    rest: { method: 'PUT', path: '/:id' },
    errors: {
      [WizardErrors.NotFound]: 404,
      [DbErrors.Validation]: 400,
      [DbErrors.Conflict]: 412,
      [DbErrors.Unique]: 409,
    },
    *handler(args: AnyType) {
      const db = yield* database()
      const { id, ...value } = args as Record<string, unknown>
      const ifVersion = yield* ifMatchVersion()
      const doc = yield* db.replace(table.name, String(id), value as AnyType, { ifVersion })

      if (doc === null) {
        return yield* notFound(table.name, id)
      }

      return doc
    },
  })

  const remove = mutation({
    access,
    rest: { method: 'DELETE', path: '/:id' },
    errors: { [WizardErrors.NotFound]: 404, [DbErrors.Conflict]: 412 },
    *handler(args: AnyType) {
      const db = yield* database()
      const ifVersion = yield* ifMatchVersion()
      const deleted = yield* db.delete(table.name, String(args.id), { ifVersion })

      if (!deleted) {
        return yield* notFound(table.name, args.id)
      }

      // undefined → 204 at the edge
    },
  })

  return { list, get, create, update, replace, remove } as AnyType as CrudFns<TTable>
}
