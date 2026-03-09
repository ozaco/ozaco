import type { AnyType, StandardSchemaV1 } from 'std:shared'

export type MatchCase = {
  handler: (value: AnyType) => AnyType
  predicate?: (value: AnyType) => boolean
  schema?: StandardSchemaV1
}
