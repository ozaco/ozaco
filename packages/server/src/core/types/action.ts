import type { Operation } from 'std:effect'

import type { ACTION } from '../const'

import type { Declaration, Params, Returns, WireManifest } from './channel'

/**
 * Augmented by policy implementations so `defineAction({ policies })` is fully typed:
 *
 * ```ts
 * declare module 'server:core' {
 *   interface PolicyOptionsMap { cache: CacheOverride }
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-object-type
export interface PolicyOptionsMap {}

/** Per-action policy overrides — `false` disables the policy for this action. */
export type PolicyOverrides = {
  readonly [K in keyof PolicyOptionsMap]?: PolicyOptionsMap[K] | false
} & Record<string, object | boolean | undefined>

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/** The function taxonomy the wizard/docs layers speak (Convex-flavored). */
export type ActionKind = 'query' | 'mutation' | 'action' | 'stream'

/** A typed edge route claim (replaces the old opaque settings bag). */
export interface Route {
  readonly method: HttpMethod
  readonly path: string
  /** Serve the (stream) result as Server-Sent Events. */
  readonly sse?: boolean | undefined
}

/** What happens to a running handler when the caller disconnects or abandons the call. */
export type DisconnectMode = 'cancel' | 'detach'

export interface ActionConfig<
  TInput extends Declaration | undefined = Declaration | undefined,
  TOutput extends Declaration | undefined = Declaration | undefined,
> {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly input?: TInput
  readonly output?: TOutput
  readonly route?: Route | undefined
  /** Wizard/docs taxonomy — drives manifest `kind` and client codegen. */
  readonly kind?: ActionKind | undefined
  readonly policies?: PolicyOverrides | undefined
  /** Default `cancel`: abort on caller abandon. `detach`: finish the work, record the outcome. */
  readonly onDisconnect?: DisconnectMode | undefined
  /** Always persist this action's outcome (otherwise only undeliverable/opted-in calls are). */
  readonly outcome?: boolean | undefined
  /** Failure tag → HTTP status overrides; also feeds the docs manifest error catalog. */
  readonly errors?: Record<string, number> | undefined
  readonly docs?: { readonly tags?: readonly string[] } | undefined
}

/** Everything the kernel, carriers, policies and docs read about an action — typed, no sniffing. */
export interface ActionMeta {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly input?: Declaration | undefined
  readonly output?: Declaration | undefined
  readonly wire: WireManifest
  readonly route?: Route | undefined
  readonly kind?: ActionKind | undefined
  readonly policies: PolicyOverrides
  readonly onDisconnect: DisconnectMode
  readonly outcome: boolean
  readonly errors: Record<string, number>
  readonly docs?: { readonly tags?: readonly string[] } | undefined
}

export type ActionHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
) => Operation<TResult>

/**
 * A callable action: invoking it runs input validation → handler → output validation. Produced by
 * `defineAction`; owned by exactly one `Service`.
 */
export interface Action<TParams = unknown, TResult = unknown> {
  (params: TParams): Operation<TResult>
  readonly _t: typeof ACTION
  readonly meta: ActionMeta
}

/** Infers the concrete `Action` type from a config's declarations. */
export type ActionFrom<C extends ActionConfig> = Action<Params<C['input']>, Returns<C['output']>>
