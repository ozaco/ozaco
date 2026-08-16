import type { Operation } from 'std:effect'

import type { Reply, Request } from './common'
import type { Trace } from './trace'

/**
 * What every policy layer sees per dispatch. `key` is the coalescing/caching identity
 * (`service\0action\0params-json`); `overrides` come from the action's typed `policies` field.
 */
export interface PolicyDispatch {
  readonly key: string
  readonly principal?: string | undefined
  readonly streaming: boolean
  readonly trace: Trace
  readonly request: Request
  readonly overrides: Readonly<Record<string, object | boolean | undefined>>
}

export type PolicyNext = () => Operation<Reply>

export type PolicyApply = (ctx: PolicyDispatch, next: PolicyNext) => Operation<Reply>

/** One registered policy layer (lowest priority = outermost). */
export interface PolicyEntry {
  readonly name: string
  readonly priority: number
  /** Skip this layer for streaming dispatches unless the action opts in. */
  readonly skipStreaming: boolean
  readonly apply: PolicyApply
}

export interface PolicyHandlers {
  dispatchRoot(ctx: PolicyDispatch, terminal: PolicyNext): Operation<Reply>
  register(entry: PolicyEntry): Operation<void>
  unregister(name: string): Operation<void>
  getPolicies(): Operation<readonly PolicyEntry[]>
}

/** Config for the `definePolicy` factory. */
export interface PolicySpec<TOptions, TState> {
  readonly name: string
  readonly version?: string | undefined
  readonly priority: number
  readonly skipStreaming?: boolean | undefined
  readonly setup: (options: TOptions) => Operation<TState>
  readonly apply: (input: {
    readonly ctx: PolicyDispatch
    readonly state: TState
    /** The action-level override value for this policy (`undefined` when none). */
    readonly override: object | boolean | undefined
    readonly next: PolicyNext
  }) => Operation<Reply>
  readonly teardown?: ((state: TState) => Operation<void>) | undefined
}
