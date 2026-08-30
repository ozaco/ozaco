import type { Schema, Spec } from 'db:core'
import type { OptionsDef, ServerDef, ServiceDef } from 'server:core'
import type { Operation } from 'std:effect'
import type { Result } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { z } from 'zod'

/**
 * The crud/resource surface: `crud(table, options)` builds a whole REST resource as a service —
 * six built-ins plus a delta-watch socket — with the derived schemas, the trusted `scope`, the
 * hook seams and the per-op options all captured in the TYPE, so what the wire actually speaks
 * is what every consumer (hooks, `extend` authors, the manifest, a generated client) sees.
 */
export namespace ResourceDef {
  /** The built-ins a resource may expose (`'realtime'` is the `_realtime` socket). */
  export type ActionName = 'list' | 'get' | 'create' | 'update' | 'replace' | 'remove' | 'realtime'

  /** What a hook's `op` discriminates over: the six actions plus the long-lived watch. */
  export type Op = Exclude<ActionName, 'realtime'> | 'watch'

  // --- schema transforms (definition time) ---------------------------------------------------

  /**
   * Reshape the DERIVED schemas — ONCE, while `crud()` builds the service, never per request.
   * Each transform is a PLAIN function from the derived default to a replacement; its RETURN
   * TYPE is captured into the resource's generics, so the wire, the hooks, `shapes` and the
   * typed client all follow the reshape (`create: s => s.omit({ tenant: true })` really removes
   * `tenant` everywhere).
   *
   * `doc` is the shared row shape (every read output, `page.data` included); `page` is the
   * `list` envelope derived AFTER `doc`. `get`/`remove` take a bare `{ id }` and have no seam.
   */
  export interface SchemaTransforms {
    readonly doc?: ((schema: AnyType) => z.ZodType) | undefined
    readonly page?: ((schema: AnyType) => z.ZodType) | undefined
    readonly list?: ((schema: AnyType) => z.ZodType) | undefined
    readonly create?: ((schema: AnyType) => z.ZodType) | undefined
    readonly update?: ((schema: AnyType) => z.ZodType) | undefined
    readonly replace?: ((schema: AnyType) => z.ZodType) | undefined
  }

  /** A fabricated zod shape whose entries answer the row's own types — what makes
   * `s.omit(...)`/`s.extend(...)` return PRECISELY typed objects the generics can capture.
   * A key the source may omit maps to a `ZodOptional`, so the derived object keeps it
   * optional on both sides. */
  type ShapeOf<T> = {
    [K in keyof T & string]-?: undefined extends T[K]
      ? z.ZodOptional<z.ZodType<Exclude<T[K], undefined>, Exclude<T[K], undefined>>>
      : z.ZodType<T[K], T[K]>
  }

  /** The derived schemas as the transforms SEE them (typed by the table, so `omit`/`extend`
   * return types carry the real fields). `page`'s parameter reflects the DEFAULT doc — a `doc`
   * transform's reshape lands in the resolved types, not in this parameter. */
  export type DerivedDoc<TTable extends Schema.Table> = z.ZodObject<ShapeOf<Schema.Infer<TTable>>>
  export type DerivedCreate<TTable extends Schema.Table> = z.ZodObject<
    ShapeOf<Schema.InferInsert<TTable>>
  >
  export type DerivedUpdate<TTable extends Schema.Table> = z.ZodObject<
    ShapeOf<{ readonly id: string } & Partial<Schema.InferInsert<TTable>>>
  >
  export type DerivedReplace<TTable extends Schema.Table> = z.ZodObject<
    ShapeOf<{ readonly id: string } & Schema.InferInsert<TTable>>
  >
  export type DerivedList = z.ZodObject<ShapeOf<Required<ListWire>>>
  export type DerivedPage<TTable extends Schema.Table> = z.ZodObject<
    ShapeOf<Page<Schema.Infer<TTable>>>
  >

  /** The wire `list` input (the derived default of the `list` transform). */
  export interface ListWire {
    readonly filter?: unknown
    readonly order?: string | undefined
    readonly direction?: 'asc' | 'desc' | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }

  /** The `list` envelope. */
  export interface Page<TDoc = AnyType> {
    readonly data: readonly TDoc[]
    readonly nextCursor: string | null
    readonly prevCursor: string | null
    readonly token: string
  }

