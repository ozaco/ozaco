import type { Schema } from 'db:core'
import type { ServiceDef } from 'server:core'

import type { z } from 'zod'

import type { listInput } from './internal'

export namespace ResourceDef {
  /** One page of `list`. */
  export interface Page<TDoc> {
    readonly data: readonly TDoc[]
    readonly nextCursor: string | null
    readonly prevCursor: string | null
    readonly token: string
  }

  /** The actions of a crud service, typed from the table's doc/insert shapes. */
  export type CrudActions<TDoc, TInsert> = {
    readonly list: ServiceDef.Action<typeof listInput, z.ZodType<Page<TDoc>>>
    readonly get: ServiceDef.Action<z.ZodType<{ id: string }>, z.ZodType<TDoc>>
    readonly create: ServiceDef.Action<z.ZodType<TInsert>, z.ZodType<TDoc>>
    readonly update: ServiceDef.Action<
      z.ZodType<{ id: string } & Partial<TInsert>>,
      z.ZodType<TDoc>
    >
    readonly replace: ServiceDef.Action<z.ZodType<{ id: string } & TInsert>, z.ZodType<TDoc>>
    readonly remove: ServiceDef.Action<
      z.ZodType<{ id: string }>,
      z.ZodType<{ readonly removed: boolean }>
    >
  }

  export interface CrudOptions {
    /** the service name (and route root `/<name>`). Default: the table name. */
    readonly name?: string | undefined

    /** `auth` requirements per side (the Auth plugin's option). */
    readonly auth?: { readonly read?: unknown; readonly write?: unknown } | undefined

    /** columns a client filter may reference. Default: every declared column + `_id`. */
    readonly filterable?: readonly string[] | undefined

    /** the largest page a client may ask for. Default 100. */
    readonly maxLimit?: number | undefined

    /** extra action options spread on every action (e.g. `cache`, `rateLimit`). */
    readonly options?: Readonly<Record<string, unknown>> | undefined
  }

  /** What `crud()` returns: the service plus what the realtime route needs. */
  export interface Crud<TName extends string = string, TDoc = unknown, TInsert = unknown> {
    readonly service: ServiceDef.Service<TName, CrudActions<TDoc, TInsert>>
    readonly table: Schema.Table<TName, TDoc, TInsert>
    readonly filterable: readonly string[]
    readonly maxLimit: number
    readonly auth: { readonly read?: unknown; readonly write?: unknown }
  }

  export interface PluginOptions {
    /** the crud resources whose `_realtime` socket routes to mount. */
    readonly resources: readonly Crud[]

    /** route suffix. Default `/_realtime`. */
    readonly realtimePath?: string | undefined
  }

  /** The pager of a WINDOWED watch: keyset cursors + the set's total, as of `token`. */
  export interface WindowInfo {
    readonly next: string | null
    readonly prev: string | null
    readonly total: number
  }

  /** Client → server frames on the realtime socket. A `limit` makes the watch WINDOWED: the
   * subscription owns one page (`cursor` picks it); re-sending `watch` with the same `id` and
   * another cursor turns the page for THIS subscriber only. */
  export type ClientFrame =
    | {
        readonly t: 'watch'
        readonly id: string
        readonly filter?: unknown
        readonly order?: { readonly field: string; readonly direction?: 'asc' | 'desc' } | undefined
        readonly limit?: number | undefined

        /** `0` (the manifest default) or omitted = the start of the set; a bare row `_id` =
         * the window starts AT that row; otherwise an opaque keyset cursor from a previous
         * frame's `page`. */
        readonly cursor?: string | number | undefined

        /** `cursor` is a `prev` cursor — page BACKWARD from it. */
        readonly back?: boolean | undefined
        readonly since?: string | undefined
      }
    | { readonly t: 'unwatch'; readonly id: string }

  /** Server → client frames. Windowed watches carry `page`; `notify` says the SET changed
   * around an untouched window (another client's write moved the range/total) — same token
   * space as every other frame, so ordering and resume tracking stay uniform. */
  export type ServerFrame =
    | {
        readonly t: 'sync'
        readonly id: string
        readonly rows: readonly unknown[]
        readonly token: string
        readonly page?: WindowInfo | undefined
      }
    | {
        readonly t: 'delta'
        readonly id: string
        readonly added: readonly unknown[]
        readonly changed: readonly unknown[]
        readonly removed: readonly string[]
        readonly token: string
        readonly page?: WindowInfo | undefined
      }
    | {
        readonly t: 'notify'
        readonly id: string
        readonly token: string
        readonly page: WindowInfo
      }
    | { readonly t: 'error'; readonly id: string; readonly tag: string; readonly message: string }
}
