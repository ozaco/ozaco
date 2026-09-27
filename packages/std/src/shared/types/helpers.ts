import type { TAG_MATCHERS } from '../const'

import type { KebabToPascal } from './string'

/** Helper shapes of the shared module: `FlatEntry` is the return type of `flattenEntries`; the
 * `Tag*` shapes build the `Tags` type of `createTags`. */
export namespace Helpers {
  /** A flattened leaf: its dotted key path and the value found there. */
  export interface FlatEntry {
    key: string
    value: unknown
  }

  /** A parsed version (build metadata dropped) — `prerelease` holds the dot-separated identifiers. */
  export interface Version {
    major: number
    minor: number
    patch: number
    prerelease: string[]
  }

  /** One semver comparator of a range: whether a parsed version passes it. */
  export type Comparator = (version: Version) => boolean

  /** A `createTags` entry's kebab name (a bare name, or the first of a `[name, matcher]` pair). */
  export type TagName<E> = E extends string
    ? E
    : E extends readonly [infer N extends string, unknown]
      ? N
      : never

  /** The name of a `createTags` entry given a matcher (`never` for a bare name). */
  export type MatchedName<E> = E extends readonly [infer N extends string, unknown] ? N : never

  /** A kebab name as its dotted tag under `prefix` (itself without one). */
  export type Tagged<T extends string | null, K extends string> = T extends null ? K : `${T}.${K}`

  /**
   * How a foreign value (a thrown JS / platform / third-party error) is recognized as a tag:
   * `code` / `name` compare the value's own `code` / `name` field against one value or any of a
   * list (both given: both must match); a function decides by itself — `true` is a match, a
   * non-empty string a match whose message it is.
   */
  export type TagMatcher =
    | {
        readonly code?: string | number | readonly (string | number)[]
        readonly name?: string | readonly string[]
      }
    | ((value: unknown) => boolean | string)

  /** One `createTags` entry: a kebab-case name, or a name and the matcher that recognizes it. */
  export type TagEntry = string | readonly [name: string, matcher: TagMatcher]

  /** A bundle's matchers — `[tag, matcher]` pairs, first match wins (see `asFailure`). */
  export interface TagMatchers<K extends string = string> {
    readonly [TAG_MATCHERS]: readonly (readonly [tag: K, matcher: TagMatcher])[]
  }

  export type Tags<T extends string | null, U extends readonly TagEntry[]> = {
    readonly [K in Helpers.TagName<U[number]> as KebabToPascal<K>]: Helpers.Tagged<T, K>
  } & TagMatchers<Helpers.Tagged<T, Helpers.MatchedName<U[number]>>>

  /** The tags a bundle can fold a foreign value into (its entries given a matcher). */
  export type MatchedTag<M> = M extends TagMatchers<infer K> ? K : never
}