  type Or<TCaptured, TFallback extends StandardSchemaV1> = [TCaptured] extends [never]
    ? TFallback
    : TCaptured

  /** A schema that answers `T` on BOTH sides (what an untransformed derived schema is, seen
   * from the type system: the wire value and the parsed value coincide). */
  export type Declared<T> = z.ZodType<T, T>

  /**
   * The RESOLVED schemas a resource runs with — the transforms applied over the derived
   * defaults. This is the single source the action declarations, the hooks, `shapes` and the
   * client types all read.
   */
  export interface ResolvedShapes {
    readonly doc: StandardSchemaV1
    readonly page: StandardSchemaV1
    readonly list: StandardSchemaV1
    readonly create: StandardSchemaV1
    readonly update: StandardSchemaV1
    readonly replace: StandardSchemaV1
  }

  export type Resolved<
    TTable extends Schema.Table,
    TDoc extends z.ZodType = never,
    TPage extends z.ZodType = never,
    TList extends z.ZodType = never,
    TCreate extends z.ZodType = never,
    TUpdate extends z.ZodType = never,
    TReplace extends z.ZodType = never,
  > = {
    readonly doc: Or<TDoc, Declared<Schema.Infer<TTable>>>
    readonly page: Or<
      TPage,
      Declared<Page<StandardSchemaV1.InferOutput<Or<TDoc, Declared<Schema.Infer<TTable>>>>>>
    >
    readonly list: Or<TList, Declared<ListWire>>
    readonly create: Or<TCreate, Declared<Schema.InferInsert<TTable>>>
    readonly update: Or<
      TUpdate,
      Declared<{ readonly id: string } & Partial<Schema.InferInsert<TTable>>>
    >
    readonly replace: Or<TReplace, Declared<{ readonly id: string } & Schema.InferInsert<TTable>>>
  }

  /** The row type of a resolved shape set. */
  export type DocOf<TResolved extends ResolvedShapes> = StandardSchemaV1.InferOutput<
    TResolved['doc']
  >

  // --- hooks ---------------------------------------------------------------------------------

  /** The per-op input/output shapes hooks see — derived from the RESOLVED schemas, so a
   * transformed field (an `omit`, an `extend`) shows here exactly as it does on the wire. */
  export interface OpShapes<TResolved extends ResolvedShapes = ResolvedShapes> {
    readonly list: {
      readonly input: StandardSchemaV1.InferOutput<TResolved['list']>
      readonly output: StandardSchemaV1.InferOutput<TResolved['page']>
    }
    readonly get: { readonly input: { readonly id: string }; readonly output: DocOf<TResolved> }
    readonly create: {
      readonly input: StandardSchemaV1.InferOutput<TResolved['create']>
      readonly output: DocOf<TResolved>
    }
    readonly update: {
      readonly input: StandardSchemaV1.InferOutput<TResolved['update']>
      readonly output: DocOf<TResolved>
    }
    readonly replace: {
      readonly input: StandardSchemaV1.InferOutput<TResolved['replace']>
      readonly output: DocOf<TResolved>
    }
    readonly remove: {
      readonly input: { readonly id: string }
      readonly output: { readonly removed: boolean }
    }
    readonly watch: {
      readonly input: Extract<ClientFrame, { t: 'watch' }>
      readonly output: ServerFrame<DocOf<TResolved>>
    }
  }

  /**
   * What every hook sees: which operation ran, its CURRENT (validated) input and the full
   * dispatch ctx — auth, headers, `call`, `log`, spans. On `watch`, `input` is the client's
   * watch frame and `ctx` is the socket's handshake ctx.
   *
   * It is a UNION discriminated by `op`, so narrowing types the input:
   * `if (op === 'remove') { input.id }`, `if (op === 'create') { input.title }`.
   */
  export type HookCall<TResolved extends ResolvedShapes = ResolvedShapes> = {
    [K in Op]: {
      readonly op: K
      readonly input: OpShapes<TResolved>[K]['input']
      readonly ctx: ServerDef.Ctx
    }
  }[Op]

