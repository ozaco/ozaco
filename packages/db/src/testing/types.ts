import type { Operation } from 'std:effect'

/** The shapes of `@ozaco/db/testing`. */
export namespace Testing {
  /** One database+driver binding under the conformance suite. */
  export interface AdapterTarget {
    /** Must equal the adapter's `info.adapter` name. */
    readonly label: string

    /** false → the whole suite is skipped (e.g. no live server configured). */
    readonly enabled: boolean

    /** Whether the adapter declares the `raw` capability (and speaks SQL through it — the raw
     * tests issue SQL statements). */
    readonly raw: boolean

    /** Install a FRESH backend into the current scope. */
    readonly use: () => Operation<unknown>
  }
}
