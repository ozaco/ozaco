import type { AnyType } from './common'
import type { StandardSchemaV1 } from './schema'

/** Helper shapes of the shared module: `FlatEntry` is the return type of `flattenEntries`,
 * `MatchCase` one recorded case of a `match()` builder. */
export namespace Helpers {
  /** A flattened leaf: its dotted key path and the value found there. */
  export interface FlatEntry {
    key: string
    value: unknown
  }

  /** One case a `match()` builder recorded: a schema OR a predicate, with its handler. */
  export interface MatchCase {
    handler: (value: AnyType) => AnyType
    predicate?: ((value: AnyType) => boolean) | undefined
    schema?: StandardSchemaV1 | undefined
  }

  /** A parsed version (build metadata dropped) — `prerelease` holds the dot-separated identifiers. */
  export interface Version {
    major: number
    minor: number
    patch: number
    prerelease: string[]
  }
}