  /** {@link HookCall} plus the operation's answer — narrowing types both sides. */
  export type HookResult<TResolved extends ResolvedShapes = ResolvedShapes> = {
    [K in Op]: {
      readonly op: K
      readonly input: OpShapes<TResolved>[K]['input']
      readonly output: OpShapes<TResolved>[K]['output']
      readonly ctx: ServerDef.Ctx
    }
  }[Op]

  /** Every op's input (what a `before` may answer with). */
  export type OpInput<TResolved extends ResolvedShapes = ResolvedShapes> = {
    [K in Op]: OpShapes<TResolved>[K]['input']
  }[Op]

  /** Every op's output (what an `after` may answer with). */
  export type OpOutput<TResolved extends ResolvedShapes = ResolvedShapes> = {
    [K in Op]: OpShapes<TResolved>[K]['output']
  }[Op]

  /** Runs before the handler — a returned value REPLACES the input (`undefined` keeps it).
   * On `watch`, the returned frame's `t`/`id` are pinned back to the client's. */
  export type BeforeHook<TResolved extends ResolvedShapes = ResolvedShapes> = (
    call: HookCall<TResolved>,
  ) => Operation<OpInput<TResolved> | undefined | void>

  /** Runs after the handler — a returned value REPLACES the output (`undefined` keeps it; it
   * still passes the action's output schema, so it may WIDEN the shape). On `watch`, `output`
   * is each outgoing `sync`/`delta` frame (project `rows`/`added`/`changed` here). */
  export type AfterHook<TResolved extends ResolvedShapes = ResolvedShapes> = (
    call: HookResult<TResolved>,
  ) => Operation<OpOutput<TResolved> | undefined | void>

  /** Wraps `before → handler → after` of the six actions (not the long-lived watch): transform
   * the input via `next(...)`, the output via the return value, or short-circuit by not calling
   * `next` at all.
   *
   * It sits OUTSIDE `before`, so it sees the RAW input and can answer before `before` ever
   * runs — instrumentation, retries and cross-cutting shaping belong here, authorization does
   * not. Tenancy is `scope` (enforced in the handler, under every hook); per-row rules that
   * must not answer for a row the caller cannot see belong in `before`. */
  export type AroundHook<TResolved extends ResolvedShapes = ResolvedShapes> = (
    call: HookCall<TResolved>,
    next: (input: unknown) => Operation<unknown>,
  ) => Operation<unknown>

  /** Sees every failure of the chain: return `undefined` to keep it, a failure (or raise one)
   * to replace it, anything else to RECOVER with that value — actions only; a failed watch
   * always ends in an `error` frame (built from the replaced failure). */
  export type ErrorHook<TResolved extends ResolvedShapes = ResolvedShapes> = (
    call: HookCall<TResolved> & { readonly failure: Result.Failure<unknown> },
  ) => Operation<unknown>

  /** The seams of a resource: input rewrites (`before`), projections (`after`), instrumentation
   * (`around` — OUTSIDE `before`, see {@link AroundHook}), failure shaping (`error`). Tenancy
   * is NOT a hook: it is {@link Scope}, which no hook can widen. */
  export interface CrudHooks<TResolved extends ResolvedShapes = ResolvedShapes> {
    readonly before?: BeforeHook<TResolved> | undefined
    readonly after?: AfterHook<TResolved> | undefined
    readonly around?: AroundHook<TResolved> | undefined
    readonly error?: ErrorHook<TResolved> | undefined
  }

  // --- scope ---------------------------------------------------------------------------------

  /**
   * The TRUSTED per-caller filter (tenancy), computed from the dispatch ctx (`ctx.auth` = the
   * verified principal) on every operation — the realtime watch included. It is resolved
   * INSIDE the handler, under every hook, so no `before`/`around` can widen it, and it joins
   * AFTER the client filter sanitizer: its fields need not (and should not) be in
   * `filterable`.
   *
   * What it does per operation:
   * - `list` / `count` / `watch` — AND-ed under the client's filter
   * - `get` — a row outside it reads as absent (`server.not-found`, never a leak)
   * - `update` / `replace` / `remove` — the write is guarded by it, so an out-of-scope row is
   *   a miss (404), never a conflict (412) that would prove it exists
   * - `create` / `replace` — the values the filter PINS (top-level `eq`s, nested `and`s
   *   flattened, `isNull` pinning `null`) are STAMPED onto the row, and `update` drops EVERY
   *   field the scope references from the patch: a row can never be written out of its scope.
   *   A scope that pins nothing exact (`or`, ranges…) refuses `create`/`replace` with
   *   `server.configuration`.
   *
   * Because the scoped columns are forced, drop them from the derived write shapes with the
   * `schema` transforms so clients need not send a value that is overwritten anyway.
   *
   * On the realtime watch the scope is resolved ONCE, at subscribe time — a long-lived socket
   * keeps the scope it subscribed with (deliberate; revoke by closing the socket).
   */
  export type Scope = (ctx: ServerDef.Ctx) => Operation<Spec.Filter | undefined | null | void>

