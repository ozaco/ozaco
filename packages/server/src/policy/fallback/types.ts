import type { PolicyDispatch, Wire } from 'server:core'
import type { Operation } from 'std:effect'

declare module 'server:core' {
  interface PolicyOptionsMap {
    fallback: FallbackOverride
  }
}

/**
 * Install-time options for the fallback policy. When both `value` and `handler` are given the
 * handler wins; with neither, matched failures fall back to `undefined`.
 */
export interface FallbackOptions {
  /** The static fallback value served in place of a matched failure. */
  readonly value?: unknown
  /** Computes the fallback value from the dispatch and the failure that triggered it. */
  readonly handler?:
    | ((ctx: PolicyDispatch, failure: Wire.Failure) => Operation<unknown>)
    | undefined
  /** Which failures fall back (default: all of them). */
  readonly when?: ((failure: Wire.Failure) => boolean) | undefined
}

/** Per-action override (`policies: { fallback: { … } | false }`) — same shape as the options. */
export type FallbackOverride = FallbackOptions
