import { z } from 'zod'

import type { Id } from './types'

/** Registry linking an `id()` column's zod schema instance to the table it references. A WeakMap
 * keeps it out of the zod value + survives structural cloning of the surrounding object. */
const REFS = new WeakMap<z.ZodType, string>()

/** Strip optional / nullable wrappers to reach the underlying zod type. */
const coreType = (schema: z.ZodType): z.ZodType => {
  let current = schema
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap() as z.ZodType
  }
  return current
}

/** Declare a foreign-key column pointing at another table. Runtime value is a string; the inferred
 * type is a branded {@link Id}. */
export const id = <const TTable extends string>(table: TTable): z.ZodType<Id<TTable>> => {
  const schema = z.string()
  REFS.set(schema, table)
  return schema as unknown as z.ZodType<Id<TTable>>
}

/** Read the referenced table for a column schema (unwrapping optional/nullable), or null. */
export const referenceOf = (schema: z.ZodType): string | null => REFS.get(coreType(schema)) ?? null

/** Whether the (unwrapped) column schema is a `z.date()`. */
export const isDate = (schema: z.ZodType): boolean => coreType(schema) instanceof z.ZodDate