  /** One scope for everything, or an asymmetric pair: `read` covers `list`/`get`/`count`/the
   * watch, `write` covers `create`/`update`/`replace`/`remove` ("the team reads, the owner
   * writes"). A written row is returned in the reply — keep `write` ⊆ `read`, or a caller can
   * write (and thereby see) a row they cannot read back. */
  export type ScopeOption =
    | Scope
    | { readonly read?: Scope | undefined; readonly write?: Scope | undefined }

  // --- options -------------------------------------------------------------------------------

  /** A `filterable` entry in its rich form: which operators a client may use on this field. */
  export interface FilterableField {
    readonly field: string

    /** allowed operators. Default: the full algebra. */
    readonly ops?: readonly Spec.FilterOp[] | undefined
  }

  /** What a client filter/order may reference: field names, or the rich per-field form (also
   * published in the manifest as the resource's filter surface). */
  export type Filterable = readonly string[] | readonly FilterableField[]

  /** Extra options for ONE built-in, merged OVER the shared `options`/`errors`. */
  export interface PerOpOptions extends OptionsDef.ActionOptions {
    /** failure tag → http status entries for THIS op alone. */
    readonly errors?: Readonly<Record<string, number>> | undefined
  }

  export interface CrudOptions<
    TTable extends Schema.Table = Schema.Table,
    TName extends string = string,
    TNames extends readonly ActionName[] | true = true,
    TExtend extends ServiceDef.ActionMap = ServiceDef.ActionMap,
    TDoc extends z.ZodType = never,
    TPage extends z.ZodType = never,
    TList extends z.ZodType = never,
    TCreate extends z.ZodType = never,
    TUpdate extends z.ZodType = never,
    TReplace extends z.ZodType = never,
  > extends CrudHooks<NoInfer<Resolved<TTable, TDoc, TPage, TList, TCreate, TUpdate, TReplace>>> {
    /** the service name (and the manifest/client key). Default: the table name. */
    readonly name?: TName | undefined

    /** the route root. Default `/<name>` — decouple it from the service name for nested
     * resources: `name: 'documents', path: '/knowledge/documents'`. */
    readonly path?: string | undefined

    /** the realtime socket's route suffix under the route root. Default `/_realtime`. */
    readonly realtimePath?: string | undefined

    /** which built-ins to expose (`'realtime'` is the `_realtime` socket). Omitted or `true`:
     * ALL of them. An excluded action is not defined at all — no route, no manifest entry, no
     * client method. */
    readonly actions?: TNames | true | undefined

    /** extra actions merged into the service (`stats: action.query(...)`) — the separate
     * side-service is not needed. Routes default to `/<name>/<key>` (static segments win over
     * `/:id`), a same-named entry REPLACES the built-in, `action.socket` entries mount too.
     * The crud hooks do NOT wrap these: their authors own the whole handler. */
    readonly extend?: TExtend | undefined

    /** reshape the derived schemas at DEFINITION time — the reshape lands in the TYPES too:
     * each transform's parameter is the TYPED derived default (so `omit`/`extend` return
     * precisely-shaped objects) and its RETURN type is captured into the resource's generics. */
    readonly schema?:
      | {
          readonly doc?: ((schema: DerivedDoc<TTable>) => TDoc) | undefined
          readonly page?: ((schema: DerivedPage<TTable>) => TPage) | undefined
          readonly list?: ((schema: DerivedList) => TList) | undefined
          readonly create?: ((schema: DerivedCreate<TTable>) => TCreate) | undefined
          readonly update?: ((schema: DerivedUpdate<TTable>) => TUpdate) | undefined
          readonly replace?: ((schema: DerivedReplace<TTable>) => TReplace) | undefined
        }
      | undefined

    /** `auth` requirements per side (the Auth plugin's option): `read` covers `list`/`get`/
     * the realtime handshake, `write` covers the four mutations. `ops.<op>.auth` overrides
     * per op. */
    readonly auth?:
      | {
          readonly read?: OptionsDef.Requirement | undefined
          readonly write?: OptionsDef.Requirement | undefined
        }
      | undefined

    /** the trusted per-caller filter every built-in runs under — tenancy. See {@link Scope};
     * the object form splits read/write ({@link ScopeOption}). */
    readonly scope?: ScopeOption | undefined

    /** extra failure tag → http status entries for the built-ins, MERGED over the db failures
     * `crud.errors` already declares (a same tag here wins). The tags a hook raises live here:
     * an undeclared tag answers 500. */
    readonly errors?: Readonly<Record<string, number>> | undefined

    /** per-op options and errors, merged OVER the shared `options`/`errors`:
     * `ops: { remove: { errors: personas.statuses }, list: { cache: { ttlMs: 30_000 } } }`. */
    readonly ops?: Partial<Record<Exclude<ActionName, 'realtime'>, PerOpOptions>> | undefined

    /** columns a client filter/order may reference — names, or the rich per-field form.
     * Default: every declared column + the system fields. */
    readonly filterable?: Filterable | undefined

    /** the largest page a client may ask for. Default 100. */
    readonly maxLimit?: number | undefined

    /** action options spread on every BUILT-IN action (e.g. `cache`, `rateLimit`) — typed;
     * `ops` overrides per op. */
    readonly options?: OptionsDef.ActionOptions | undefined
  }

