import type { Infer, InferInsert, Page, TableDef } from 'db:realtime'
import type { Action, Service } from 'server:core'

import type { AccessGuard } from './access'
import type { FnModule, Mutation, Query } from './action'

/** Transport for a resource's own realtime channel (`/<ns>/_realtime`). */
export type RealtimeTransport = 'websocket' | 'sse'

export interface CrudOptions {
  /** A shared operation-based guard; branches on `ctx.op`
   * (list/get/create/update/replace/remove/batch, plus any custom `actions`). */
  readonly access?: AccessGuard | undefined
  /** Extra query/mutation/stream actions merged into the generated CRUD module (same namespace). */
  readonly actions?: FnModule | undefined
  /** Columns exposed as exact-match facet filters on `list` (defaults to the table's indexed columns). */
  readonly filters?: readonly string[] | undefined
  /** String columns matched by the free-text `q` param on `list` (defaults to none). */
  readonly search?: readonly string[] | undefined
  /** Path-param names that form the row id; more than one is a composite key. Defaults to `['id']`. */
  readonly idParams?: readonly string[] | undefined
}

/** The list action's argument shape: pagination + sort + free-text + arbitrary facet filters. */
export interface CrudListArgs {
  readonly limit?: number
  readonly cursor?: string
  readonly direction?: 'forward' | 'backward'
  readonly sort?: string
  readonly q?: string
  readonly [facet: string]: unknown
}

/** One item in a `batch` request — a discriminated bulk operation. `update`/`replace`/`delete` accept
 * an optional per-item `ifMatch` (`_version`) for optimistic concurrency, isolated to that item. */
export type BatchOp<T extends TableDef> =
  | { readonly op: 'create'; readonly data: InferInsert<T> }
  | {
      readonly op: 'update'
      readonly id: string
      readonly patch: Partial<InferInsert<T>>
      readonly ifMatch?: string
    }
  | {
      readonly op: 'replace'
      readonly id: string
      readonly data: InferInsert<T>
      readonly ifMatch?: string
    }
  | { readonly op: 'delete'; readonly id: string; readonly ifMatch?: string }

/** One result in a `batch` response — per-item success or failure, so a partial batch reports exactly
 * which items applied and which did not (never all-or-nothing). */
export type BatchResult<T extends TableDef> =
  | { readonly status: 'ok'; readonly op: string; readonly id?: string; readonly row?: Infer<T> }
  | { readonly status: 'error'; readonly op: string; readonly id?: string; readonly error: string }

/** The typed function module a `type: 'crud'` resource generates for a table `T` — each action carries
 * the table's row (`Infer<T>`) and insert (`InferInsert<T>`) types so `Broker.call` returns them. */
export interface CrudModule<T extends TableDef> {
  readonly list: Query<CrudListArgs, Page<Infer<T>>>
  readonly get: Query<{ readonly id: string }, Infer<T>>
  readonly create: Mutation<InferInsert<T>, Infer<T>>
  readonly update: Mutation<Partial<InferInsert<T>> & { readonly id: string }, Infer<T>>
  readonly replace: Mutation<InferInsert<T> & { readonly id: string }, Infer<T>>
  readonly remove: Mutation<{ readonly id: string }, Infer<T> | undefined>
  readonly batch: Mutation<
    { readonly operations: readonly BatchOp<T>[] },
    { readonly results: readonly BatchResult<T>[] }
  >
}

export interface ResourceOptions {
  /** Transport for this resource's own realtime channel (`/<ns>/_realtime`). */
  readonly realtime?: RealtimeTransport | undefined
  /** Mount the resource under a parent path carrying path params, e.g. `'/apps/:appId'`. The parent
   * params arrive in every handler's `body` (nested / sub-resources). */
  readonly parent?: string | undefined
}

/** The `type: 'crud'` form of {@link resource}: generate the standard REST collection (list / get /
 * create / update / replace / remove / batch + realtime deltas) for a table, plus any custom
 * `actions`. Replaces the old `defineCrud(...)` helper. */
export interface CrudResourceConfig extends CrudOptions {
  readonly type: 'crud'
  /** Override the resource's IDENTITY — the service name, the daemon role key (`SERVICE=<ns>`) and
   * the route segment (`/<ns>`) move together, so the generated client and a split deployment can
   * never disagree about the address. The table's name stays purely the storage name. Lets a
   * SQL-safe table (`appRoles`) live at a hyphenated path (`/app-roles`), and composes with
   * `parent` for nesting (`namespace: 'files'`, `parent: '/kb'` → `/kb/files`). One plain path
   * segment (`[A-Za-z0-9_-]`). Defaults to the table's name. */
  readonly namespace?: string | undefined
  /** Transport for the collection's realtime channel (`/<ns>/_realtime`). Defaults to `'websocket'`. */
  readonly realtime?: RealtimeTransport | undefined
  /** Mount the collection under a parent path carrying path params, e.g. `'/apps/:appId'` (nested). */
  readonly parent?: string | undefined
}

/** A Wizard resource is a native server Service; its typed functions live on `resource.actions`. */
export type Resource<TActions extends Record<string, Action> = Record<string, Action>> = Service<
  unknown,
  [],
  TActions
>

/** The action names a `type: 'crud'` resource always exposes. */
export type CrudActionName = 'list' | 'get' | 'create' | 'update' | 'replace' | 'remove' | 'batch'
