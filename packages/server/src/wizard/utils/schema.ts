import type { Infer, MongoFilter, Page, TableDef } from 'db:realtime'

import { z } from 'zod'
import type { ZodType } from 'zod'

/** Docs-compatible output validator for one stored table document (validated fields + system fields:
 * `_id`, `_createdAt`, and the `_version` optimistic-concurrency token). Typed as `ZodType<Infer<T>>`
 * so an action's `returns: doc(table)` yields a precise row result type. */
export const doc = <T extends TableDef>(table: T): ZodType<Infer<T>> =>
  table.validator.extend({
    _id: z.string(),
    _createdAt: z.number(),
    _version: z.number(),
  }) as unknown as ZodType<Infer<T>>

/** Docs-compatible output validator for a list of stored table documents. */
export const docs = <T extends TableDef>(table: T): ZodType<readonly Infer<T>[]> =>
  z.array(doc(table)) as unknown as ZodType<readonly Infer<T>[]>

/** Forward/backward cursor window metadata (spec §0.1 `pageInfo`). */
export const pageInfo = () =>
  z.object({
    nextCursor: z.string().nullable(),
    prevCursor: z.string().nullable(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
  })

/** Docs-compatible output validator for a cursor-paginated table result (spec §0.1 list envelope). */
export const page = <T extends TableDef>(table: T): ZodType<Page<Infer<T>>> =>
  z.object({
    data: docs(table),
    pageInfo: pageInfo(),
    resourceVersion: z.string(),
    estimatedCount: z.number().optional(),
  }) as unknown as ZodType<Page<Infer<T>>>

/**
 * The reactive payload a CRUD `list` watch emits — the shape a `.watch(...)` receives, distinct from
 * the one-shot `page` (spec §0.1 watch stream). A `sync` frame carries the current window once on
 * subscribe; then `added`/`modified`/`removed` deltas stream row changes scoped to that window. Every
 * frame carries the current `pageInfo`, so the client's `nextCursor`/`prevCursor` stay accurate as the
 * window mutates (a later page navigation re-subscribes with a fresh boundary). A `reset` frame is the
 * stream equivalent of `410 Gone` — the client's `resourceVersion` is stale (server regressed), so it
 * should drop its cached window and refetch the first page.
 */
export const collectionEvent = (table: TableDef) =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('reset'),
      resourceVersion: z.string(),
    }),
    z.object({
      type: z.literal('sync'),
      resourceVersion: z.string(),
      pageInfo: pageInfo(),
      data: docs(table),
    }),
    z.object({
      type: z.literal('added'),
      resourceVersion: z.string(),
      pageInfo: pageInfo(),
      row: doc(table),
    }),
    z.object({
      type: z.literal('modified'),
      resourceVersion: z.string(),
      pageInfo: pageInfo(),
      row: doc(table),
    }),
    z.object({
      type: z.literal('removed'),
      resourceVersion: z.string(),
      pageInfo: pageInfo(),
      id: z.string(),
    }),
  ])

/**
 * A MongoDB-style filter validator over a table's fields (+ the `_id`/`_createdAt`/`_version` system
 * fields). Each field maps to a bare value or an operator object (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/
 * `$lte`/`$in`/`$nin`/`$like`/`$contains`/`$startsWith`/`$endsWith`/`$exists`), combinable with
 * `$and`/`$or`/`$not`. `.strict()` at every level rejects unknown keys, so an unknown field or operator
 * is a 400 instead of a silently-ignored filter. Use it in a CRUD `list` arg (already wired) or any
 * custom action: `args: z.object({ filter: filter(table).optional() })`, then
 * `db.query(table).match(body.filter)`.
 */
export const filter = <T extends TableDef>(table: T): ZodType<MongoFilter<Infer<T>>> => {
  const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
  const ops = z
    .object({
      $eq: scalar.optional(),
      $ne: scalar.optional(),
      $gt: scalar.optional(),
      $gte: scalar.optional(),
      $lt: scalar.optional(),
      $lte: scalar.optional(),
      $in: z.array(scalar).optional(),
      $nin: z.array(scalar).optional(),
      $like: z.string().optional(),
      $contains: z.string().optional(),
      $startsWith: z.string().optional(),
      $endsWith: z.string().optional(),
      $exists: z.boolean().optional(),
    })
    .strict()
  const field = z.union([scalar, ops])
  const names = [...table.columns.map(column => column.name), '_id', '_createdAt', '_version']
  const node: ZodType = z.lazy(() =>
    z
      .object({
        ...Object.fromEntries(names.map(name => [name, field.optional()])),
        $and: z.array(node).optional(),
        $or: z.array(node).optional(),
        $not: node.optional(),
      })
      .strict(),
  )
  return node as unknown as ZodType<MongoFilter<Infer<T>>>
}
