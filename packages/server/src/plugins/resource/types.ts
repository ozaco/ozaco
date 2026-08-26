import type { Schema } from 'db:core'
import type { ServerDef, ServiceDef } from 'server:core'
import type { Operation } from 'std:effect'
import type { Result } from 'std:result'
import type { AnyType } from 'std:shared'

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

  /** What the `actions` option may enable: the six built-ins plus the `_realtime` socket. */
  export type ActionName = keyof CrudActions<unknown, unknown> | 'realtime'

  /** The action map of a crud service: the ENABLED built-ins plus the `extend` actions (a
   * same-named `extend` entry replaces the built-in). */
  export type CrudMap<
    TDoc,
    TInsert,
    TNames extends readonly ActionName[] | true,
    TExtend extends ServiceDef.ActionMap,
  > = Omit<
    TNames extends readonly ActionName[]
      ? Pick<CrudActions<TDoc, TInsert>, Extract<TNames[number], keyof CrudActions<TDoc, TInsert>>>
      : CrudActions<TDoc, TInsert>,
    keyof TExtend
  > &
    TExtend

  /** The operations a hook observes: the six actions plus the realtime `watch` subscribe. */
  export type Op = 'list' | 'get' | 'create' | 'update' | 'replace' | 'remove' | 'watch'

  /** What every hook sees: which operation ran, its CURRENT (validated) input and the full
   * dispatch ctx — db, auth, headers, `call`, `log`, spans. On `watch`, `input` is the client's
   * watch frame and `ctx` is the socket's handshake ctx. */
  export interface HookCall {
    readonly op: Op
    readonly input: unknown
    readonly ctx: ServerDef.Ctx
  }

  /** Runs before the handler — a returned value REPLACES the input (`undefined` keeps it).
   * On `watch`, the returned frame's `t`/`id` are pinned back to the client's. */
  export type BeforeHook = (call: HookCall) => Operation<unknown>

  /** Runs after the handler — a returned value REPLACES the output (`undefined` keeps it; it
   * still passes the action's output schema). On `watch`, `output` is each outgoing
   * `sync`/`delta` frame (project `rows`/`added`/`changed` here). */
  export type AfterHook = (call: HookCall & { readonly output: unknown }) => Operation<unknown>

  /** Wraps `before → handler → after` of the six actions (not the long-lived watch): transform
   * the input via `next(...)`, the output via the return value, or short-circuit by not calling
   * `next` at all. */
  export type AroundHook = (
    call: HookCall,
    next: (input: unknown) => Operation<unknown>,
  ) => Operation<unknown>

  /** Sees every failure of the chain: return `undefined` to keep it, a failure (or raise one)
   * to replace it, anything else to RECOVER with that value — actions only; a failed watch
   * always ends in an `error` frame (built from the replaced failure). */
  export type ErrorHook = (
    call: HookCall & { readonly failure: Result.Failure<unknown> },
  ) => Operation<unknown>

  /** The seams of a resource: tenancy scoping (`before`), projections (`after`), guards and
   * instrumentation (`around`), failure shaping (`error`). */
  export interface CrudHooks {
    readonly before?: BeforeHook | undefined
    readonly after?: AfterHook | undefined
    readonly around?: AroundHook | undefined
    readonly error?: ErrorHook | undefined
  }

  /** Which derived schema a `schema` hook is looking at: the shared row shape (`doc` — every
   * read output) or one operation's INPUT (`update`/`replace` include the `id` field). */
  export type SchemaOf = 'doc' | 'list' | 'create' | 'update' | 'replace'

  /** Runs ONCE per derived schema while `crud()` builds the service (definition time, never per
   * request): return a replacement schema — or nothing (or `schema` itself) to keep the
   * default. It must be effect-free: raising a failure refuses the definition, suspending on
   * anything else is a configuration error. */
  export type SchemaHook = (schema: z.ZodObject, of: SchemaOf) => Operation<AnyType>

  export interface CrudOptions<
    TNames extends readonly ActionName[] | true = true,
    TExtend extends ServiceDef.ActionMap = ServiceDef.ActionMap,
  > extends CrudHooks {
    /** the service name (and route root `/<name>`). Default: the table name. */
    readonly name?: string | undefined

    /** which built-ins to expose (`'realtime'` is the `_realtime` socket). Omitted or `true`:
     * ALL of them. An excluded action is not defined at all — no route, no manifest entry, no
     * client method. */
    readonly actions?: TNames | true | undefined

    /** extra actions merged into the service (`stats: action.query(...)`) — the separate
     * side-service is not needed. Routes default to `/<name>/<key>` (static segments win over
     * `/:id`), a same-named entry REPLACES the built-in, `action.socket` entries mount too.
     * The crud hooks do NOT wrap these: their authors own the whole handler. */
    readonly extend?: TExtend | undefined

    /** transform the derived schemas at DEFINITION time (see {@link SchemaHook}). */
    readonly schema?: SchemaHook | undefined

    /** `auth` requirements per side (the Auth plugin's option). */
    readonly auth?: { readonly read?: unknown; readonly write?: unknown } | undefined

    /** columns a client filter may reference. Default: every declared column + `_id`. */
    readonly filterable?: readonly string[] | undefined

    /** the largest page a client may ask for. Default 100. */
    readonly maxLimit?: number | undefined

    /** extra action options spread on every BUILT-IN action (e.g. `cache`, `rateLimit`). */
    readonly options?: Readonly<Record<string, unknown>> | undefined
  }

  /** What `crud()` returns: the service plus what the realtime route needs. The generics
   * mirror what the call site wrote — the table, the enabled `actions`, the `extend` map — so
   * hovers stay small; the service's action map is DERIVED from them here instead of being a
   * type argument of its own. */
  export interface Crud<
    TTable extends Schema.Table = Schema.Table,
    TNames extends readonly ActionName[] | true = true,
    TExtend extends ServiceDef.ActionMap = ServiceDef.ActionMap,
  > {
    readonly service: ServiceDef.Service<
      TTable['name'],
      CrudMap<Schema.Infer<TTable>, Schema.InferInsert<TTable>, TNames, TExtend>
    >
    readonly table: TTable
    readonly filterable: readonly string[]
    readonly maxLimit: number
    readonly auth: { readonly read?: unknown; readonly write?: unknown }
    readonly hooks: CrudHooks

    /** the resolved enabled set — the `Resource` plugin mounts `_realtime` only when
     * `'realtime'` is in here. */
    readonly actions: readonly ActionName[]
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
