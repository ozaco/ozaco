import type { StandardSchemaV1 } from 'std:shared'

import type { Schema } from './schema'
import type { Spec } from './spec'

/** The types of the public helpers (`column.*`, …) that are not a module's own protocol. */
export namespace Utils {
  /** A `where.*` leaf's field: a field name, or a path into a `json` column
   * (`['payload', 'workspace']`). */
  export type FieldRef<TField extends string> = TField | Spec.FieldPath<TField>

  export interface TimestampOptions {
    /** `'date'` (default) reads back a `Date`; `'ms'` keeps epoch millis as a `number`. */
    readonly as?: 'date' | 'ms' | undefined
  }

  /** `column.timestamp` — the value type follows `as`. */
  export interface Timestamp {
    (options?: { readonly as?: 'date' | undefined }): Schema.Column<Date, false, false>
    (options: { readonly as: 'ms' }): Schema.Column<number, false, false>
  }

  /** `column.json` — `json<T>()` only TYPES the stored value; `json(schema)` (any Standard
   * Schema: zod, valibot, …) types it from the schema AND validates every write through it,
   * storing what the schema parsed. */
  export interface Json {
    <TValue = unknown>(): Schema.Column<TValue, false, false>
    <TSchema extends StandardSchemaV1>(
      schema: TSchema,
    ): Schema.Column<StandardSchemaV1.InferOutput<TSchema>, false, false>
  }
}
