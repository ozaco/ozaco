import type { Schema } from 'db:core'
import type { Operation } from 'std:effect'

import { builder, pageFor, realtimeAction } from './internal/builder'
import {
  countOp,
  createManyOp,
  createOp,
  docSchema,
  ERRORS,
  getOp,
  insertSchema,
  listInput,
  listOp,
  patchSchema,
  removeOp,
  replaceOp,
  updateOp,
} from './internal/ops'
import type { Helpers } from './types/helpers'
import type { ResourceDef } from './types/resource'

/**
 * `crud(table, options)` builds the service; the RUNNABLE ops on it (`crud.list(table, …)`,
 * `crud.get`, …) are the same pipelines as single calls inside ANY handler — they read the
 * dispatch ctx ambiently (pass `ctx` outside one), so a custom action owns its route, schemas,
 * errors and tags while the crud mechanics stay one `yield*` away. `crud.realtime(table, …)`
 * is the delta-watch socket as an `action.socket` entry, `crud.errors` the db failure → status
 * map, and `crud.schemas` the derived building blocks (`doc`/`insert`/`patch`/`listInput`/
 * `page`) for the custom action's own declarations.
 *
 * Telemetry: a runnable op is its own span `crud.{op} {table}` under the active one (none without
 * a recording parent), `ozaco.crud.scoped` on it; the BUILT-IN actions open none — their dispatch
 * span is the op. The db spans underneath carry the `db.*` keys. A `server.not-found` an op
 * raises names the op that missed (`CrudCauses`).
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
