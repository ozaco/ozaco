// oxlint-disable import/exports-last
import type { Action } from 'server:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { z, ZodType } from 'zod'

export type FnKind = 'query' | 'mutation' | 'action' | 'stream'

declare const ARGS: unique symbol
declare const RESULT: unique symbol

/** Call-argument type for an action with args validator `A` — the zod INPUT (fields with a `.default`
 * are optional), i.e. what a caller passes to `Broker.call`. `never` when the action has no args (its
 * call then takes no argument — see {@link ToAction}). */
export type ArgsOf<A> = A extends ZodType ? z.input<A> : never

/** Handler-body type — the zod OUTPUT (defaults applied), i.e. the parsed args the handler receives. */
type ArgsBody<A> = A extends ZodType ? z.output<A> : Record<string, never>

/** How a reactive query's realtime channel produces updates: `'snapshot'` re-runs the handler and
 * sends the whole result on any watched write (default); `'delta'` sends per-row change events (the
 * CRUD `list` uses this — see `collectionEvent`). */
export type ReactiveMode = 'snapshot' | 'delta'

/** An action's input validator (a zod object). `defineCrud` fills these from the target table. */
export type ArgsSpec = ZodType

/** A REST route override; otherwise an action auto-routes to `POST /<resource>/<name>`. */
export interface RestOverride {
  readonly method: string
  readonly path: string
}

/** The context an access guard receives. `op` is the function name (branch on it). Runs in the action
 * scope, so `yield* useDatabase()` / `useAuth()` are available — no injected db. */
export interface AccessContext {
  readonly op: string
  readonly namespace: string
  readonly args: Record<string, unknown>
}

export type AccessGuard = (ctx: AccessContext) => boolean | Operation<boolean>

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

/** The tables a query reactively depends on: `'*'` (re-run on any write) or an explicit list.
 * Defaults to the action's `target` table. */
export type WatchSpec = '*' | readonly string[]

/** How Gateway should expose uploaded files to a Wizard handler. */
export type UploadMode = 'buffer' | 'stream'

/** One multipart file field in the generated OpenAPI/client contract. */
export interface UploadFieldOptions {
  /** Whether Docs and the generated client mark this field as required. Defaults to `true`. */
  readonly required?: boolean | undefined
  /** Accept repeated files under the same multipart field name. Defaults to `false`. */
  readonly multiple?: boolean | undefined
}

/** A short list means required, single-file fields; the object form controls cardinality. */
export type UploadFields = readonly string[] | Readonly<Record<string, true | UploadFieldOptions>>

export interface UploadOptions {
  /** `buffer` spills to request-scoped temp files; `stream` exposes backpressured parts. */
  readonly mode?: UploadMode | undefined
  readonly files: UploadFields
}

/** Normalized upload metadata shared by the Wizard builder and the existing Docs plugin. */
export interface UploadMetadata {
  readonly mode: UploadMode
  readonly fields: readonly (Required<UploadFieldOptions> & { readonly name: string })[]
}

export interface WizardActionConfig<
  A extends ArgsSpec | undefined = ArgsSpec | undefined,
  R = AnyType,
> {
  readonly target?: string | undefined
  /** Input validator; its zod output types the handler's `body` and the action's call args. */
  readonly args?: A
  /** Output validator; its zod output is the action's result type (what `Broker.call` returns). */
  readonly returns?: ZodType<R>
  /** The reactive payload validator — the shape a `query`'s `.watch(...)` (or a `stream`'s
   * subscription) emits when it differs from the one-shot `returns`. Defaults to `returns`. */
  readonly emits?: ZodType | undefined
  /** For reactive queries: how the realtime channel produces updates. Defaults to `'snapshot'`. */
  readonly reactive?: ReactiveMode | undefined
  readonly access?: AccessGuard | undefined
  readonly watch?: WatchSpec | undefined
  readonly rest?: RestOverride | undefined
  readonly upload?: UploadOptions | undefined
  readonly handler: (body: ArgsBody<A>) => Operation<AnyType>
}

/**
 * One wizard action, carrying its `Args` (handler body / call args) and `Result` (call return) types.
 * The handler is a NATIVE action handler (`function* (body)`) — no injected ctx; it uses
 * `useDatabase()` itself. `kind` / `target` / `returns` / `watch` / `rest` drive routing, reactivity,
 * and Docs metadata. Prefer the typed aliases {@link Query} / {@link Mutation} / {@link Command} /
 * {@link StreamDef}, produced by the `query`/`mutation`/`action`/`stream` builders.
 */
export interface WizardActionDef<Args = AnyType, Result = AnyType> {
  readonly kind: FnKind
  readonly target?: string | undefined
  readonly args?: ArgsSpec | undefined
  readonly returns?: ZodType | undefined
  readonly emits?: ZodType | undefined
  readonly reactive?: ReactiveMode | undefined
  readonly access?: AccessGuard | undefined
  readonly watch?: WatchSpec | undefined
  readonly rest?: RestOverride | undefined
  readonly upload?: UploadOptions | undefined
  readonly handler: (body: AnyType) => Operation<AnyType>
  /** Phantom carriers (never present at runtime) so the call-args + result types travel with the def:
   * `Args` is the call input, `Result` the call return. */
  readonly [ARGS]?: Args
  readonly [RESULT]?: Result
}

/** A read action. `install`ed on a resource, `metrics.actions.total` becomes `Action<[Args], Result>`. */
export interface Query<Args = AnyType, Result = AnyType> extends WizardActionDef<Args, Result> {
  readonly kind: 'query'
}
/** A write action. */
export interface Mutation<Args = AnyType, Result = AnyType> extends WizardActionDef<Args, Result> {
  readonly kind: 'mutation'
}
/** A non-reactive RPC action (the `action` builder). */
export interface Command<Args = AnyType, Result = AnyType> extends WizardActionDef<Args, Result> {
  readonly kind: 'action'
}
/** A producer-driven realtime action (the `stream` builder). */
export interface StreamDef<Args = AnyType, Result = AnyType> extends WizardActionDef<Args, Result> {
  readonly kind: 'stream'
}

/** Project a wizard action def to the core {@link Action} the Broker calls — so `Broker.call` infers
 * the args tuple and the return type instead of falling back to `any`. A `never` arg (no `args`
 * validator) maps to an empty call-args tuple, so the action is called with no argument. */
export type ToAction<Def> =
  Def extends WizardActionDef<infer Args, infer Result>
    ? Action<[Args] extends [never] ? [] : [Args], Result>
    : Action

/** A namespace of functions (a resource's crud + its custom ops). */
export type FnModule = Record<string, WizardActionDef>

/** Transport for a resource's own realtime channel (`/<ns>/_realtime`). */
export type RealtimeTransport = 'websocket' | 'sse'

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
  /** Transport for the collection's realtime channel (`/<ns>/_realtime`). Defaults to `'websocket'`. */
  readonly realtime?: RealtimeTransport | undefined
  /** Mount the collection under a parent path carrying path params, e.g. `'/apps/:appId'` (nested). */
  readonly parent?: string | undefined
}
