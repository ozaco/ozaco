import type { PolicyDef } from 'server:core'
import type { Helpers } from 'std:effect'
import type { Result } from 'std:result'

export const BucketPolicyKey = 'bucket' as const

export namespace Bucket {
  export interface Options extends PolicyDef.Options {
    interval?: number
    max?: number
  }

  // the shared dispatch outcome, carried as a resolved value (never a rejection) so that each
  // joiner re-throws a failure inside ITS OWN coroutine — and thus through its own outer policies
  export type Outcome =
    | { ok: true; value: unknown }
    | { ok: false; failure: Result.Failure<unknown> }

  export interface Entry {
    count: number
    resolvers: Helpers.WithResolvers<Outcome>
    timer?: ReturnType<typeof setTimeout>
  }

  export interface Context extends PolicyDef.Context {
    interval: number
    max: number
    entries: Map<string, Entry>
  }
}