  // --- the built service ---------------------------------------------------------------------

  type BuiltinMap<TResolved extends ResolvedShapes> = {
    readonly list: ServiceDef.Action<TResolved['list'], TResolved['page']>
    readonly get: ServiceDef.Action<Declared<{ id: string }>, TResolved['doc']>
    readonly create: ServiceDef.Action<TResolved['create'], TResolved['doc']>
    readonly update: ServiceDef.Action<TResolved['update'], TResolved['doc']>
    readonly replace: ServiceDef.Action<TResolved['replace'], TResolved['doc']>
    readonly remove: ServiceDef.Action<Declared<{ id: string }>, Declared<{ removed: boolean }>>
  }

  type EnabledKey<TNames extends readonly ActionName[] | true> = TNames extends true
    ? Exclude<ActionName, 'realtime'>
    : TNames extends readonly ActionName[]
      ? Extract<TNames[number], Exclude<ActionName, 'realtime'>>
      : never

  type RealtimeEntry<TResolved extends ResolvedShapes> = {
    readonly _realtime: ServiceDef.SocketAction<
      Declared<ClientFrame>,
      Declared<ServerFrame<DocOf<TResolved>>>
    >
  }

  type WithRealtime<
    TMap,
    TResolved extends ResolvedShapes,
    TNames extends readonly ActionName[] | true,
  > = TNames extends true
    ? TMap & RealtimeEntry<TResolved>
    : TNames extends readonly ActionName[]
      ? 'realtime' extends TNames[number]
        ? TMap & RealtimeEntry<TResolved>
        : TMap
      : TMap

  /** The resource's action map: the enabled built-ins (an `extend` entry replaces its
   * same-named built-in), the extension, and the `_realtime` socket when enabled. */
  export type CrudMap<
    TResolved extends ResolvedShapes,
    TNames extends readonly ActionName[] | true,
    TExtend extends ServiceDef.ActionMap,
  > = WithRealtime<
    Omit<Pick<BuiltinMap<TResolved>, EnabledKey<TNames>>, keyof TExtend> & TExtend,
    TResolved,
    TNames
  >

