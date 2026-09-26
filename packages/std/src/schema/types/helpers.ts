import type { AnyType, StandardSchemaV1 } from 'std:shared'

/** Helper shapes of the schema module: `MatchCase` is one recorded case of a `match()` builder. */
export namespace Helpers {
  /** One case a `match()` builder recorded: a schema OR a predicate, with its handler. */
  export interface MatchCase {
    handler: (value: AnyType) => AnyType
    predicate?: ((value: AnyType) => boolean) | undefined
    schema?: StandardSchemaV1 | undefined
  }
}
