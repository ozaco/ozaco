// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

import type { ServerDef } from './server'

/**
 * The action OPTIONS every first-party plugin owns. The shapes live here — in core, next to the
 * action config that carries them — while the behaviour lives in the plugin; that way an option
 * is a typed field on `action.query({ … })` for package consumers too (a `declare module`
 * augmentation shipped from a plugin's `.d.ts` never reaches them).
 *
 * A third-party plugin adds its own key by augmenting {@link OptionsDef.ActionOptions}:
 *
 *   declare module '@ozaco/server' {
 *     namespace OptionsDef {
 *       interface ActionOptions { audit?: { level: 'info' | 'warn' } | undefined }
 *     }
 *   }
 *
 * Runtime validation stays the plugin's: it declares a zod schema per key in its
 * `PluginContext.options`, and `createServer` refuses an option nobody claims.
 */
export namespace OptionsDef {
  // --- auth ---------------------------------------------------------------------------------

  export type TokenType = 'access' | 'refresh' | 'session' | 'service'

  /** A verified caller, as `ctx.auth` sees it. */
  export interface Principal {
    readonly sub: string
    readonly type: TokenType
    readonly roles: readonly string[]
    readonly permissions: readonly string[]
    readonly claims: Record<string, unknown>
    readonly jti: string
  }

  /** The `auth` option: who may call. `'authenticated'` = any verified principal; an array =
   * required ROLES; the object form requires roles AND/OR permissions; a predicate sees the
   * full principal and decides itself; `false` opens the action up. */
  export type Requirement =
    | 'user'
    | 'service'
    | 'authenticated'
    | readonly string[]
    | {
        readonly roles?: readonly string[] | undefined
        readonly permissions?: readonly string[] | undefined
      }
    | ((principal: Principal) => boolean)
    | false

  // --- cache --------------------------------------------------------------------------------

  export interface Cache {
    readonly ttlMs: number

    /** what the key varies on besides the whole input: dotted paths into `input` / `auth` /
     * `headers` (e.g. `'auth.sub'`, `'headers.accept-language'`). Default: the whole input. */
    readonly vary?: readonly string[] | undefined

    /** tags the entry carries (`invalidate` drops them; a db table name is invalidated
     * automatically when that table changes). */
    readonly tags?: readonly string[] | undefined
  }

  // --- resilience ---------------------------------------------------------------------------

  export interface Retry {
    /** how many times to retry after the first failure. */
    readonly times: number

    /** which failure tags retry. Default: `server.timeout-unreached`, `server.unavailable`. */
    readonly when?: readonly string[] | undefined

    /** first backoff delay; doubles each retry. Default 100. */
    readonly delayMs?: number | undefined
  }

  export interface Breaker {
    /** consecutive failures that open the circuit. */
    readonly failures: number

    /** how long the circuit stays open before one trial call. Default 10 000. */
    readonly halfOpenMs?: number | undefined
  }

  export interface Bulkhead {
    /** concurrent calls allowed. */
    readonly max: number

    /** calls that may wait for a slot. Default 0. */
    readonly queue?: number | undefined
  }

  export interface RateLimit {
    /** calls per window. */
    readonly limit: number
    readonly windowMs: number

    /** what the limit is keyed on. Default `'global'`. */
    readonly key?: 'global' | 'ip' | 'auth' | undefined
  }

  export type Fallback = (
    failure: Result.Failure<unknown>,
    call: ServerDef.Call,
    ctx: ServerDef.Ctx,
  ) => Operation<unknown>

  // --- the config surface -------------------------------------------------------------------

  /** Every option key an action may carry. Augment to add your own. */
  export interface ActionOptions {
    /** who may call (the `Auth` plugin). */
    readonly auth?: Requirement | undefined

    /** cache the reply (the `Cache` plugin; value outputs only). */
    readonly cache?: Cache | undefined

    /** tags this action drops once it succeeds (the `Cache` plugin). */
    readonly invalidate?: readonly string[] | undefined

    /** per-call deadline (the `Resilience` plugin). */
    readonly timeoutMs?: number | undefined
    readonly retry?: Retry | undefined
    readonly breaker?: Breaker | undefined
    readonly bulkhead?: Bulkhead | undefined

    /** coalesce identical in-flight calls (same action, same input) into one. */
    readonly singleflight?: boolean | undefined
    readonly rateLimit?: RateLimit | undefined

    /** answers instead of the failure when every other layer gave up. */
    readonly fallback?: Fallback | undefined
  }
}
