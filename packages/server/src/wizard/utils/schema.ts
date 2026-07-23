import type { Infer, Page, TableDef } from 'db:realtime'

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
