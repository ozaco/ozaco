import type { Database, Schema, Spec } from 'db:core'
import type { ServerDef } from 'server:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { z } from 'zod'

import type { ResourceDef } from './resource'

/** The shapes this plugin passes around inside itself. */
export namespace Helpers {
  /** The zod shape of a `list` envelope over one row schema. */
  export type PageShape<T extends z.ZodType> = z.ZodObject<{
    data: z.ZodReadonly<z.ZodArray<T>>
    nextCursor: z.ZodNullable<z.ZodString>
    prevCursor: z.ZodNullable<z.ZodString>
    token: z.ZodString
  }>

  /** The installed handle with its tables ERASED: the ops address tables by name (a resource is
   * generic over its own table), so they take the loose shape `useDb()` is narrowed from. */
  export type LooseDb = Database.Handle<Record<string, Schema.Types<Spec.Doc, Spec.Doc>>>

  /** What an op runs against: the (overridden) db handle, the request headers, and the ctx when
   * one is reachable — a `db` override (a transaction's handle) works without a dispatch, the
   * headers then default empty. */
  export interface OpEnv {
    readonly db: LooseDb
    readonly headers: Readonly<Record<string, string>>
    readonly ctx: ServerDef.Ctx | null
  }

  /** What one windowed watch runs with (see `windowed` in `internal.ts`). */
  export interface WindowedArgs {
    readonly ctx: ServerDef.Ctx
    readonly resource: ResourceDef.RealtimeSource
    readonly frame: Extract<ResourceDef.ClientFrame, { t: 'watch' }>
    readonly query: AnyType

    /** the watch's (hook-aware) frame sender. */
    readonly send: (out: ResourceDef.ServerFrame) => Operation<void>
  }

  /** `crud.list` — `total: true` also counts the set, so the page carries `total`. */
  export interface ListFn {
    <TTable extends Schema.Table>(
      table: TTable,
      options: ResourceDef.ListOp & { readonly total: true },
    ): Operation<ResourceDef.Page<Schema.Infer<TTable>> & { readonly total: number }>
    <TTable extends Schema.Table>(
      table: TTable,
      options?: ResourceDef.ListOp,
    ): Operation<ResourceDef.Page<Schema.Infer<TTable>>>
  }

  /** `crud.get` — `optional: true` returns `null` instead of failing `server.not-found`. */
  export interface GetFn {
    <TTable extends Schema.Table>(
      table: TTable,
      options: ResourceDef.GetOp & { readonly optional: true },
    ): Operation<Schema.Infer<TTable> | null>
    <TTable extends Schema.Table>(
      table: TTable,
      options: ResourceDef.GetOp,
    ): Operation<Schema.Infer<TTable>>
  }

  /** The `list` envelope schema over a table (its derived doc) or an already-reshaped row
   * schema — `.extend` it (`total`, facet metadata) for a custom list's `output`; the page
   * shape infers from the doc, so the handler's `crud.list` return needs no cast. */
  export interface PageFn {
    <T extends z.ZodType>(doc: T): PageShape<T>
    (table: Schema.Table): PageShape<z.ZodObject>
  }
}