  /** What `crud()` returns: a SERVICE (its `_realtime` socket included) that goes straight into
   * `createServer({ services })`, carrying the resolved `shapes` and what the realtime
   * machinery reads. */
  export interface Crud<
    TTable extends Schema.Table = Schema.Table,
    TName extends string = string,
    TNames extends readonly ActionName[] | true = true,
    TExtend extends ServiceDef.ActionMap = Record<never, ServiceDef.ActionEntry>,
    TResolved extends ResolvedShapes = ResolvedShapes,
  > extends ServiceDef.Service<TName, CrudMap<TResolved, TNames, TExtend>> {
    readonly table: TTable

    /** the route root every built-in mounts under. */
    readonly path: string
    readonly filterable: readonly FilterableField[]
    readonly maxLimit: number
    readonly auth: {
      readonly read?: OptionsDef.Requirement
      readonly write?: OptionsDef.Requirement
    }
    readonly hooks: CrudHooks<TResolved>
    readonly scope: { readonly read?: Scope | undefined; readonly write?: Scope | undefined }

    /** the RESOLVED schemas the built-ins run with (the `schema` transforms applied) — typed
     * by the transforms' return types, so `extend` actions reuse them at full fidelity. */
    readonly shapes: {
      readonly doc: TResolved['doc']
      readonly page: TResolved['page']
      readonly list: TResolved['list']
      readonly create: TResolved['create']
      readonly update: TResolved['update']
      readonly replace: TResolved['replace']
    }

    /** the resolved built-in set — `'realtime'` in here means the service carries its
     * `_realtime` socket. */
    readonly enabled: TNames extends true ? readonly ActionName[] : TNames
  }

  /** The hook shapes of a BUILT resource — annotate an external hook with these:
   * `const audit: ResourceDef.HooksOf<typeof todos>['before'] = function* (call) { … }`. */
  export type HooksOf<TCrud> =
    TCrud extends Crud<AnyType, AnyType, AnyType, AnyType, infer TResolved>
      ? Required<CrudHooks<TResolved>>
      : never

  // --- runnable ops (`crud.list(table, …)` inside any handler) -------------------------------

  /** Every runnable op reads the dispatch ctx AMBIENTLY (the handler it runs in); `ctx` is the
   * override for the rare call outside one (a socket handler's `socket.ctx`, tests), `db`
   * swaps the handle alone — pass a transaction's: `db.transaction(tx => crud.update(t,
   * { …, db: tx }))`. */
  export interface OpOptions {
    readonly ctx?: ServerDef.Ctx | undefined
    readonly db?: AnyType | undefined
  }

  /** `crud.list` — the built-in list pipeline (sanitized filter, order guard, clamped limit,
   * keyset pagination) as one call. */
  export interface ListOp extends OpOptions {
    /** the wire input (`filter`/`order`/`direction`/`limit`/`cursor`) — pass the action's
     * `input` through. */
    readonly input?: ListWire | undefined

    /** a TRUSTED server-side filter AND-ed with the client's (tenancy, fixed facets). */
    readonly scope?: Spec.Filter | undefined

    /** columns the client filter/order may reference. Default: every column + system fields. */
    readonly filterable?: Filterable | undefined

    /** the largest page a client may ask for. Default 100. */
    readonly maxLimit?: number | undefined

    /** also count the whole set (an extra COUNT query) — the page carries `total`. */
    readonly total?: boolean | undefined
  }

  export interface GetOp extends OpOptions {
    readonly id: string

    /** a TRUSTED filter the row must ALSO satisfy — outside it the row reads as absent. */
    readonly scope?: Spec.Filter | undefined

    /** return `null` instead of failing `server.not-found`. */
    readonly optional?: boolean | undefined
  }

  export interface CreateOp<TInsert = AnyType> extends OpOptions {
    readonly value: TInsert

    /** a TRUSTED filter whose pinned values are STAMPED onto the row (a filter that pins
     * nothing exact refuses with `server.configuration`). */
    readonly scope?: Spec.Filter | undefined
  }

  /** `crud.createMany` — one adapter round trip, all-or-nothing validation. */
  export interface CreateManyOp<TInsert = AnyType> extends OpOptions {
    readonly values: readonly TInsert[]

    /** a TRUSTED filter whose pinned values are STAMPED onto every row. */
    readonly scope?: Spec.Filter | undefined
  }

  /** `crud.count` — the size of the (scoped) set: `filter` is the CLIENT's (sanitized like
   * `list`), `scope` the trusted server-side one. */
  export interface CountOp extends OpOptions {
    readonly filter?: unknown
    readonly scope?: Spec.Filter | undefined
    readonly filterable?: Filterable | undefined
  }

