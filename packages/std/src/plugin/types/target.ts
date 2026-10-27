import type { Operation } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

/**
 * A TARGET is an implementation of a cloneable protocol that is CONFIGURED before it is used: an
 * external provider (a carrier, an AI vendor, a CRM account) whose config and secrets come from a
 * row an operator fills in, and whose far side has to answer before it counts as connected.
 * `Protocol.target(...)` builds one: the lifecycle (`connect` / `isConnected` / `disconnect`) and
 * the "is it bound?" guard are the runtime's, the provider writes only its probe and its domain
 * actions — each of which receives the parsed binding as its first argument.
 */
export namespace Target {
  /** What a target is told before it can be called. */
  export interface Bound<C = unknown, S = unknown> {
    readonly config: C
    readonly secrets: S
  }

  /** Whether the far side answers, and its own words about why not. */
  export interface Health {
    readonly ok: boolean
    readonly note: string
  }

  /** The three actions every target carries; a target's contract extends this. */
  export interface Lifecycle {
    /** Validate `bound` against the schemas, probe the far side, remember the outcome: a schema
     * rejection answers `configuration incomplete`, a failing probe answers its reason, and only
     * an `ok` answer binds. */
    connect(bound: Bound): Operation<Health>
    /** What the last `connect` established — no socket is opened. */
    isConnected(): Operation<Health>
    /** Forget the binding; `release` runs first. */
    disconnect(): Operation<void>
  }

  /** What the probe and every domain action receive: the parsed binding and the target's state. */
  export interface Held<C, S, TState> extends Bound<C, S> {
    readonly state: TState
  }

  /** The target's context: the binding (`null` until a `connect` succeeded), its health, its
   * state (built once at install, kept across connects). */
  export interface Context<C, S, TState> {
    bound: Bound<C, S> | null
    health: Health
    readonly state: TState
  }

  /** The domain half of a contract: every action but the lifecycle, with `held` prepended. */
  export type Actions<TActions, C, S, TState> = {
    [K in keyof TActions as K extends keyof Lifecycle ? never : K]: TActions[K] extends (
      ...args: infer A
    ) => infer R
      ? (held: Held<C, S, TState>, ...args: A) => R
      : never
  }

  export interface Options<
    TActions,
    CSchema extends StandardSchemaV1,
    SSchema extends StandardSchemaV1,
    TState,
  > {
    name: string
    version: string
    description?: string | undefined
    /** The public configuration's schema (any Standard Schema: zod, valibot, arktype, …). */
    config: CSchema
    /** The credentials' schema. */
    secrets: SSchema
    /** Extra state the target keeps across connects (sessions, caches); built once at install. */
    state?: (() => TState) | undefined
    /** Reach the far side with the parsed binding and answer the health — or fail: the failure's
     * reason (its message, else its first cause) becomes the note. */
    probe(
      held: Held<
        StandardSchemaV1.InferOutput<CSchema>,
        StandardSchemaV1.InferOutput<SSchema>,
        TState
      >,
    ): Operation<Health>
    /** Clean the state up on `disconnect` (dispose sessions, clear caches). */
    release?: ((state: TState) => Operation<void>) | undefined
    actions: Actions<
      TActions,
      StandardSchemaV1.InferOutput<CSchema>,
      StandardSchemaV1.InferOutput<SSchema>,
      TState
    >
  }
}
