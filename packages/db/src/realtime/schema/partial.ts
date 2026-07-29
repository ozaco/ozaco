import type { AnyType } from 'std:shared'

import { z } from 'zod'

/** Unwrap `.default()`/`.prefault()` from a field, reaching through optional/nullable wrappers (the
 * wrappers themselves are rebuilt, so `z.string().default('x').nullable()` stays nullable). */
const stripDefault = (schema: z.ZodType): z.ZodType => {
  const def = (schema as AnyType).def
  if (def?.type === 'default' || def?.type === 'prefault') {
    return stripDefault(def.innerType as z.ZodType)
  }
  if (def?.type === 'optional') {
    return z.optional(stripDefault(def.innerType as z.ZodType))
  }
  if (def?.type === 'nullable') {
    return z.nullable(stripDefault(def.innerType as z.ZodType))
  }
  return schema
}

const memo = new WeakMap<z.ZodObject<z.ZodRawShape>, z.ZodObject<z.ZodRawShape>>()

/**
 * A table validator's TRUE partial — `.partial()` alone is not one: zod keeps each field's
 * `.default()` alive, so parsing a patch that omits a defaulted column INJECTS that default into the
 * output, and a partial update built from it silently resets every defaulted column it never
 * mentioned. Stripping defaults before `.partial()` makes absent keys stay absent; keys that ARE
 * present still validate against the field's own type.
 */
export const partialValidator = (
  validator: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> => {
  const hit = memo.get(validator)
  if (hit) {
    return hit
  }
  const built = z
    .object(
      Object.fromEntries(
        Object.entries(validator.shape).map(([name, field]) => [
          name,
          stripDefault(field as z.ZodType),
        ]),
      ),
    )
    .partial() as z.ZodObject<z.ZodRawShape>
  memo.set(validator, built)
  return built
}