  /** `ifVersion` on the write ops: omitted = honor the ambient `If-Match` header (the
   * built-ins' behaviour), a string = require that `_version`, `false` = no version check. */
  export interface UpdateOp<TInsert = AnyType> extends OpOptions {
    readonly id: string

    /** aligned with db's `PatchOf`: `CLEAR` nulls an optional column, exactly as `db.patch`. */
    readonly patch: Partial<Record<keyof TInsert & string, AnyType>>

    readonly ifVersion?: string | false | undefined

    /** a TRUSTED filter guarding the write: an out-of-scope row is a MISS (`server.not-found`),
     * never a conflict. EVERY field the scope references is dropped from the patch. */
    readonly scope?: Spec.Filter | undefined
  }

  export interface ReplaceOp<TInsert = AnyType> extends OpOptions {
    readonly id: string
    readonly value: TInsert
    readonly ifVersion?: string | false | undefined

    /** a TRUSTED filter guarding the write; its pinned values are STAMPED onto the
     * replacement, so a replace cannot move the row out of scope. */
    readonly scope?: Spec.Filter | undefined
  }

  export interface RemoveOp extends OpOptions {
    readonly id: string
    readonly ifVersion?: string | false | undefined

    /** a TRUSTED filter guarding the write — an out-of-scope row is simply not removed. */
    readonly scope?: Spec.Filter | undefined

    /** fail `server.not-found` when nothing was removed (default: `{ removed: false }`). */
    readonly strict?: boolean | undefined
  }

  // --- realtime ------------------------------------------------------------------------------

  /** What the realtime machinery needs of a resource — `crud()`'s return satisfies it, and
   * `crud.realtime(table, …)` builds one standalone. */
  export interface RealtimeSource {
    readonly table: Schema.Table
    readonly filterable: readonly FilterableField[]
    readonly maxLimit: number
    readonly auth: {
      readonly read?: OptionsDef.Requirement | undefined
      readonly write?: OptionsDef.Requirement | undefined
    }
    readonly hooks: CrudHooks<AnyType>
    readonly scope?: Scope | undefined
  }

  /** `crud.realtime` — the delta-watch socket as an `action.socket` entry for ANY service
   * (mounts at `/<service>/<key>` unless `path` is given, listed under that service in the
   * manifest). */
  export interface RealtimeOptions {
    /** the handshake's `read` requirement (the Auth plugin's option). Default: open. */
    readonly auth?: OptionsDef.Requirement | undefined

    readonly filterable?: Filterable | undefined
    readonly maxLimit?: number | undefined

    /** trusted per-subscriber filter (tenancy) — see {@link Scope} (resolved at subscribe
     * time). */
    readonly scope?: Scope | undefined

    /** the watch seams (`after` = row projection, `error` = frame shaping, `before` = frame
     * rewrites — but tenancy belongs in `scope`, a before-injected filter is client-sanitized)
     * — `around` never applies to the long-lived watch. */
    readonly hooks?: CrudHooks<AnyType> | undefined

    readonly path?: string | undefined
    readonly description?: string | undefined
  }

  /** The pager of a WINDOWED watch: keyset cursors + the set's total, as of `token`. */
  export interface WindowInfo {
    readonly next: string | null
    readonly prev: string | null
    readonly total: number
  }

  /** Client → server frames on the realtime socket. `auth` is the FIRST frame of a browser
   * session (no way to set a WS header): the socket accepts the upgrade, waits a short grace
   * for it, and closes unless the token authorizes — tokens never travel in the URL. A `limit`
   * makes a watch WINDOWED: the subscription owns one page (`cursor` picks it); re-sending
   * `watch` with the same `id` and another cursor turns the page for THIS subscriber only. */
  export type ClientFrame =
    | { readonly t: 'auth'; readonly token: string }
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
  export type ServerFrame<TDoc = unknown> =
    | {
        readonly t: 'sync'
        readonly id: string
        readonly rows: readonly TDoc[]
        readonly token: string
        readonly page?: WindowInfo | undefined
      }
    | {
        readonly t: 'delta'
        readonly id: string
        readonly added: readonly TDoc[]
        readonly changed: readonly TDoc[]
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
