import type { Action } from 'server:core'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { z, ZodType } from 'zod'

import type { ARGS, RESULT } from '../const'

import type { AccessGuard } from './access'
import type { UploadOptions } from './upload'

/** Handler-body type — the zod OUTPUT (defaults applied), i.e. the parsed args the handler receives. */
type ArgsBody<A> = A extends ZodType ? z.output<A> : Record<string, never>

export type FnKind = 'query' | 'mutation' | 'action' | 'stream'

/** Call-argument type for an action with args validator `A` — the zod INPUT (fields with a `.default`
 * are optional), i.e. what a caller passes to `Broker.call`. `never` when the action has no args (its
 * call then takes no argument — see {@link ToAction}). */
export type ArgsOf<A> = A extends ZodType ? z.input<A> : never

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

/** The tables a query reactively depends on: `'*'` (re-run on any write) or an explicit list.
 * Defaults to the action's `target` table. */
export type WatchSpec = '*' | readonly string[]

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
