import type { Reply } from 'server:core'
import type { Singleflight } from 'server:utils'

declare module 'server:core' {
  interface PolicyOptionsMap {
    bucket: BucketOverride
  }
}

/** Install-time options for the bucket (single-flight) policy. */
export interface BucketOptions {
  /** Coalescing identity: `principal` isolates flights per caller, `none` shares them (default `principal`). */
  readonly vary?: 'principal' | 'none' | undefined
}

/** Per-action override (`policies: { bucket: { … } | false }`). */
export interface BucketOverride {
  readonly vary?: 'principal' | 'none' | undefined
}

/** Scope-bound state: the keyed single-flight plus the resolved vary mode. */
export interface BucketState {
  readonly flight: Singleflight<Reply>
  readonly vary: 'principal' | 'none'
}
