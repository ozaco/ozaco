import type { Infer, InferInsert, TableDef } from 'db:core'
import type {
  Action,
  ActionKind,
  DisconnectMode,
  Params,
  PolicyOverrides,
  Route,
  Schema,
  Service,
} from 'server:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { WIZARD_FN } from './const'

/** An access guard: hooks are available inside; `false` fails `server:core.forbidden` (403). */
export type AccessGuard = () => Operation<boolean>

export interface WizardDocs {
  readonly tags?: readonly string[]
}

/**
 * The cold half of the wizard type surface — declaration/config/metadata shapes the builders
 * accept and stamp. Grouped so the barrel stays scannable; reach them as `Wizard.QueryConfig` etc.
 */
export namespace Wizard {
  /** Declaration fields shared by every wizard fn builder. */
  export interface FnBase {
    readonly args?: Schema | undefined
    readonly returns?: Schema | undefined
    readonly access?: AccessGuard | undefined
    /** Explicit REST claim; fns without one are mounted at `POST /<key>`. */
    readonly rest?: Route | undefined
    readonly policies?: PolicyOverrides | undefined
    /** Failure tag → HTTP status overrides (db tags pass through and are mapped here). */
    readonly errors?: Record<string, number> | undefined
    readonly docs?: WizardDocs | undefined
  }

  export interface QueryConfig<
    TArgs extends Schema | undefined = Schema | undefined,
    TResult = unknown,
  > extends FnBase {
    readonly args?: TArgs
    /** Realtime: re-run on table changes, pushing `sync` frames whose `rows` is `[value]`. */
    readonly watch?: boolean | undefined
    readonly handler: (args: Params<TArgs>) => Operation<TResult>
  }

  export interface MutationConfig<
    TArgs extends Schema | undefined = Schema | undefined,
    TResult = unknown,
  > extends FnBase {
    readonly args?: TArgs
    readonly handler: (args: Params<TArgs>) => Operation<TResult>
  }

  export interface ActionFnConfig<
    TArgs extends Schema | undefined = Schema | undefined,
    TResult = unknown,
  > extends FnBase {
    readonly args?: TArgs
    /** Default `cancel`: abort on caller abandon. `detach`: finish the work, record the outcome. */
    readonly onDisconnect?: DisconnectMode | undefined
    /** Always persist this action's outcome. */
    readonly outcome?: boolean | undefined
    readonly handler: (args: Params<TArgs>) => Operation<TResult>
  }

  /** The query pipeline metadata a crud `list` fn carries — shared by REST and realtime watch. */
  export interface ListPipeline {
    readonly table: TableDef
    /** Extra facet eq-filter params allowed on `list` (query params / watch args). */
    readonly filters: readonly string[]
    readonly pageSize: number
    readonly maxPageSize: number
  }

  export type FnMap = Record<string, WizardFn>

  /** How the realtime layer serves a `watch` frame for one fn. */
  export type WatchRecipe =
    | {
        readonly kind: 'list'
        readonly pipeline: ListPipeline
        readonly access?: AccessGuard | undefined
      }
    | { readonly kind: 'custom'; readonly access?: AccessGuard | undefined }

  /**
   * The slice of {@link ResourceMeta} the watch pipeline reads — available BEFORE the service is
   * compiled, so the SSE realtime action (itself part of the service) can close over it.
   */
  export interface WatchSource {
    readonly name: string
    /** `null` for plain (name-only) resources — no realtime route is registered. */
    readonly table: TableDef | null
    /** fn key → its watch recipe. */
    readonly watchable: ReadonlyMap<string, WatchRecipe>
  }

  /** Everything `installWizard` and the realtime route read about one resource. */
  export interface ResourceMeta extends WatchSource {
    readonly service: Service
  }

  export interface ResourceLike {
    readonly $wizard: ResourceMeta
  }

  /** The `resource()` result: one `FnRef` per fn plus the `$wizard` metadata. */
  export type Resource<TFns extends FnMap = FnMap> = {
    readonly [K in keyof TFns]: TFns[K] extends WizardFn<infer TArgs, infer TResult>
      ? FnRef<TArgs, TResult>
      : never
  } & ResourceLike
}

/**
 * A wizard fn declaration — the plain object `query`/`mutation`/`action` return. `resource()`
 * compiles it into a core `Action` (access guard wrapped inside the handler, typed `kind` set).
 */
export interface WizardFn<TArgs = AnyType, TResult = AnyType> extends Wizard.FnBase {
  readonly _t: typeof WIZARD_FN
  readonly kind: ActionKind
  /** Realtime-watchable (queries only; always true on crud `list`). */
  readonly watch: boolean
  readonly onDisconnect?: DisconnectMode | undefined
  readonly outcome?: boolean | undefined
  readonly handler: (args: TArgs) => Operation<TResult>
  /** Present on crud `list` only — the shared REST/realtime query pipeline. */
  readonly pipeline?: Wizard.ListPipeline | undefined
}

/** A compiled wizard fn: a full core `Action` stamped with its broker address for `run()`. */
export interface FnRef<TArgs = AnyType, TResult = AnyType> extends Action<TArgs, TResult> {
  readonly wizard: { readonly service: string; readonly key: string }
}

/** The api tree `wizard()` accepts: resources and classic services side by side. */
export type WizardApi = Record<string, Wizard.ResourceLike | Service>

export interface ResourceOptions {
  /** Service name override (defaults to the table name). */
  readonly name?: string | undefined
}

export interface InstallWizardOptions {
  /** Mount path prefix (default `''`). */
  readonly prefix?: string | undefined
  /** Mount REST routes and realtime socket routes on the gateway (default true). */
  readonly gateway?: boolean | undefined
  /** Bridge the db change hub over the broker when the adapter has no live feed (default true). */
  readonly bus?: boolean | undefined
}

/** The wire arguments of a crud `list` (facet params ride along as extra keys). */
export interface ListArgs {
  readonly [facet: string]: unknown
  /** A `Filter` object (or its JSON string in the query param) — sanitized before use. */
  readonly filter?: unknown
  readonly limit?: number | string | undefined
  readonly cursor?: string | undefined
  readonly order?: string | undefined
  readonly direction?: 'asc' | 'desc' | undefined
}

export interface ListPage<TDoc = AnyType> {
  readonly data: readonly TDoc[]
  /** Pass back as `cursor` to fetch the next page; `null` on the last one. */
  readonly cursor: string | null
  /** The table version the page reflects — the realtime `since` seed. */
  readonly version: number
}

export interface CrudOptions {
  /** Extra facet eq-filter params allowed on `list`. */
  readonly filters?: readonly string[] | undefined
  /** Applied to every generated fn. */
  readonly access?: AccessGuard | undefined
  /** Default 50. */
  readonly pageSize?: number | undefined
  /** Default 200. */
  readonly maxPageSize?: number | undefined
}

/** The six generated crud fns, typed by the table's resolved doc/insert shapes. */
export type CrudFns<TTable extends TableDef = TableDef> = {
  readonly list: WizardFn<ListArgs, ListPage<Infer<TTable>>>
  readonly get: WizardFn<{ readonly id: string }, Infer<TTable>>
  readonly create: WizardFn<InferInsert<TTable>, Infer<TTable>>
  readonly update: WizardFn<{ readonly id: string } & Partial<InferInsert<TTable>>, Infer<TTable>>
  readonly replace: WizardFn<InferInsert<TTable> & { readonly id: string }, Infer<TTable>>
  readonly remove: WizardFn<{ readonly id: string }, undefined>
}
